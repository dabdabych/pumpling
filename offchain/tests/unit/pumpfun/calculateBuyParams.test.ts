// tests/unit/pumpfun/calculateBuyParams.test.ts
// Working out the parameters for buy_exact_sol_in: we spend the whole budget
// and express slippage as a lower bound on the tokens received.

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { calculateBuyParams, BondingCurveInfo } from '../../../pumpfun/buy';

const TOKEN_DECIMALS = 6;
const MAX_FEE_BPS = 125;

function curve(virtualSol: number, virtualTokens: number): BondingCurveInfo {
    return {
        mint: PublicKey.default,
        bondingCurve: PublicKey.default,
        associatedBondingCurve: PublicKey.default,
        creator: PublicKey.default,
        tokenProgramId: PublicKey.default,
        isToken2022: false,
        virtualSolReserves: new BN(virtualSol * LAMPORTS_PER_SOL),
        virtualTokenReserves: new BN(virtualTokens * Math.pow(10, TOKEN_DECIMALS)),
        isGraduated: false,
        // Does not affect the parameters: it only decides the fee recipient
        // list (see feeRecipients.test.ts).
        isMayhemMode: false,
        // A curve in native SOL is the only case calculateBuyParams handles:
        // Custom Pairs coins are filtered out earlier.
        quoteMint: PublicKey.default,
        isNativeSolQuote: true,
    };
}

describe('calculateBuyParams', () => {
    describe('what it spends', () => {
        it('spends exactly the budget: the program subtracts the fee', () => {
            // The main property of moving to buy_exact_sol_in. We used to ask
            // for an amount of tokens while the fee went on top of the curve
            // price, so the debit exceeded the budget by a moving amount.
            for (const sol of [0.001, 0.05, 1, 7.5]) {
                const params = calculateBuyParams(curve(40, 800_000_000), sol, 300);
                expect(params.spendableLamports.toString()).toBe(
                    String(Math.floor(sol * LAMPORTS_PER_SOL))
                );
            }
        });

        it('the spend does not depend on slippage', () => {
            const a = calculateBuyParams(curve(40, 800_000_000), 1, 0);
            const b = calculateBuyParams(curve(40, 800_000_000), 1, 2000);
            expect(a.spendableLamports.eq(b.spendableLamports)).toBe(true);
        });
    });

    describe('the lower bound on tokens', () => {
        it('is computed at the worst fee, or the trade bounces', () => {
            // min_tokens_out has to be reachable even at the maximum fee:
            // otherwise the program delivers less than our minimum and rejects.
            // So the expectation is computed from the budget minus the top fee tier.
            const info = curve(40, 800_000_000);
            const sol = 1;
            const params = calculateBuyParams(info, sol, 0);

            const curveIn = (sol * LAMPORTS_PER_SOL * 10000) / (10000 + MAX_FEE_BPS);
            const expected =
                (800_000_000 * Math.pow(10, TOKEN_DECIMALS) * curveIn) /
                (40 * LAMPORTS_PER_SOL + curveIn);

            expect(Number(params.minTokensOut.toString()) / expected).toBeCloseTo(1, 5);
        });

        it('drops by exactly the slippage', () => {
            const info = curve(40, 800_000_000);
            const base = calculateBuyParams(info, 1, 0).minTokensOut;
            for (const bps of [300, 900, 1300]) {
                const withSlip = calculateBuyParams(info, 1, bps).minTokensOut;
                const ratio = Number(withSlip.toString()) / Number(base.toString());
                expect(ratio).toBeCloseTo(1 - bps / 10000, 6);
            }
        });

        it('the higher the slippage, the lower the bar', () => {
            const info = curve(40, 800_000_000);
            const tight = calculateBuyParams(info, 1, 100).minTokensOut;
            const loose = calculateBuyParams(info, 1, 1300).minTokensOut;
            expect(loose.lt(tight)).toBe(true);
        });

        it('does not go negative at an absurd slippage', () => {
            const params = calculateBuyParams(curve(40, 800_000_000), 1, 50_000);
            expect(params.minTokensOut.isNeg()).toBe(false);
        });
    });

    describe('the shape of the curve', () => {
        it('the dearer the coin, the fewer tokens for the same amount', () => {
            const early = calculateBuyParams(curve(30, 1_000_000_000), 1, 300);
            const late = calculateBuyParams(curve(85, 300_000_000), 1, 300);
            expect(late.estimatedTokens).toBeLessThan(early.estimatedTokens);
        });

        it('large reserves do not overflow the calculation', () => {
            const params = calculateBuyParams(curve(85, 700_000_000), 10, 500);
            expect(params.estimatedTokens).toBeGreaterThan(0);
            expect(params.minTokensOut.isNeg()).toBe(false);
        });

        it('very small amounts still give a positive result', () => {
            const params = calculateBuyParams(curve(40, 800_000_000), 0.0001, 300);
            expect(params.spendableLamports.toNumber()).toBe(100_000);
            expect(params.estimatedTokens).toBeGreaterThan(0);
        });
    });
});

describe("the fee rate is read from the config, not hardcoded", () => {
    // Since 2026-09-01 the fee is tiered by market cap and lives in an account
    // an admin edits with no program upgrade. A hardcoded constant would have
    // quietly diverged from reality.
    const { parseMaxFeeBps } = jest.requireActual("../../../pumpfun/buy");

    function feeConfig(flat: number[], tiers: number[][]): Buffer {
        // 8 discriminator + 1 bump + 32 admin + flat_fees(3xu64) + u32 length
        // + per tier: u128 threshold + 3xu64
        const size = 8 + 1 + 32 + 24 + 4 + tiers.length * 40;
        const b = Buffer.alloc(size);
        let o = 8 + 1 + 32;
        for (const v of flat) { b.writeBigUInt64LE(BigInt(v), o); o += 8; }
        b.writeUInt32LE(tiers.length, o); o += 4;
        for (const t of tiers) {
            o += 16; // the threshold does not matter: we take the max across tiers
            for (const v of t) { b.writeBigUInt64LE(BigInt(v), o); o += 8; }
        }
        return b;
    }

    it("takes the maximum across flat_fees and every tier", () => {
        // The maximum is safer than our own tier: an overstated fee makes the
        // token lower bound more conservative, an understated one gives 6042 rejections.
        expect(parseMaxFeeBps(feeConfig([0, 95, 30], [[0, 95, 30]]))).toBe(125);
        expect(parseMaxFeeBps(feeConfig([0, 95, 30], [[0, 95, 30], [0, 200, 50]]))).toBe(250);
        expect(parseMaxFeeBps(feeConfig([0, 300, 0], [[0, 95, 30]]))).toBe(300);
    });

    it("matches the state of the chain as of 2026-09-05", () => {
        // Read from mainnet: one tier, threshold 0, 0 + 95 + 30
        expect(parseMaxFeeBps(feeConfig([0, 95, 30], [[0, 95, 30]]))).toBe(125);
    });

    it("does not read past the end of a truncated account", () => {
        const truncated = feeConfig([0, 95, 30], [[0, 95, 30]]).subarray(0, 70);
        expect(() => parseMaxFeeBps(truncated)).toThrow(/too small|truncated/);
    });

    it("a higher fee makes the token lower bound smaller", () => {
        // The direction of the error matters: overstating is safe, understating is not
        const info = curve(40, 800_000_000);
        const at125 = calculateBuyParams(info, 1, 300, 125);
        const at250 = calculateBuyParams(info, 1, 300, 250);
        expect(at250.minTokensOut.lt(at125.minTokensOut)).toBe(true);
        // The debit does not change: the program subtracts the fee itself
        expect(at250.spendableLamports.eq(at125.spendableLamports)).toBe(true);
    });
});
