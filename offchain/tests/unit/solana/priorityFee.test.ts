// tests/unit/solana/priorityFee.test.ts
// Paying for a place in the block: the ceilings, the network estimate and the reserve for it.

import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";

const mockGetRecentPrioritizationFees = jest.fn();

jest.mock("../../../solana/connection", () => ({
    connection: {
        rpcEndpoint: "http://rpc.test",
        getRecentPrioritizationFees: (...args: unknown[]) => mockGetRecentPrioritizationFees(...args),
    },
    sendTxLimiter: { acquire: jest.fn() },
}));

import {
    BUY_MIN_PRICE_MICRO_LAMPORTS,
    MAX_PRIORITY_LAMPORTS,
    COMPUTE_UNITS,
    budgetInstructions,
    buyPriceEstimate,
    recommendedPrice,
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

const mockFetch = jest.fn();

/** A fresh account per case: the estimates are cached per set of accounts. */
let accountSeed = 1;
function freshAccount(): PublicKey {
    const bytes = new Uint8Array(32);
    bytes[0] = accountSeed++;
    bytes[1] = 77;
    return new PublicKey(bytes);
}

function recommends(value: unknown) {
    mockFetch.mockResolvedValue({ json: async () => ({ jsonrpc: "2.0", id: "priority", result: { priorityFeeEstimate: value } }) });
}

describe("the priority fee", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetRecentPrioritizationFees.mockResolvedValue([]);
        (globalThis as { fetch: unknown }).fetch = mockFetch;
        recommends(null);
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

    // Two of 27 purchases in the demo round of 2026-09-29 never reached a
    // block, all 27 at 1,000 microlamports. Helius routes over its staked
    // connections only at or above its recommended fee, which was 10,000.
    describe("the purchase floor", () => {
        it("a purchase never pays less than the floor, on every path", () => {
            for (const [path, units] of [["pumpfun", COMPUTE_UNITS.pumpfun], ["pumpswap", COMPUTE_UNITS.pumpswap], ["dex", 210_000]] as const) {
                expect(priceFor(path, units, null)).toBe(BUY_MIN_PRICE_MICRO_LAMPORTS);
                expect(priceFor(path, units, 3_000)).toBe(BUY_MIN_PRICE_MICRO_LAMPORTS);
                expect(priceFor(path, units, 50_000)).toBe(50_000);
            }
            expect(BUY_MIN_PRICE_MICRO_LAMPORTS).toBe(10_000);
        });

        it("delivery and refunds keep their own floor", () => {
            expect(priceFor("delivery", deliveryComputeUnits(2), null)).toBe(1_000);
            expect(priceFor("refund", refundComputeUnits(4), null)).toBe(1_000);
        });

        it("the floor fits under every purchase ceiling and inside the reserve for an attempt", () => {
            for (const [path, units] of [["pumpfun", COMPUTE_UNITS.pumpfun], ["pumpswap", COMPUTE_UNITS.pumpswap], ["dex", 210_000]] as const) {
                const lamports = priorityLamports(units, BUY_MIN_PRICE_MICRO_LAMPORTS);
                expect(lamports).toBeLessThanOrEqual(MAX_PRIORITY_LAMPORTS[path]);
                expect(lamports).toBeLessThanOrEqual(Math.round(BUY_PRIORITY_FEE_SOL * LAMPORTS_PER_SOL));
            }
            // In money: 1,400 lamports on the curve, 2,100 through Jupiter.
            expect(priorityLamports(COMPUTE_UNITS.pumpfun, BUY_MIN_PRICE_MICRO_LAMPORTS)).toBe(1_400);
            expect(priorityLamports(210_000, BUY_MIN_PRICE_MICRO_LAMPORTS)).toBe(2_100);
        });
    });

    describe("Helius's recommended fee", () => {
        it("is asked for the accounts the purchase writes, with recommended on", async () => {
            recommends(10_000);
            const who = freshAccount();
            expect(await recommendedPrice([who])).toBe(10_000);
            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe("http://rpc.test");
            const body = JSON.parse(init.body);
            expect(body.method).toBe("getPriorityFeeEstimate");
            expect(body.params[0]).toEqual({ accountKeys: [who.toBase58()], options: { recommended: true } });
        });

        it("another provider's error is no answer, not a failure", async () => {
            mockFetch.mockResolvedValue({ json: async () => ({ jsonrpc: "2.0", error: { code: -32601, message: "Method not found" } }) });
            expect(await recommendedPrice([freshAccount()])).toBeNull();
            mockFetch.mockRejectedValue(new Error("aborted"));
            expect(await recommendedPrice([freshAccount()])).toBeNull();
        });

        it("is held for a minute, like the network estimate", async () => {
            recommends(12_000);
            const who = freshAccount();
            let clock = 1_000_000;
            await recommendedPrice([who], { now: () => clock });
            clock += 30_000;
            await recommendedPrice([who], { now: () => clock });
            expect(mockFetch).toHaveBeenCalledTimes(1);
            clock += 31_000;
            await recommendedPrice([who], { now: () => clock });
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("a purchase starts from the higher of the two", async () => {
            recommends(10_000);
            mockGetRecentPrioritizationFees.mockResolvedValue([{ slot: 1, prioritizationFee: 40_000 }]);
            expect(await buyPriceEstimate([freshAccount()])).toBe(40_000);
            mockGetRecentPrioritizationFees.mockResolvedValue([]);
            expect(await buyPriceEstimate([freshAccount()])).toBe(10_000);
        });

        it("a purchase asks for it; delivery does not", async () => {
            recommends(25_000);
            const bought = await budgetInstructions("pumpfun", COMPUTE_UNITS.pumpfun, [freshAccount()], 0.2);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(bought[1].data.readBigUInt64LE(1)).toBe(25_000n);
            mockFetch.mockClear();
            await budgetInstructions("delivery", deliveryComputeUnits(1), [freshAccount()]);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
});
