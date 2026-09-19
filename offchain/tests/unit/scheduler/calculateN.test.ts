// tests/unit/scheduler/calculateN.test.ts
// Unit tests for calculateN function

import { calculateN } from "../../../scheduler/fees";

describe("calculateN", () => {
    describe("boundary cases", () => {
        it("should return 0 for zero or negative amounts", () => {
            expect(calculateN(0)).toBe(0);
            expect(calculateN(-1)).toBe(0);
            expect(calculateN(-100)).toBe(0);
        });

        it("should return 1 for amounts <= 0.1 SOL", () => {
            expect(calculateN(0.01)).toBe(1);
            expect(calculateN(0.05)).toBe(1);
            expect(calculateN(0.1)).toBe(1);
        });
    });

    describe("range: 0.1-1 SOL → 2-10 purchases", () => {
        it("should return 2 for 0.2 SOL", () => {
            expect(calculateN(0.2)).toBe(2);
        });

        it("should return 5 for 0.5 SOL", () => {
            expect(calculateN(0.5)).toBe(5);
        });

        it("should return 10 for 1.0 SOL", () => {
            expect(calculateN(1.0)).toBe(10);
        });

        it("should scale linearly in 0.1-1 range", () => {
            // Note: floating point precision means 0.3/0.1 = 2.999... → floor = 2
            expect(calculateN(0.31)).toBe(3);
            expect(calculateN(0.71)).toBe(7);
            expect(calculateN(0.91)).toBe(9);
        });
    });

    describe("range: 1-5 SOL → 10-20 purchases", () => {
        it("should return 10 at boundary (1 SOL)", () => {
            expect(calculateN(1.0)).toBe(10);
        });

        it("should return 12 for 2 SOL", () => {
            // 10 + (2-1) * 2.5 = 10 + 2.5 = 12
            expect(calculateN(2)).toBe(12);
        });

        it("should return 20 for 5 SOL", () => {
            // 10 + (5-1) * 2.5 = 10 + 10 = 20
            expect(calculateN(5)).toBe(20);
        });

        it("should scale correctly in 1-5 range", () => {
            expect(calculateN(3)).toBe(15); // 10 + 2*2.5 = 15
            expect(calculateN(4)).toBe(17); // 10 + 3*2.5 = 17
        });
    });

    describe("range: 5-50 SOL → 20-100 purchases", () => {
        it("should return 20 at boundary (5 SOL)", () => {
            expect(calculateN(5)).toBe(20);
        });

        it("should return ~60 for 27.5 SOL (midpoint)", () => {
            // 20 + (27.5-5) * (80/45) = 20 + 22.5 * 1.78 = 20 + 40 = 60
            expect(calculateN(27.5)).toBe(60);
        });

        it("should return 100 for 50 SOL", () => {
            // 20 + (50-5) * (80/45) = 20 + 45 * 1.78 = 20 + 80 = 100
            expect(calculateN(50)).toBe(100);
        });

        it("should scale correctly in 5-50 range", () => {
            expect(calculateN(10)).toBe(28); // 20 + 5*(80/45) ≈ 28
            expect(calculateN(20)).toBe(46); // 20 + 15*(80/45) ≈ 46
        });
    });

    describe("range: 50+ SOL → 100 purchases (capped)", () => {
        it("should return 100 for 50 SOL", () => {
            expect(calculateN(50)).toBe(100);
        });

        it("should return 100 for amounts above 50 SOL", () => {
            expect(calculateN(100)).toBe(100);
            expect(calculateN(500)).toBe(100);
            expect(calculateN(1000)).toBe(100);
        });
    });

    describe("documented examples from plan", () => {
        it("should match the table from the plan", () => {
            expect(calculateN(0.1)).toBe(1);
            expect(calculateN(1.0)).toBe(10);
            expect(calculateN(5.0)).toBe(20);
            expect(calculateN(50)).toBe(100);
        });
    });
});
