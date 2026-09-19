// src/solana/priorityFee.ts
// Priority fee: how much to pay for a place in the block, and how much compute
// to ask for.

import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";

import { connection } from "./connection";
import { logger } from "../logger";

/**
 * Why this exists.
 *
 * A validator picks transactions for a block by their price per compute unit.
 * Without a priority fee a transaction can fail to make it into a block at all
 * during a busy hour. Until 2026-09-19 the buyer paid for queue position only
 * on Jupiter, and even there a flat five thousand lamports: purchases on the
 * curve, purchases on PumpSwap, token delivery and SOL refunds all went out
 * with no priority whatsoever.
 *
 * The numbers below are not invented, they were measured on mainnet on 2026-09-19.
 *
 * Compute usage comes from our own keeper's history, which is exactly the
 * shapes of transaction the buyer builds:
 *
 *   purchase on the pump.fun curve   median  78,587, max  91,079
 *   purchase on PumpSwap             median 119,757, max 136,845
 *   purchase through Jupiter         median 137,018, max 210,497
 *   token delivery                   median   1,594, max 116,620
 *   SOL transfer (refund)            median     150, max   3,000 (20 transfers)
 *
 * The queue price comes from the last forty transactions of each program across the whole network:
 *
 *   pump.fun    median 526,315 microlamports per unit (≈158,000 lamports)
 *   PumpSwap    median   3,000 (≈900 lamports)
 *   Jupiter     median  13,394 (≈2,800 lamports)
 *
 * The curve is expensive because snipers compete there for the first slot
 * after a coin launches. The buyer is not in that race: it buys for an hour in
 * small portions and can retry. So we take the price from the network but cap
 * it with our own ceiling in lamports per transaction.
 *
 * On the economics. Priority is paid out of the round's money, not ours: the
 * fee reserve is subtracted from the buying amount (`scheduler/fees.ts`), and
 * whatever is not spent goes back to participants along with the rest of the
 * unspent SOL. A ceiling of 0.0001 SOL per purchase is 0.05 SOL over a round of
 * five hundred purchases, under five hundredths of a percent of a 111 SOL pool.
 */

export type FeePath = "pumpfun" | "pumpswap" | "dex" | "delivery" | "refund";

/** The priority ceiling in lamports for a single transaction. */
export const MAX_PRIORITY_LAMPORTS: Record<FeePath, number> = {
    // Purchases: the queue is real here and getting into the block matters.
    pumpfun: envInt("PRIORITY_MAX_LAMPORTS_BUY", 100_000),
    pumpswap: envInt("PRIORITY_MAX_LAMPORTS_BUY", 100_000),
    dex: envInt("PRIORITY_MAX_LAMPORTS_BUY", 100_000),
    // Delivery and refunds overtake nobody: a token payment is enough for them,
    // and exactly that much is reserved for them in the fee calculation.
    delivery: envInt("PRIORITY_MAX_LAMPORTS_DELIVERY", 5_000),
    refund: envInt("PRIORITY_MAX_LAMPORTS_DELIVERY", 5_000),
};

/**
 * The compute limit. Asking for headroom cannot go on forever: priority is
 * charged on the REQUESTED limit, not what was used, so generosity here costs
 * money. We take our measured maximum plus half.
 */
export const COMPUTE_UNITS: Record<Exclude<FeePath, "dex" | "delivery" | "refund">, number> = {
    pumpfun: 140_000,
    pumpswap: 200_000,
};

/** Delivery: every recipient gets their own transfer and possibly an ATA creation. */
export function deliveryComputeUnits(recipients: number): number {
    return Math.min(200_000, 15_000 + 30_000 * Math.max(1, recipients));
}

/** Refunds: SOL transfers are cheap, but there are up to eight per transaction. */
export function refundComputeUnits(transfers: number): number {
    return Math.min(20_000, 1_000 + 400 * Math.max(1, transfers));
}

/** Below this price paying is pointless. */
const MIN_PRICE_MICRO_LAMPORTS = 1_000;
/** How long an estimate from the network lives. */
const ESTIMATE_TTL_MS = 60_000;

const cache = new Map<string, { at: number; value: number | null }>();

/**
 * What the people touching the same accounts are paying right now.
 *
 * Asking with no accounts is pointless: the network returns the minimum across
 * all of them, and that is almost always zero (measured 2026-09-19: 150
 * samples, all zeros). The queue price lives at a particular hot account — the
 * curve, the pool, our own wallet.
 */
export async function estimatePrice(accounts: PublicKey[]): Promise<number | null> {
    const key = accounts.map((account) => account.toBase58()).sort().join(",");
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.at < ESTIMATE_TTL_MS) {
        return cached.value;
    }

    let value: number | null = null;
    try {
        const samples = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts });
        const fees = samples
            .map((sample) => Number(sample.prioritizationFee))
            .filter((fee) => Number.isFinite(fee) && fee > 0)
            .sort((a, b) => a - b);
        if (fees.length > 0) {
            const middle = Math.floor(fees.length / 2);
            value = Math.round(
                fees.length % 2 === 0 ? (fees[middle - 1] + fees[middle]) / 2 : fees[middle]
            );
        }
    } catch (error) {
        // The node did not answer or the method is closed: pay the lower bound,
        // but send the transaction anyway.
        logger.warn({ event: "priority.estimate_failed", error: String(error) }, "Priority fee estimate failed");
        value = null;
    }

    cache.set(key, { at: now, value });
    return value;
}

/**
 * The share of a purchase above which we will not pay for queue position.
 *
 * The lamport ceiling is one for all purchases, but purchases differ: a coin
 * with a small share gets a purchase of a hundredth of a SOL, and paying the
 * same queue price for it as for half a SOL is wrong. A percentage of the
 * amount protects against the case where the fee is comparable to the purchase.
 */
const MAX_SHARE_OF_PURCHASE = 0.01;

/** The priority ceiling for a particular transaction, in lamports. */
export function capLamports(path: FeePath, solAmount?: number): number {
    const base = MAX_PRIORITY_LAMPORTS[path];
    if (!solAmount || !Number.isFinite(solAmount) || solAmount <= 0) {
        return base;
    }
    return Math.min(base, Math.floor(solAmount * MAX_SHARE_OF_PURCHASE * 1_000_000_000));
}

/** The price per unit, given the lamport ceiling for the transaction. */
export function priceFor(
    path: FeePath,
    units: number,
    estimate: number | null,
    solAmount?: number
): number {
    const ceiling = Math.floor((capLamports(path, solAmount) * 1_000_000) / Math.max(1, units));
    const base = estimate && estimate > 0 ? estimate : MIN_PRICE_MICRO_LAMPORTS;
    // The lower bound matters more than the ceiling: a price of zero means a
    // transaction with no priority at all, which is exactly what we are fixing.
    return Math.max(MIN_PRICE_MICRO_LAMPORTS, Math.min(base, Math.max(1, ceiling)));
}

/** What the priority will cost, in lamports. */
export function priorityLamports(units: number, microLamportsPerUnit: number): number {
    return Math.ceil((units * microLamportsPerUnit) / 1_000_000);
}

/**
 * The budget instructions for a transaction.
 *
 * `accounts` are the ones the transaction writes: that is what the network
 * prices queue position from. `solAmount` is the purchase amount, when this is
 * a purchase: the ceiling depends on it, so queue position never costs as much
 * as the purchase itself.
 */
export async function budgetInstructions(
    path: FeePath,
    units: number,
    accounts: PublicKey[],
    solAmount?: number
): Promise<TransactionInstruction[]> {
    const estimate = await estimatePrice(accounts);
    const microLamports = priceFor(path, units, estimate, solAmount);
    return [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ];
}

/** Whether the instruction set already carries a budget: the network rejects duplicates. */
export function hasBudgetInstruction(
    instructions: TransactionInstruction[],
    kind: "limit" | "price"
): boolean {
    const marker = kind === "limit" ? 2 : 3;
    return instructions.some(
        (instruction) =>
            instruction.programId.equals(ComputeBudgetProgram.programId) &&
            instruction.data.length > 0 &&
            instruction.data[0] === marker
    );
}

function envInt(name: string, fallback: number): number {
    const raw = parseInt(process.env[name] || "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
