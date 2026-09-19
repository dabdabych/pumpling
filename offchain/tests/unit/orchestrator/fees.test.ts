// tests/unit/orchestrator/fees.test.ts

import { Keypair, PublicKey } from "@solana/web3.js";
import {
    calculateSendReserve,
    distributeBuyBudget,
} from "../../../orchestrator/fees";
import { ATA_FEE_SOL, TX_FEE_SOL } from "../../../scheduler/fees";

describe("calculateSendReserve", () => {
    it("should return 0 for empty array", () => {
        expect(calculateSendReserve([])).toBe(0);
    });

    it("should calculate reserve for single recipient without ATA", () => {
        const reserve = calculateSendReserve([{ sendN: 1, hasAta: false }]);
        // ATA_FEE (create once) + 1 × TX_FEE
        expect(reserve).toBeCloseTo(ATA_FEE_SOL + TX_FEE_SOL, 10);
    });

    it("should skip ATA fee when recipient already has ATA", () => {
        const reserve = calculateSendReserve([{ sendN: 1, hasAta: true }]);
        // No ATA fee, just TX_FEE
        expect(reserve).toBeCloseTo(TX_FEE_SOL, 10);
    });

    it("should calculate reserve for sendN=10 without ATA", () => {
        const reserve = calculateSendReserve([{ sendN: 10, hasAta: false }]);
        // ATA_FEE (once) + 10 × TX_FEE
        expect(reserve).toBeCloseTo(ATA_FEE_SOL + 10 * TX_FEE_SOL, 10);
    });

    it("should calculate reserve for sendN=10 with ATA", () => {
        const reserve = calculateSendReserve([{ sendN: 10, hasAta: true }]);
        expect(reserve).toBeCloseTo(10 * TX_FEE_SOL, 10);
    });

    it("should sum across multiple recipients (mixed ATA status)", () => {
        const reserve = calculateSendReserve([
            { sendN: 1, hasAta: false },
            { sendN: 3, hasAta: true },
            { sendN: 5, hasAta: false },
        ]);
        // 2 × ATA_FEE + (1+3+5) × TX_FEE
        const expected = 2 * ATA_FEE_SOL + 9 * TX_FEE_SOL;
        expect(reserve).toBeCloseTo(expected, 10);
    });

    it("should handle 50 recipients all without ATA", () => {
        const sends = Array.from({ length: 50 }, () => ({
            sendN: 1,
            hasAta: false,
        }));
        const reserve = calculateSendReserve(sends);
        expect(reserve).toBeCloseTo(50 * (ATA_FEE_SOL + TX_FEE_SOL), 10);
    });

    it("should handle 50 recipients all with ATA (no ATA fees)", () => {
        const sends = Array.from({ length: 50 }, () => ({
            sendN: 1,
            hasAta: true,
        }));
        const reserve = calculateSendReserve(sends);
        expect(reserve).toBeCloseTo(50 * TX_FEE_SOL, 10);
    });
});

describe("distributeBuyBudget", () => {
    const mint1 = Keypair.generate().publicKey;
    const mint2 = Keypair.generate().publicKey;

    function makeToken(mint: PublicKey, totalSol: number) {
        return { mint, totalSol, recipients: [] };
    }

    it("should return empty array for no tokens", () => {
        expect(distributeBuyBudget([], 100)).toEqual([]);
    });

    it("should give all budget to single token", () => {
        const result = distributeBuyBudget([makeToken(mint1, 50)], 49);
        expect(result).toEqual([49]);
    });

    it("should distribute proportionally between two equal tokens", () => {
        const result = distributeBuyBudget(
            [makeToken(mint1, 50), makeToken(mint2, 50)],
            98
        );
        expect(result[0]).toBeCloseTo(49, 6);
        expect(result[1]).toBeCloseTo(49, 6);
        expect(result[0] + result[1]).toBeCloseTo(98, 6);
    });

    it("should distribute proportionally between unequal tokens", () => {
        const result = distributeBuyBudget(
            [makeToken(mint1, 75), makeToken(mint2, 25)],
            100
        );
        expect(result[0]).toBeCloseTo(75, 6);
        expect(result[1]).toBeCloseTo(25, 6);
    });

    it("should sum to exactly buyBudget (remainder goes to last)", () => {
        const tokens = [
            makeToken(mint1, 33),
            makeToken(mint2, 33),
            makeToken(Keypair.generate().publicKey, 34),
        ];
        const result = distributeBuyBudget(tokens, 99.5);
        const sum = result.reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(99.5, 6);
    });
});
