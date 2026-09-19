// tests/unit/solana/getBondingCurveAddress.test.ts
// Unit tests for PDA derivation

import { PublicKey } from '@solana/web3.js';
import { getBondingCurveAddress, PUMP_PROGRAM_ID } from '../../../solana/config';

// =============================================================================
// TESTS
// =============================================================================

describe('getBondingCurveAddress', () => {
    describe('PDA derivation', () => {
        it('should derive a valid PublicKey', () => {
            const mint = new PublicKey('So11111111111111111111111111111111111111112');

            const result = getBondingCurveAddress(mint);

            expect(result).toBeInstanceOf(PublicKey);
            expect(PublicKey.isOnCurve(result)).toBe(false); // PDAs are off-curve
        });

        it('should use correct seeds: ["bonding-curve", mint]', () => {
            const mint = new PublicKey('So11111111111111111111111111111111111111112');

            // Manually derive using the same seeds
            const [expectedPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('bonding-curve'), mint.toBuffer()],
                PUMP_PROGRAM_ID
            );

            const result = getBondingCurveAddress(mint);

            expect(result.equals(expectedPda)).toBe(true);
        });

        it('should use PUMP_PROGRAM_ID as the program', () => {
            // Verify the program ID is correct
            expect(PUMP_PROGRAM_ID.toBase58()).toBe(
                '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
            );
        });
    });

    describe('determinism', () => {
        it('should return same address for same mint', () => {
            const mint = new PublicKey('So11111111111111111111111111111111111111112');

            const result1 = getBondingCurveAddress(mint);
            const result2 = getBondingCurveAddress(mint);

            expect(result1.equals(result2)).toBe(true);
        });

        it('should return different addresses for different mints', () => {
            const mint1 = new PublicKey('So11111111111111111111111111111111111111112');
            const mint2 = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

            const result1 = getBondingCurveAddress(mint1);
            const result2 = getBondingCurveAddress(mint2);

            expect(result1.equals(result2)).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('should handle default PublicKey', () => {
            const mint = PublicKey.default;

            expect(() => {
                getBondingCurveAddress(mint);
            }).not.toThrow();

            const result = getBondingCurveAddress(mint);
            expect(result).toBeInstanceOf(PublicKey);
        });

        it('should handle maximum address value', () => {
            // All 1s address (close to max)
            const mint = new PublicKey('11111111111111111111111111111111');

            expect(() => {
                getBondingCurveAddress(mint);
            }).not.toThrow();
        });
    });

    describe('PDA properties', () => {
        it('should always return off-curve addresses (valid PDAs)', () => {
            const testMints = [
                'So11111111111111111111111111111111111111112',
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                '11111111111111111111111111111111',
            ];

            for (const mintStr of testMints) {
                const mint = new PublicKey(mintStr);
                const pda = getBondingCurveAddress(mint);

                // PDAs must be off the ed25519 curve
                expect(PublicKey.isOnCurve(pda)).toBe(false);
            }
        });
    });
});
