// tests/unit/scheduler/fees.test.ts
// Unit tests for fee calculation and amount splitting

import {
    calculateFees,
    splitAmount,
    ATA_FEE_SOL,
    TX_FEE_SOL,
    BUY_TX_FEE_SOL,
    BUY_PRIORITY_FEE_SOL,
} from "../../../scheduler/fees";

describe("calculateFees", () => {
    describe("ATA fee", () => {
        it("should include ATA fee when hasAta is false", () => {
            const result = calculateFees(1.0, 10, false);
            expect(result.ataFee).toBe(ATA_FEE_SOL);
        });

        it("should not include ATA fee when hasAta is true", () => {
            const result = calculateFees(1.0, 10, true);
            expect(result.ataFee).toBe(0);
        });
    });

    describe("TX fees", () => {
        it("should calculate TX fees as N * BUY_TX_FEE * 2", () => {
            const n = 10;
            const result = calculateFees(1.0, n, true);
            const expectedTxFees = n * BUY_TX_FEE_SOL * 2;
            expect(result.txFees).toBeCloseTo(expectedTxFees, 10);
        });

        it("should reserve extra for retry buffer", () => {
            const result = calculateFees(1.0, 5, true);
            // 5 * (0.000005 + 0.0001) * 2 = 0.00105
            expect(result.txFees).toBeCloseTo(0.00105, 10);
        });

        it("the purchase reserve includes queue position and stays small next to the amount", () => {
            // The network fee without priority is the old 0.00001 SOL; with
            // priority a purchase costs 0.000105. On one SOL of buying the
            // reserve, with double headroom for retries, is 0.2%, and it goes
            // back to participants if it is not spent.
            expect(TX_FEE_SOL).toBeCloseTo(0.00001, 10);
            expect(BUY_TX_FEE_SOL).toBeCloseTo(0.000105, 10);
            const result = calculateFees(1.0, 10, true);
            expect(result.txFees / 1.0).toBeLessThan(0.003);
        });
    });

    describe("total fees and net amount", () => {
        it("should calculate total fees correctly", () => {
            const result = calculateFees(1.0, 10, false);
            expect(result.totalFees).toBeCloseTo(
                result.ataFee + result.txFees,
                10
            );
        });

        it("should calculate net amount as totalSol - totalFees", () => {
            const totalSol = 1.0;
            const result = calculateFees(totalSol, 10, false);
            expect(result.netAmount).toBeCloseTo(
                totalSol - result.totalFees,
                10
            );
        });

        it("should not return negative net amount", () => {
            // Very small amount with lots of purchases
            const result = calculateFees(0.001, 100, false);
            expect(result.netAmount).toBeGreaterThanOrEqual(0);
        });
    });

    describe("realistic scenarios", () => {
        it("should handle 1 SOL with 10 purchases (no ATA)", () => {
            const result = calculateFees(1.0, 10, true);
            // TX fees: 10 * 0.000105 * 2 = 0.0021
            expect(result.txFees).toBeCloseTo(0.0021, 10);
            expect(result.netAmount).toBeCloseTo(0.9979, 10);
        });

        it("should handle 5 SOL with 20 purchases (with ATA)", () => {
            const result = calculateFees(5.0, 20, false);
            // ATA: 0.00204
            // TX: 20 * 0.000105 * 2 = 0.0042
            expect(result.ataFee).toBe(ATA_FEE_SOL);
            expect(result.txFees).toBeCloseTo(0.0042, 10);
            expect(result.totalFees).toBeCloseTo(0.00624, 10);
            expect(result.netAmount).toBeCloseTo(4.99376, 10);
            // On five SOL of buying the whole reserve is a little over a tenth
            // of a percent, and whatever is unspent goes back to participants.
            expect(result.totalFees / 5).toBeLessThan(0.002);
        });
    });
});

describe("splitAmount", () => {
    describe("edge cases", () => {
        it("should return empty array for n <= 0", () => {
            expect(splitAmount(1.0, 0)).toEqual([]);
            expect(splitAmount(1.0, -1)).toEqual([]);
        });

        it("should return empty array for netAmount <= 0", () => {
            expect(splitAmount(0, 5)).toEqual([]);
            expect(splitAmount(-1, 5)).toEqual([]);
        });

        it("should return single element for n = 1", () => {
            const result = splitAmount(1.0, 1);
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(1.0);
        });
    });

    describe("sum invariant", () => {
        it("should sum to exactly netAmount", () => {
            const netAmount = 1.0;
            const result = splitAmount(netAmount, 10);
            const sum = result.reduce((a: number, b: number) => a + b, 0);
            expect(sum).toBeCloseTo(netAmount, 8);
        });

        it("should sum correctly for large N", () => {
            const netAmount = 50;
            const result = splitAmount(netAmount, 100);
            const sum = result.reduce((a: number, b: number) => a + b, 0);
            expect(sum).toBeCloseTo(netAmount, 6);
        });
    });

    describe("variance", () => {
        it("should create N amounts", () => {
            const result = splitAmount(1.0, 10);
            expect(result).toHaveLength(10);
        });

        it("should have variance around the mean (not all equal)", () => {
            const netAmount = 1.0;
            const n = 10;
            const result = splitAmount(netAmount, n);
            const mean = netAmount / n;

            // Check that not all values are exactly equal
            const uniqueValues = new Set(result);
            expect(uniqueValues.size).toBeGreaterThan(1);

            // Check that all values are within reasonable range (±20%)
            for (const amount of result) {
                expect(amount).toBeGreaterThan(mean * 0.8);
                expect(amount).toBeLessThan(mean * 1.2);
            }
        });

        it("should produce different results on multiple calls (randomness)", () => {
            const result1 = splitAmount(1.0, 10);
            const result2 = splitAmount(1.0, 10);

            // Arrays should not be identical (with high probability)
            const identical = result1.every((v: number, i: number) => v === result2[i]);
            // Note: There's a tiny chance this could fail due to random coincidence
            // but it's astronomically unlikely
            expect(identical).toBe(false);
        });
    });

    describe("precision", () => {
        it("should round to lamports precision (9 decimal places)", () => {
            const result = splitAmount(1.0, 10);
            for (const amount of result) {
                // Check that amount has at most 9 decimal places
                const rounded = Math.round(amount * 1e9) / 1e9;
                expect(amount).toBe(rounded);
            }
        });
    });
});
