// src/pumpfun/graduation.ts
// Checking a token's bonding curve / graduation status

import { Keypair, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { createProvider } from "../solana/connection";
import { PUMP_PROGRAM_ID, getBondingCurveAddress } from "../solana/config";
import { PUMPFUN_IDL } from "./idl";
import { isBondingCurveActive } from "./bondingCurve";

// =============================================================================
// TYPES
// =============================================================================

export interface BondingCurveState {
    virtualTokenReserves: bigint;
    virtualSolReserves: bigint;
    realTokenReserves: bigint;
    realSolReserves: bigint;
    tokenTotalSupply: bigint;
    complete: boolean;
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Reads the full bonding curve state through Anchor
 *
 * Used when every field is needed (reserves, supply and so on).
 * For a simple liveness check use isBondingCurveActive()
 */
export async function getBondingCurveState(
    mint: PublicKey
): Promise<BondingCurveState> {
    // A dummy keypair: reading data needs no real wallet
    const dummyKeypair = Keypair.generate();
    const provider = createProvider(dummyKeypair);
    const program = new Program(PUMPFUN_IDL as any, PUMP_PROGRAM_ID, provider);

    const bondingCurveAddress = getBondingCurveAddress(mint);
    const state = (await program.account.bondingCurve.fetch(
        bondingCurveAddress
    )) as {
        virtualTokenReserves: { toString(): string };
        virtualSolReserves: { toString(): string };
        realTokenReserves: { toString(): string };
        realSolReserves: { toString(): string };
        tokenTotalSupply: { toString(): string };
        complete: boolean;
    };

    return {
        virtualTokenReserves: BigInt(state.virtualTokenReserves.toString()),
        virtualSolReserves: BigInt(state.virtualSolReserves.toString()),
        realTokenReserves: BigInt(state.realTokenReserves.toString()),
        realSolReserves: BigInt(state.realSolReserves.toString()),
        tokenTotalSupply: BigInt(state.tokenTotalSupply.toString()),
        complete: state.complete,
    };
}

/**
 * @deprecated Use isBondingCurveActive() instead of this function.
 *
 * checkGraduation returns true if the token has "graduated" (complete=true).
 * But that does not account for tokens that were never on pump.fun.
 *
 * isBondingCurveActive is more correct:
 * - true  → the token is on a bonding curve → buy through pump.fun
 * - false → the token is NOT on a bonding curve → buy through a DEX
 */
export async function checkGraduation(mint: PublicKey): Promise<boolean> {
    // Invert the result of isBondingCurveActive
    // isBondingCurveActive=true means NOT graduated
    // isBondingCurveActive=false means graduated OR not a pump.fun token
    const dummyKeypair = Keypair.generate();
    const isActive = await isBondingCurveActive(mint, dummyKeypair);
    return !isActive;
}

// Re-exported for convenience
export { isBondingCurveActive } from "./bondingCurve";
