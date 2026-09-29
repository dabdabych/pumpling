// solana/debits.ts
// What a transaction actually did to the keeper, read from the chain.

/**
 * Why this exists.
 *
 * The buyer plans a purchase of N SOL and records N. What leaves the wallet is
 * N plus the network fee, plus the priority fee, plus the rent of any account
 * the transaction had to create. Those extras are small and they are real:
 * measured on round 1790348400190 (2026-09-25, 29 purchases) they came to
 * 0.00213 SOL, of which 0.00151 was the keeper's token account for the coin
 * and the rest fees between 5,140 and 105,000 lamports a transaction.
 *
 * Anything computed from the plan is therefore an under-statement of what was
 * spent, and the refund is computed from exactly that: allocated minus spent.
 * So we ask the chain what it took: `preBalances[i] - postBalances[i]` for the
 * keeper is the whole answer in one number — the amount swapped, the fee, the
 * priority and the rent, net of anything that came back.
 *
 * The same read gives the other half: how many tokens the transaction put on
 * the keeper, from `pre/postTokenBalances`. That is what a purchase really
 * bought, and it is what the burn is worked out from — never from the keeper's
 * token balance, which can come back stale from a node that has not caught up
 * with our own last transaction (seen on 2026-09-28 right after a delivery).
 *
 * **Why raw JSON-RPC and not `connection.getTransactions`.** Version 1
 * transactions are active on mainnet, devnet and testnet (solana.com/docs,
 * "Versioned transactions": "Passing 0 fails on v1 transactions exactly like
 * omitting the parameter"). A node asked with `maxSupportedTransactionVersion:
 * 0` refuses a v1 transaction outright, and web3.js 1.x, which we use, can only
 * decode legacy and v0 messages. We need nothing from the message but the
 * account keys, which `jsonParsed` hands over as plain strings for every
 * version, so we read the JSON ourselves and ask for version 1.
 */

import { PublicKey } from "@solana/web3.js";

import { RPC_ENDPOINT } from "./config";
import { Logger, logger as rootLogger } from "../logger";

/**
 * How many signatures go into one request, and the pause between requests.
 *
 * Helius takes up to 100 `getTransaction` items in a batch (docs, "Rate
 * limits", 2026-09-29) but does not say whether they count as one request
 * against the plan's requests per second or as a hundred. Assuming the worse:
 * ten items and a quarter of a second between batches keeps these reads under
 * about forty a second, leaving room for the purchases running beside them on
 * a 50 RPS plan. The refund phase reads every signature of a round, a thousand
 * in the worst case, so this is where a burst would have come from.
 */
export const DEBIT_BATCH_SIZE = 10;
export const DEBIT_BATCH_PAUSE_MS = 250;
/** A batch the provider refused (a 429, a blink) is asked once more after this. */
export const DEBIT_RETRY_AFTER_MS = 1_500;

/**
 * A signature's outcome for the SOL side.
 *
 *  - a number: this is what the keeper paid, to the lamport. Zero means the
 *    transaction is not on chain at all, so it cost nothing — a blockhash that
 *    expired before the transaction landed.
 *  - null: we could not find out. The caller falls back to an estimate.
 */
export type Debit = number | null;

/** Everything one transaction did to the keeper. */
export interface KeeperEffect {
    /** The node had the transaction. */
    found: boolean;
    /** Lamports the keeper lost, as SOL. Zero when not found. */
    debitSol: number;
    /** Raw token units the keeper gained (negative: lost), by mint. */
    tokenDeltas: Map<string, bigint>;
    /** The transaction ran and failed on chain: its fee was paid, nothing else happened. */
    failedOnChain: boolean;
}

/** Posts one JSON-RPC batch. Swapped out in tests. */
export type RpcBatch = (body: unknown[]) => Promise<unknown[]>;

export interface DebitDeps {
    rpcBatch?: RpcBatch;
    logger?: Logger;
    /** Smaller batches, for a provider that caps them. */
    batchSize?: number;
    /** Overrides for tests: the pause between batches and before a retry. */
    pauseMs?: number;
    retryAfterMs?: number;
}

const wait = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const defaultRpcBatch: RpcBatch = async (body) => {
    const response = await fetch(RPC_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        // The URL carries the provider key: it never goes into an error.
        throw new Error(`RPC batch failed with HTTP ${response.status}`);
    }
    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
        throw new Error("RPC batch answer is not an array");
    }
    return parsed;
};

/**
 * What each of these transactions did to the keeper.
 *
 * A signature missing from the result could not be read at all (the request
 * failed); the caller treats it as unknown. Never throws: an accounting read
 * must not be able to stop a round.
 */
export async function readKeeperEffects(
    signatures: string[],
    keeper: PublicKey,
    deps: DebitDeps = {}
): Promise<Map<string, KeeperEffect>> {
    const rpcBatch = deps.rpcBatch ?? defaultRpcBatch;
    const log = deps.logger ?? rootLogger;
    const size = Math.max(1, deps.batchSize ?? DEBIT_BATCH_SIZE);
    const result = new Map<string, KeeperEffect>();
    const keeperKey = keeper.toBase58();

    const pause = deps.pauseMs ?? DEBIT_BATCH_PAUSE_MS;
    const retryAfter = deps.retryAfterMs ?? DEBIT_RETRY_AFTER_MS;

    const unique = [...new Set(signatures.filter((signature) => !!signature))];
    for (let index = 0; index < unique.length; index += size) {
        if (index > 0) {
            await wait(pause);
        }
        const chunk = unique.slice(index, index + size);
        const body = chunk.map((signature, id) => ({
            jsonrpc: "2.0",
            id,
            method: "getTransaction",
            params: [
                signature,
                { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
            ],
        }));
        let answers: unknown[];
        try {
            try {
                answers = await rpcBatch(body);
            } catch {
                await wait(retryAfter);
                answers = await rpcBatch(body);
            }
        } catch (error) {
            log.warn(
                {
                    event: "debits.read_failed",
                    count: chunk.length,
                    error: error instanceof Error ? error.message : String(error),
                },
                `Could not read ${chunk.length} transactions`
            );
            continue;
        }
        const byId = new Map<number, Record<string, unknown>>();
        for (const answer of answers) {
            if (answer && typeof answer === "object" && typeof (answer as { id?: unknown }).id === "number") {
                byId.set((answer as { id: number }).id, answer as Record<string, unknown>);
            }
        }
        chunk.forEach((signature, id) => {
            const answer = byId.get(id);
            // An error for this row, or no row: unknown, and left out.
            if (!answer || answer.error) {
                return;
            }
            const effect = effectFrom(answer.result, keeperKey);
            if (effect) {
                result.set(signature, effect);
            }
        });
    }

    return result;
}

/**
 * The SOL side only, in the shape the refund accounting was written against:
 * a number when known (zero when the transaction never landed), null when not.
 */
export async function readKeeperDebits(
    signatures: string[],
    keeper: PublicKey,
    deps: DebitDeps = {}
): Promise<Map<string, Debit>> {
    const effects = await readKeeperEffects(signatures, keeper, deps);
    const result = new Map<string, Debit>();
    for (const signature of new Set(signatures.filter((s) => !!s))) {
        const effect = effects.get(signature);
        result.set(signature, effect ? effect.debitSol : null);
    }
    return result;
}

/** One `getTransaction` result, reduced to what it did to the keeper. */
export function effectFrom(raw: unknown, keeperKey: string): KeeperEffect | null {
    // The node answered and has no such transaction: it never landed.
    if (raw === null) {
        return { found: false, debitSol: 0, tokenDeltas: new Map(), failedOnChain: false };
    }
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const tx = raw as {
        meta?: {
            err?: unknown;
            preBalances?: unknown;
            postBalances?: unknown;
            preTokenBalances?: unknown;
            postTokenBalances?: unknown;
        } | null;
        transaction?: { message?: { accountKeys?: unknown } };
    };
    const meta = tx.meta;
    if (!meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) {
        return null;
    }

    // `jsonParsed` gives the keys as objects ({ pubkey, signer, writable, source })
    // in the same order as the balances, lookup-table accounts included.
    const keys = Array.isArray(tx.transaction?.message?.accountKeys)
        ? (tx.transaction!.message!.accountKeys as unknown[]).map((key) =>
            typeof key === "string" ? key : (key as { pubkey?: unknown })?.pubkey
        )
        : [];
    // The keeper pays the fee on every path, and the fee payer is always first.
    const found = keys.indexOf(keeperKey);
    const at = found >= 0 ? found : 0;
    const before = meta.preBalances[at];
    const after = meta.postBalances[at];
    if (typeof before !== "number" || typeof after !== "number") {
        return null;
    }

    return {
        found: true,
        debitSol: (before - after) / 1_000_000_000,
        tokenDeltas: tokenDeltasFor(meta.preTokenBalances, meta.postTokenBalances, keeperKey),
        failedOnChain: meta.err !== null && meta.err !== undefined,
    };
}

/** post − pre for every mint the keeper holds in this transaction. */
function tokenDeltasFor(pre: unknown, post: unknown, keeperKey: string): Map<string, bigint> {
    const deltas = new Map<string, bigint>();
    const add = (rows: unknown, sign: bigint) => {
        if (!Array.isArray(rows)) {
            return;
        }
        for (const row of rows) {
            const entry = row as { owner?: unknown; mint?: unknown; uiTokenAmount?: { amount?: unknown } };
            if (entry.owner !== keeperKey || typeof entry.mint !== "string") {
                continue;
            }
            const amount = entry.uiTokenAmount?.amount;
            if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
                continue;
            }
            deltas.set(entry.mint, (deltas.get(entry.mint) ?? 0n) + sign * BigInt(amount));
        }
    };
    // A token account that did not exist before the transaction has no "pre"
    // row at all, which is the same as zero.
    add(pre, -1n);
    add(post, 1n);
    return deltas;
}
