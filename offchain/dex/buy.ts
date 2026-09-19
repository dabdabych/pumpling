// src/dex/buy.ts
// Buying tokens through the Jupiter DEX aggregator

import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { connection, sendTxLimiter } from "../solana/connection";
import { getSignedTransactionSignature, PostSendError } from "../solana/transaction";
import {
    JUPITER_QUOTE_URL,
    JUPITER_SWAP_URL,
    PRIORITIZATION_FEE_LAMPORTS,
    JUPITER_MAX_ACCOUNTS,
    JUPITER_ONLY_DIRECT_ROUTES,
} from "../solana/config";
import { logger as rootLogger, Logger } from "../logger";
import { estimatePrice, priceFor, priorityLamports } from "../solana/priorityFee";

// =============================================================================
// CONSTANTS
// =============================================================================

const SOL_MINT = "So11111111111111111111111111111111111111112";
const FETCH_TIMEOUT_MS = 30_000;

// =============================================================================
// NO-ROUTE ERROR
// =============================================================================

/**
 * Jupiter cannot route to the token (no liquidity in its routing set, or
 * TOKEN_NOT_TRADABLE). Guaranteed pre-send — the tx has not been sent yet, so
 * falling back to the PumpSwap pool directly is safe (no double-buy risk).
 */
export class NoRouteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NoRouteError";
    }
}

const JUPITER_NO_ROUTE_ERROR_CODES = new Set([
    "NO_ROUTES_FOUND",
    "COULD_NOT_FIND_ANY_ROUTE",
    "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT",
    "TOKEN_NOT_TRADABLE",
    "MARKET_NOT_FOUND",
]);

function collectJupiterErrorFields(body: string): string[] {
    const fields = [body];
    try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            for (const key of ["error", "errorCode", "message", "code"]) {
                const value = record[key];
                if (typeof value === "string") {
                    fields.push(value);
                }
            }
        }
    } catch {
        // Non-JSON Jupiter bodies are matched by text below.
    }
    return fields;
}

export function isJupiterNoRouteErrorBody(body: string): boolean {
    const fields = collectJupiterErrorFields(body);
    const upperFields = fields.map((field) => field.toUpperCase());

    for (const code of JUPITER_NO_ROUTE_ERROR_CODES) {
        if (upperFields.some((field) => field.includes(code))) {
            return true;
        }
    }

    return upperFields.some((field) =>
        field.includes("NO ROUTE")
        || field.includes("NO ROUTES")
        || field.includes("COULD NOT FIND ANY ROUTE")
        || field.includes("TOKEN_NOT_TRADABLE")
        || field.includes("NOT TRADABLE")
        || field.includes("MARKET NOT FOUND")
        || field.includes("ROUTE PLAN DOES NOT CONSUME")
    );
}

// =============================================================================
// TYPES
// =============================================================================

interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    priceImpactPct: string;
    routePlan: unknown[];
}

interface JupiterSwapResponse {
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports: number;
}

interface SwapTransactionResult {
    transaction: VersionedTransaction;
    lastValidBlockHeight: number;
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * fetch with a timeout, through AbortController
 * Exported for testing
 */
export async function fetchWithTimeout(
    url: string | URL,
    options: RequestInit = {},
    timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url.toString(), {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Gets a quote from Jupiter
 *
 * @param outputMint - the address of the token to buy
 * @param lamports - the amount in lamports (SOL * 1e9)
 * @param slippageBps - slippage in basis points
 */
async function getQuote(
    outputMint: PublicKey,
    lamports: number,
    slippageBps: number
): Promise<JupiterQuoteResponse> {
    const url = new URL(JUPITER_QUOTE_URL);
    url.searchParams.set("inputMint", SOL_MINT);
    url.searchParams.set("outputMint", outputMint.toString());
    url.searchParams.set("amount", String(lamports));
    url.searchParams.set("slippageBps", String(slippageBps));
    url.searchParams.set("restrictIntermediateTokens", "true");
    url.searchParams.set("maxAccounts", String(JUPITER_MAX_ACCOUNTS));

    if (JUPITER_ONLY_DIRECT_ROUTES) {
        url.searchParams.set("onlyDirectRoutes", "true");
    }

    const response = await fetchWithTimeout(url);

    if (!response.ok) {
        const text = await response.text();
        // Jupiter routing errors are pre-send: no swap tx was built, so a
        // direct PumpSwap fallback cannot double-buy.
        if (isJupiterNoRouteErrorBody(text)) {
            throw new NoRouteError(`Jupiter has no route for ${outputMint.toString()}: ${text}`);
        }
        throw new Error(`Jupiter quote failed: ${response.status} ${text}`);
    }

    const quote = (await response.json()) as JupiterQuoteResponse;

    if (!quote.routePlan || quote.routePlan.length === 0) {
        throw new NoRouteError(
            `No route found for ${outputMint.toString()} - no liquidity or invalid token`
        );
    }

    return quote;
}

/**
 * Builds a swap transaction through Jupiter
 */
/**
 * What we give Jupiter for queue position, in lamports per transaction.
 *
 * The price comes from the network for our own wallet and is converted to
 * lamports through the compute usage, which for Jupiter is measured from our
 * own history (median 137,018, max 210,497 — we count at the upper bound). The
 * ceiling is the same as for the other purchases; we never go below the old
 * fixed payment.
 */
async function jupiterPriorityLamports(userPublicKey: PublicKey): Promise<number> {
    const units = 210_000;
    const estimate = await estimatePrice([userPublicKey]);
    const price = priceFor("dex", units, estimate);
    return Math.max(PRIORITIZATION_FEE_LAMPORTS, priorityLamports(units, price));
}

async function buildSwapTransaction(
    quote: JupiterQuoteResponse,
    userPublicKey: PublicKey
): Promise<SwapTransactionResult> {
    // Jupiter assembles the transaction and adds the budget instructions
    // itself, so all we do is say how much we are willing to pay for queue
    // position. There used to be a hard five thousand lamports here: an
    // overpayment in a quiet hour, and missing the block in a storm.
    const priority = await jupiterPriorityLamports(userPublicKey);
    const response = await fetchWithTimeout(JUPITER_SWAP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: userPublicKey.toString(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: priority,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Jupiter swap build failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as JupiterSwapResponse;

    if (!data.swapTransaction) {
        throw new Error("Jupiter swap response missing swapTransaction");
    }

    const txBuffer = Buffer.from(data.swapTransaction, "base64");
    return {
        transaction: VersionedTransaction.deserialize(txBuffer),
        lastValidBlockHeight: data.lastValidBlockHeight,
    };
}

/**
 * Buys a token through the Jupiter DEX aggregator
 *
 * Used for:
 * - graduated tokens (after the pump.fun bonding curve)
 * - tokens on Raydium, Orca and other DEXes
 * - any token that is NOT on a bonding curve
 *
 * @param mint - the address of the token to buy
 * @param solAmount - how much SOL to spend
 * @param keeper - the wallet keypair
 * @param slippageBps - slippage in basis points (500 = 5%)
 * @returns transaction signature
 */
export async function buyDex(
    mint: PublicKey,
    solAmount: number,
    keeper: Keypair,
    slippageBps: number,
    log?: Logger
): Promise<string> {
    const l = log || rootLogger;
    const lamports = Math.floor(solAmount * 1_000_000_000);

    if (!Number.isFinite(lamports) || lamports <= 0) {
        throw new Error(`Invalid solAmount: ${solAmount}`);
    }

    // 1. Get the quote
    let quote: JupiterQuoteResponse;
    try {
        quote = await getQuote(mint, lamports, slippageBps);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("No route found")) {
            l.warn({ event: "dex.no_route", mint: mint.toBase58() }, msg);
        } else if (msg.includes("timeout") || msg.includes("AbortError")) {
            l.warn({ event: "dex.timeout", mint: mint.toBase58() }, msg);
        } else {
            l.error({ event: "dex.quote_failed", mint: mint.toBase58(), error: msg }, "Jupiter quote failed");
        }
        throw error;
    }

    // 2. Build the transaction
    let transaction: VersionedTransaction;
    let lastValidBlockHeight: number;
    try {
        const result = await buildSwapTransaction(quote, keeper.publicKey);
        transaction = result.transaction;
        lastValidBlockHeight = result.lastValidBlockHeight;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        l.error({ event: "dex.swap_build_failed", mint: mint.toBase58(), error: msg }, "Jupiter swap build failed");
        throw error;
    }

    // 3. Sign. We take our place in the send queue before signing: the
    //    blockhash in a transaction Jupiter assembled lives about a minute.
    await sendTxLimiter.acquire();
    transaction.sign([keeper]);

    // 4. Pre-send simulation. If this fails, tx is not in the network and retry/fallback is safe.
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err) {
        l.error({ event: "dex.simulation_failed", mint: mint.toBase58(), err: simulation.value.err },
            "DEX transaction simulation failed");
        throw new Error(
            `DEX simulation failed: ${JSON.stringify(simulation.value.err)}`
        );
    }

    // 5. Post-send stage: signature is known before send, so scheduler can
    // check it before any retry and avoid double-buy.
    const signature = getSignedTransactionSignature(transaction);
    try {
        const sentSignature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: true,
            maxRetries: 3,
        });

        const blockhash = transaction.message.recentBlockhash;
        const confirmation = await connection.confirmTransaction(
            {
                signature: sentSignature,
                blockhash,
                lastValidBlockHeight,
            },
            "confirmed"
        );

        if (confirmation.value.err) {
            l.error({ event: "dex.on_chain_failure", mint: mint.toBase58(), signature: sentSignature, err: confirmation.value.err },
                "DEX transaction failed on-chain");
            throw new Error(
                `Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)}`
            );
        }

        l.info({ event: "dex.completed", mint: mint.toBase58(), signature: sentSignature.slice(0, 16) },
            "DEX buy completed");
        return sentSignature;
    } catch (error) {
        if (error instanceof PostSendError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        l.error({ event: "dex.send_failed", mint: mint.toBase58(), signature, error: msg },
            "DEX transaction send/confirm failed");
        throw new PostSendError(`DEX transaction send/confirm failed: ${msg}`, signature, error);
    }
}
