// tests/unit/pumpfun/estimateTokensOut.test.ts
// Unit tests for token estimation

import { estimateTokensOut, TokenPriceInfo } from '../../../pumpfun/price';

// =============================================================================
// HELPERS
// =============================================================================

function createMockPriceInfo(
    virtualSolReserves: number,
    virtualTokenReserves: number
): TokenPriceInfo {
    return {
        pricePerToken: virtualSolReserves / virtualTokenReserves,
        virtualSolReserves,
        virtualTokenReserves,
        isGraduated: false,
    };
}

// =============================================================================
// TESTS
// =============================================================================

describe('estimateTokensOut', () => {
    describe('AMM formula', () => {
        it('should estimate tokens correctly using AMM formula', () => {
            // Setup: 40 SOL / 800M tokens
            const priceInfo = createMockPriceInfo(40, 800_000_000);
            const solAmount = 0.001;

            const result = estimateTokensOut(priceInfo, solAmount);

            // AMM formula: dy = y * dx / (x + dx)
            // dy = 800M * 0.001 / (40 + 0.001) ≈ 19999.5
            // solAmount is the budget; the pump.fun fee is taken before the curve.
            const curveIn = (solAmount * 10000) / 10125;
            const expected = (800_000_000 * curveIn) / (40 + curveIn);

            expect(result).toBeCloseTo(expected, 4);
        });

        it('should estimate larger purchases correctly', () => {
            const priceInfo = createMockPriceInfo(40, 800_000_000);
            const solAmount = 1.0;

            const result = estimateTokensOut(priceInfo, solAmount);

            // dy = 800M * 1 / (40 + 1) ≈ 19.51M tokens
            const curveIn = (solAmount * 10000) / 10125;
            const expected = (800_000_000 * curveIn) / (40 + curveIn);

            expect(result).toBeCloseTo(expected, 2);
        });

        it('should return fewer tokens as price increases (curve slippage)', () => {
            const priceInfo = createMockPriceInfo(40, 800_000_000);

            // Small buy gets better rate
            const smallBuy = estimateTokensOut(priceInfo, 0.001);
            // Large buy gets worse rate (per SOL)
            const largeBuy = estimateTokensOut(priceInfo, 1.0);

            // Tokens per SOL decreases with larger purchases
            const rateSmall = smallBuy / 0.001;
            const rateLarge = largeBuy / 1.0;

            expect(rateSmall).toBeGreaterThan(rateLarge);
        });
    });

    describe('edge cases', () => {
        it('should handle very small SOL amounts', () => {
            const priceInfo = createMockPriceInfo(40, 800_000_000);
            const solAmount = 0.0000001;

            const result = estimateTokensOut(priceInfo, solAmount);

            expect(result).toBeGreaterThan(0);
            expect(Number.isFinite(result)).toBe(true);
        });

        it('should handle initial curve state (30 SOL / 1B tokens)', () => {
            const priceInfo = createMockPriceInfo(30, 1_000_000_000);
            const solAmount = 0.001;

            const result = estimateTokensOut(priceInfo, solAmount);

            // At the start of the curve you get the most tokens per SOL. The
            // threshold was lowered from 33,000: after the pump.fun fee it
            // comes to ~32,921, while the old formula ignored the fee and gave ~33,333.
            expect(result).toBeGreaterThan(32000);
        });

        it('should handle near-graduation state (85 SOL / 200M tokens)', () => {
            const priceInfo = createMockPriceInfo(85, 200_000_000);
            const solAmount = 0.001;

            const result = estimateTokensOut(priceInfo, solAmount);

            // Near graduation, tokens are more expensive
            expect(result).toBeLessThan(3000); // Much fewer tokens
        });
    });

    describe('consistency with calculateBuyParams', () => {
        it('should produce similar results to calculateBuyParams formula', () => {
            // Both use the same AMM formula: dy = y * dx / (x + dx)
            const virtualSol = 40;
            const virtualTokens = 800_000_000;
            const solAmount = 0.001;

            const priceInfo = createMockPriceInfo(virtualSol, virtualTokens);
            const result = estimateTokensOut(priceInfo, solAmount);

            // Both functions treat solAmount as a budget with the fee inside.
            const curveIn = (solAmount * 10000) / 10125;
            const expected = (virtualTokens * curveIn) / (virtualSol + curveIn);

            expect(result).toBeCloseTo(expected, 10);
        });
    });

    describe('determinism', () => {
        it('should return same result for same input', () => {
            const priceInfo = createMockPriceInfo(40, 800_000_000);
            const solAmount = 0.001;

            const result1 = estimateTokensOut(priceInfo, solAmount);
            const result2 = estimateTokensOut(priceInfo, solAmount);

            expect(result1).toBe(result2);
        });
    });
});
