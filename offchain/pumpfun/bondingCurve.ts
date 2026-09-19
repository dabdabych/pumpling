// src/pumpfun/bondingCurve.ts
// Checking whether a bonding curve is active

import { Keypair, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { createProvider } from "../solana/connection";
import { getBondingCurveAddress, PUMP_PROGRAM_ID } from "../solana/config";
import { PUMPFUN_IDL } from "./idl";

// =============================================================================
// TYPES
// =============================================================================

interface BondingCurveState {
    complete: boolean;
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Checks whether a token's bonding curve is active
 *
 * @param mint - the token address
 * @param buyer - a keypair for creating the Anchor provider
 * @returns true if the bonding curve exists and is NOT complete (the token trades on pump.fun)
 *          false if it does not exist or is complete (graduated, or not a pump.fun token)
 */
export async function isBondingCurveActive(
    mint: PublicKey,
    buyer: Keypair
): Promise<boolean> {
    const provider = createProvider(buyer);
    const program = new Program(PUMPFUN_IDL as any, PUMP_PROGRAM_ID, provider);

    const bondingCurveAddress = getBondingCurveAddress(mint);

    try {
        const state = (await program.account.bondingCurve.fetch(
            bondingCurveAddress
        )) as BondingCurveState;
        return !state.complete;
    } catch {
        // The account does not exist — the token has either graduated or was never on pump.fun
        return false;
    }
}
