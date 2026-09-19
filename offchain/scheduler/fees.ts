// scheduler/fees.ts
// Working out N, the fees and how the amounts are split

// =============================================================================
// CONSTANTS
// =============================================================================

/** The cost of creating an ATA, in SOL */
export const ATA_FEE_SOL = 0.00204;

/** The base transaction fee, in SOL */
export const TX_BASE_FEE_SOL = 0.000005;

/**
 * The priority fee per transaction in SOL, for delivery and refunds.
 *
 * These transactions overtake nobody: all we want is not to sit waiting for a
 * block. It matches the `delivery`/`refund` ceiling in `solana/priorityFee.ts`,
 * and that is no coincidence: the reserve must cover what we actually pay.
 */
export const TX_PRIORITY_FEE_SOL = 0.000005;

/** The total transaction fee (base + priority) */
export const TX_FEE_SOL = TX_BASE_FEE_SOL + TX_PRIORITY_FEE_SOL;

/**
 * The purchase priority, a ceiling in SOL per transaction.
 *
 * Buying is the only place where the queue is real. Measured on mainnet on
 * 2026-09-19: on the pump.fun curve people pay around 158,000 lamports per
 * transaction, on PumpSwap around 900, on Jupiter around 2,800. We are not in
 * the snipers' race, but without priority we would not get into a block at all
 * during a busy hour, so we hold a ceiling of 0.0001 SOL — the same one that
 * sits in `MAX_PRIORITY_LAMPORTS` on the budget instructions themselves.
 *
 * We reserve at the ceiling rather than the expected price: too little reserve
 * means the last purchases of a round fail with "insufficient funds", while too
 * much simply goes back to participants with the rest of the unspent SOL.
 */
export const BUY_PRIORITY_FEE_SOL = 0.0001;

/** The full fee for one purchase: network plus queue. */
export const BUY_TX_FEE_SOL = TX_BASE_FEE_SOL + BUY_PRIORITY_FEE_SOL;

// =============================================================================
// CALCULATE N
// =============================================================================

/**
 * Works out the best number of purchases N, on a smoothed formula.
 *
 * The logic:
 * - up to 0.1 SOL: 1 purchase (the minimum)
 * - 0.1-1 SOL: 2-10 purchases (about 0.1 SOL each)
 * - 1-5 SOL: 10-20 purchases
 * - 5-50 SOL: 20-100 purchases
 * - 50+ SOL: 100 purchases (the maximum)
 *
 * @param totalSol - the total amount of SOL
 * @returns the number of purchases N
 *
 * @example
 * calculateN(0.05) // 1
 * calculateN(0.5)  // 5
 * calculateN(1.0)  // 10
 * calculateN(5.0)  // 20
 * calculateN(50)   // 100
 */
export function calculateN(totalSol: number): number {
    if (totalSol <= 0) {
        return 0;
    }

    if (totalSol <= 0.1) {
        return 1;
    }

    if (totalSol <= 1) {
        // 2-10 purchases: linear interpolation
        // 0.1 → 2, 1.0 → 10
        return Math.max(2, Math.floor(totalSol / 0.1));
    }

    if (totalSol <= 5) {
        // 10-20 purchases: gentle growth
        // 1 → 10, 5 → 20
        return Math.floor(10 + (totalSol - 1) * 2.5);
    }

    if (totalSol <= 50) {
        // 20-100 purchases: slower growth
        // 5 → 20, 50 → 100
        return Math.floor(20 + (totalSol - 5) * (80 / 45));
    }

    // 100 purchases at most
    return 100;
}

// =============================================================================
// CALCULATE FEES
// =============================================================================

export interface FeeBreakdown {
    /** The ATA fee (0 when it already exists) */
    ataFee: number;
    /** Total transaction fees (N * TX_FEE * 2 for the retry buffer) */
    txFees: number;
    /** Total fees */
    totalFees: number;
    /** The net amount available for buying */
    netAmount: number;
}

/**
 * Works out the fees and the net amount for buying.
 *
 * @param totalSol - the total amount of SOL
 * @param n - the number of purchases
 * @param hasAta - whether the keeper already has an ATA
 * @returns the fee breakdown
 *
 * @example
 * calculateFees(1, 10, false)
 * // { ataFee: 0.00204, txFees: 0.0002, totalFees: 0.00224, netAmount: 0.99776 }
 */
export function calculateFees(
    totalSol: number,
    n: number,
    hasAta: boolean
): FeeBreakdown {
    const ataFee = hasAta ? 0 : ATA_FEE_SOL;

    // Reserve for retries: N * fee * 2, in case attempts have to be repeated.
    // The purchase fee includes priority: without it a transaction does not make
    // it into a block during a busy hour, and it is paid out of the round's
    // money, not ours.
    const txFees = n * BUY_TX_FEE_SOL * 2;

    const totalFees = ataFee + txFees;
    const netAmount = Math.max(0, totalSol - totalFees);

    return {
        ataFee,
        txFees,
        totalFees,
        netAmount,
    };
}

// =============================================================================
// SPLIT AMOUNT
// =============================================================================

/**
 * Splits an amount between N purchases with a little randomisation.
 *
 * Randomisation: every purchase gets the base amount ± 10%
 * Guaranteed: the purchases add up to netAmount
 *
 * @param netAmount - the net amount (after fees)
 * @param n - the number of purchases
 * @returns an array of amounts, one per purchase
 *
 * @example
 * splitAmount(1.0, 5)
 * // [0.19, 0.21, 0.20, 0.18, 0.22] (roughly, adding up to 1.0)
 */
export function splitAmount(netAmount: number, n: number): number[] {
    if (n <= 0 || netAmount <= 0) {
        return [];
    }

    if (n === 1) {
        return [netAmount];
    }

    const baseAmount = netAmount / n;
    const variance = 0.1; // 10% variation

    // Generate the random multipliers
    const multipliers: number[] = [];
    for (let i = 0; i < n; i++) {
        // Random between (1 - variance) and (1 + variance)
        const mult = 1 - variance + Math.random() * variance * 2;
        multipliers.push(mult);
    }

    // Work out the preliminary amounts
    const rawAmounts = multipliers.map((m) => baseAmount * m);
    const rawTotal = rawAmounts.reduce((sum, a) => sum + a, 0);

    // Normalise so the total is exactly netAmount
    const amounts = rawAmounts.map((a) => (a / rawTotal) * netAmount);

    // Round to 9 decimals, adjusting the last element to the exact total
    const rounded: number[] = [];
    let sum = 0;
    for (let i = 0; i < amounts.length; i++) {
        if (i === amounts.length - 1) {
            const last = Math.round((netAmount - sum) * 1e9) / 1e9;
            rounded.push(last);
        } else {
            const value = Math.round(amounts[i] * 1e9) / 1e9;
            rounded.push(value);
            sum += value;
        }
    }

    return rounded;
}
