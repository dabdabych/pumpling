// src/buy.ts
// The main purchase function

import { Keypair, PublicKey } from "@solana/web3.js";
import { isBondingCurveActive } from "./pumpfun/bondingCurve";
import { buyPumpfun, PostSendError } from "./pumpfun/buy";
import { buyDex, NoRouteError } from "./dex/buy";
import { buyPumpswap } from "./pumpswap/buy";
import { logger as rootLogger, Logger } from "./logger";
import { isSlippageError } from "./scheduler/errors";
import { tagVenue } from "./solana/transaction";

// =============================================================================
// TYPES
// =============================================================================

export type BuyVenue = "pumpfun" | "dex" | "pumpswap";

export interface BuyResult {
    signature: string;
    venue: BuyVenue;
    /** true when pumpfun failed pre-send and we switched to the DEX */
    fallback?: boolean;
}

/**
 * Buys a graduated token through Jupiter, or, when Jupiter cannot find a route
 * (NoRouteError, pre-send), straight from the PumpSwap pool.
 */
async function buyGraduated(
    mint: PublicKey,
    solAmount: number,
    keeper: Keypair,
    slippageBps: number,
    l: Logger
): Promise<BuyResult> {
    try {
        const signature = await buyDex(mint, solAmount, keeper, slippageBps, l);
        return { signature, venue: "dex" };
    } catch (dexError) {
        if (!(dexError instanceof NoRouteError)) {
            // Labelled here rather than in dex/buy.ts: the venue is known for
            // certain and no throw path can be missed.
            throw tagVenue(dexError, "dex");
        }
        // Jupiter will not route the token — try the PumpSwap pool directly (guaranteed pre-send)
        l.warn({ event: "buy.fallback.dex_to_pumpswap", mint: mint.toBase58(), reason: dexError.message },
            "Jupiter has no route, switching to direct PumpSwap pool");
        try {
            const signature = await buyPumpswap(mint, solAmount, keeper, slippageBps, l);
            return { signature, venue: "pumpswap", fallback: true };
        } catch (pumpswapError) {
            throw tagVenue(pumpswapError, "pumpswap");
        }
    }
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/** The default slippage in basis points (500 = 5%) */
const DEFAULT_SLIPPAGE_BPS = 500;

/**
 * The main purchase function.
 *
 * Works out where to buy on its own:
 * - bonding curve active → pump.fun (straight onto the curve)
 * - otherwise → the Jupiter DEX aggregator (graduated tokens, Raydium, Orca, …)
 *
 * @param mint - the token address
 * @param solAmount - how much SOL to spend
 * @param keeper - the keypair we buy from
 * @param slippageBps - slippage in basis points (500 = 5%)
 * @returns the transaction signature and the venue
 */
export async function buy(
    mint: PublicKey,
    solAmount: number,
    keeper: Keypair,
    slippageBps: number = DEFAULT_SLIPPAGE_BPS,
    log?: Logger
): Promise<BuyResult> {
    const l = log || rootLogger;
    const isActive = await isBondingCurveActive(mint, keeper);

    if (isActive) {
        try {
            const signature = await buyPumpfun(mint, solAmount, keeper, slippageBps, l);
            return { signature, venue: "pumpfun" };
        } catch (rawPumpfunError) {
            const pumpfunError = tagVenue(rawPumpfunError, "pumpfun");
            // Post-send: the tx may have gone out — no fallback (double-buy risk)
            if (pumpfunError instanceof PostSendError) {
                throw pumpfunError;
            }
            // Slippage is no reason to change venue. The curve is alive, the
            // price simply moved; the cure is a retry with a wider tolerance,
            // and the 300 -> 500 -> 900 ladder in the scheduler exists for
            // exactly that. Going to the DEX here made it worthless: the error
            // was swallowed and never reached the scheduler. Worse, a token on
            // the curve may have no DEX route at all, and the purchase failed
            // outright.
            if (isSlippageError(pumpfunError)) {
                throw pumpfunError;
            }
            // Pre-send: fetch/build failed before the tx went out — a DEX fallback is safe
            const msg = pumpfunError instanceof Error ? pumpfunError.message : String(pumpfunError);
            l.warn({ event: "buy.fallback.pumpfun_to_dex", mint: mint.toBase58(), reason: msg },
                "Pumpfun pre-send failed, switching to DEX");
            return { ...(await buyGraduated(mint, solAmount, keeper, slippageBps, l)), fallback: true };
        }
    } else {
        return buyGraduated(mint, solAmount, keeper, slippageBps, l);
    }
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { buyPumpfun } from "./pumpfun/buy";
export { buyDex } from "./dex/buy";
export { buyPumpswap } from "./pumpswap/buy";
export { isBondingCurveActive } from "./pumpfun/bondingCurve";
