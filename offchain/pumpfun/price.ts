// src/pumpfun/price.ts
// Helpers for reading a token's price

import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import { createProvider } from "../solana/connection";
import { PUMP_PROGRAM_ID, getBondingCurveAddress } from "../solana/config";
import { PUMPFUN_IDL } from "./idl";

export interface TokenPriceInfo {
    pricePerToken: number;        // SOL per 1 token
    virtualSolReserves: number;   // SOL in bonding curve
    virtualTokenReserves: number; // Tokens in bonding curve
    isGraduated: boolean;
}

/**
 * Reads a token's price information from the bonding curve
 */
export async function getTokenPrice(mint: PublicKey): Promise<TokenPriceInfo> {
    const bondingCurve = getBondingCurveAddress(mint);

    // A dummy keypair is needed to create the provider (reading only)
    const dummyKeypair = Keypair.generate();
    const provider = createProvider(dummyKeypair);
    const program = new Program(PUMPFUN_IDL as any, PUMP_PROGRAM_ID, provider);

    const state = await program.account.bondingCurve.fetch(bondingCurve) as {
        virtualTokenReserves: BN;
        virtualSolReserves: BN;
        complete: boolean;
    };

    const TOKEN_DECIMALS = 6;
    const virtualSol = state.virtualSolReserves.toNumber() / LAMPORTS_PER_SOL;
    const virtualTokens = state.virtualTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS);

    return {
        pricePerToken: virtualSol / virtualTokens,
        virtualSolReserves: virtualSol,
        virtualTokenReserves: virtualTokens,
        isGraduated: state.complete,
    };
}

/**
 * The pump.fun fee ceiling, not a fixed rate.
 *
 * The real rate moves with market cap — live mainnet transactions showed 0, 95
 * and 125 bps. We take the worst case here, so the estimate is on the low side:
 * it is a lower bound on how many tokens will arrive.
 */
const MAX_PUMP_FEE_BPS = 125;

/**
 * Estimates how many tokens N SOL buys.
 *
 * For reference and reports only. It takes no part in the real buying path:
 * there `buy_exact_sol_in` works the fee out on chain itself, and slippage
 * protection goes through `min_tokens_out` in `calculateBuyParams`.
 */
export function estimateTokensOut(priceInfo: TokenPriceInfo, solAmount: number): number {
    const curveIn = (solAmount * 10000) / (10000 + MAX_PUMP_FEE_BPS);
    // AMM formula: dy = y * dx / (x + dx)
    return priceInfo.virtualTokenReserves * curveIn / (priceInfo.virtualSolReserves + curveIn);
}
