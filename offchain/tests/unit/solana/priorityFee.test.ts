// tests/unit/solana/priorityFee.test.ts
// Paying for a place in the block: the ceilings, the network estimate and the reserve for it.

import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";

const mockGetRecentPrioritizationFees = jest.fn();

jest.mock("../../../solana/connection", () => ({
    connection: {
        getRecentPrioritizationFees: (...args: unknown[]) => mockGetRecentPrioritizationFees(...args),
    },
    sendTxLimiter: { acquire: jest.fn() },
}));

import {
    MAX_PRIORITY_LAMPORTS,
    COMPUTE_UNITS,
    budgetInstructions,
    deliveryComputeUnits,
    estimatePrice,
    hasBudgetInstruction,
    priceFor,
    priorityLamports,
    refundComputeUnits,
} from "../../../solana/priorityFee";
import { BUY_PRIORITY_FEE_SOL, TX_PRIORITY_FEE_SOL } from "../../../scheduler/fees";

const LAMPORTS_PER_SOL = 1_000_000_000;
const account = new PublicKey("EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ");

describe("the priority fee", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetRecentPrioritizationFees.mockResolvedValue([]);
    });

    describe("the ceiling", () => {
        it("no network price ever breaks the lamport ceiling", () => {
            // The network can ask whatever it likes: we pay no more than our own.
            for (const estimate of [0, 1, 500_000, 5_000_000, 1_000_000_000]) {
                for (const [path, units] of [
                    ["pumpfun", COMPUTE_UNITS.pumpfun],
                    ["pumpswap", COMPUTE_UNITS.pumpswap],
                    ["delivery", deliveryComputeUnits(5)],
                    ["refund", refundComputeUnits(8)],
                ] as const) {
                    const price = priceFor(path, units, estimate);
                    const lamports = priorityLamports(units, price);
                    expect(lamports).toBeLessThanOrEqual(MAX_PRIORITY_LAMPORTS[path] + 1);
                }
            }
        });

        it("with no answer from the network we pay the lower bound, not zero", () => {
            const price = priceFor("pumpfun", COMPUTE_UNITS.pumpfun, null);
            expect(price).toBeGreaterThan(0);
            expect(priorityLamports(COMPUTE_UNITS.pumpfun, price)).toBeGreaterThan(0);
        });

        it("a cheap network does not raise the price for nothing", () => {
            const cheap = priceFor("pumpswap", COMPUTE_UNITS.pumpswap, 3_000);
            const expensive = priceFor("pumpswap", COMPUTE_UNITS.pumpswap, 300_000);
            expect(cheap).toBeLessThan(expensive);
        });
    });

    describe("economics: the reserve covers what we pay", () => {
        it("the purchase reserve is not below the purchase ceiling", () => {
            // Too little reserve means the last purchases of a round fail with
            // "insufficient funds" — and that is other people's money.
            expect(BUY_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL).toBeGreaterThanOrEqual(
                MAX_PRIORITY_LAMPORTS.pumpfun
            );
            expect(BUY_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL).toBeGreaterThanOrEqual(
                MAX_PRIORITY_LAMPORTS.pumpswap
            );
            expect(BUY_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL).toBeGreaterThanOrEqual(
                MAX_PRIORITY_LAMPORTS.dex
            );
        });

        it("the delivery and refund reserve is not below their ceiling", () => {
            expect(TX_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL).toBeGreaterThanOrEqual(
                MAX_PRIORITY_LAMPORTS.delivery
            );
            expect(TX_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL).toBeGreaterThanOrEqual(
                MAX_PRIORITY_LAMPORTS.refund
            );
        });

        it("queue position never costs as much as the purchase", () => {
            // On a small purchase the lamport ceiling would eat a noticeable
            // share, so it is also capped at a percentage of the amount.
            for (const purchase of [0.005, 0.01, 0.05, 0.5]) {
                const units = COMPUTE_UNITS.pumpfun;
                const price = priceFor("pumpfun", units, 5_000_000, purchase);
                const paid = priorityLamports(units, price) / LAMPORTS_PER_SOL;
                expect(paid / purchase).toBeLessThanOrEqual(0.011);
            }
        });

        it("on a large purchase the general ceiling applies, not the percentage", () => {
            const units = COMPUTE_UNITS.pumpfun;
            const price = priceFor("pumpfun", units, 5_000_000, 10);
            expect(priorityLamports(units, price)).toBeLessThanOrEqual(MAX_PRIORITY_LAMPORTS.pumpfun + 1);
        });
    });

    describe("a shrunk purchase", () => {
        it("keeps enough for its own sending", () => {
            // A purchase at the tail of a batch shrinks to what is left on the
            // keeper (`resolveSpendableAmount`). The headroom it keeps must
            // cover its own sending, or it fails again with the shrunk amount.
            // That headroom equals two purchase fees.
            const floor = 2 * BUY_PRIORITY_FEE_SOL;
            const worstCasePaid = MAX_PRIORITY_LAMPORTS.pumpfun / LAMPORTS_PER_SOL;
            expect(floor).toBeGreaterThanOrEqual(worstCasePaid);
        });
    });

    describe("the compute limits", () => {
        it("cover the measured usage with headroom", () => {
            // Measured from our own mainnet history on 2026-09-19.
            expect(COMPUTE_UNITS.pumpfun).toBeGreaterThan(91_079);
            expect(COMPUTE_UNITS.pumpswap).toBeGreaterThan(136_845);
            expect(deliveryComputeUnits(5)).toBeGreaterThan(116_620);
            expect(refundComputeUnits(8)).toBeGreaterThan(3_000);
        });

        it("grow with the number of recipients but stop at the cap", () => {
            expect(deliveryComputeUnits(1)).toBeLessThan(deliveryComputeUnits(5));
            expect(deliveryComputeUnits(50)).toBeLessThanOrEqual(200_000);
            expect(refundComputeUnits(1)).toBeLessThan(refundComputeUnits(8));
            expect(refundComputeUnits(100)).toBeLessThanOrEqual(20_000);
        });
    });

    describe("the network estimate", () => {
        it("takes the median of non-zero samples for the accounts in question", async () => {
            mockGetRecentPrioritizationFees.mockResolvedValue([
                { slot: 1, prioritizationFee: 0 },
                { slot: 2, prioritizationFee: 20_000 },
                { slot: 3, prioritizationFee: 60_000 },
                { slot: 4, prioritizationFee: 40_000 },
            ]);
            const value = await estimatePrice([account]);
            expect(value).toBe(40_000);
            expect(mockGetRecentPrioritizationFees).toHaveBeenCalledWith({
                lockedWritableAccounts: [account],
            });
        });

        it("the node stayed silent — we work without an estimate instead of failing", async () => {
            mockGetRecentPrioritizationFees.mockRejectedValue(new Error("rpc down"));
            const value = await estimatePrice([new PublicKey("11111111111111111111111111111112")]);
            expect(value).toBeNull();
        });
    });

    describe("the instructions", () => {
        it("returns the limit and the price, in that order", async () => {
            const instructions = await budgetInstructions("pumpfun", COMPUTE_UNITS.pumpfun, [account]);
            expect(instructions).toHaveLength(2);
            for (const instruction of instructions) {
                expect(instruction.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
            }
            expect(instructions[0].data[0]).toBe(2);
            expect(instructions[1].data[0]).toBe(3);
        });

        it("recognises a budget that is already there: the network rejects duplicates", async () => {
            const instructions = await budgetInstructions("delivery", deliveryComputeUnits(2), [account]);
            expect(hasBudgetInstruction(instructions, "limit")).toBe(true);
            expect(hasBudgetInstruction(instructions, "price")).toBe(true);
            expect(hasBudgetInstruction([], "limit")).toBe(false);
            expect(hasBudgetInstruction([instructions[0]], "price")).toBe(false);
        });
    });
});
