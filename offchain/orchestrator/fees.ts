// orchestrator/fees.ts
// Send reserve calculation and buy budget distribution

import { ATA_FEE_SOL, TX_FEE_SOL } from "../scheduler/fees";
import { TokenEntry } from "./types";

// =============================================================================
// SEND RESERVE
// =============================================================================

/**
 * Works out the SOL reserve for the send phase.
 * Every delivery needs an ATA fee plus a tx fee (the ATA is idempotent, but we reserve anyway).
 *
 * @param sends - sendN for each recipient
 * @returns the total SOL reserve
 */
export function calculateSendReserve(
    sends: Array<{ sendN: number; hasAta: boolean }>
): number {
    let total = 0;
    for (const s of sends) {
        total += s.sendN * TX_FEE_SOL + (s.hasAta ? 0 : ATA_FEE_SOL);
    }
    return total;
}

// =============================================================================
// BUY BUDGET DISTRIBUTION
// =============================================================================

/**
 * Splits buyBudget proportionally between the coins.
 *
 * @param tokens - the input coins with their totalSol
 * @param buyBudget - the total budget for buying
 * @returns the adjusted SOL amounts, one per coin
 */
export function distributeBuyBudget(
    tokens: TokenEntry[],
    buyBudget: number
): number[] {
    if (tokens.length === 0) return [];

    const totalRequested = tokens.reduce((s, t) => s + t.totalSol, 0);
    if (totalRequested <= 0) return tokens.map(() => 0);

    const amounts: number[] = [];
    let sum = 0;

    for (let i = 0; i < tokens.length; i++) {
        if (i === tokens.length - 1) {
            // The last one takes the remainder
            amounts.push(Math.round((buyBudget - sum) * 1e9) / 1e9);
        } else {
            const share = (tokens[i].totalSol / totalRequested) * buyBudget;
            const rounded = Math.round(share * 1e9) / 1e9;
            amounts.push(rounded);
            sum += rounded;
        }
    }

    return amounts;
}
