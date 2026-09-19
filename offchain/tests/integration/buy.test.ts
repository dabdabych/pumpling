// tests/integration/buy.test.ts
// Integration tests for buy() function - requires mainnet connection

import { buy, isBondingCurveActive } from '../../buy';
import { getKeeper, getTestMints, canRunIntegrationTests } from '../setup';

// Increase timeout for blockchain operations
jest.setTimeout(60000);

// =============================================================================
// SETUP
// =============================================================================

const describeIfIntegration = canRunIntegrationTests() ? describe : describe.skip;

describeIfIntegration('buy integration', () => {
    const keeper = getKeeper();
    const mints = getTestMints();

    // Minimal amount for testing - 0.0001 SOL (~$0.02)
    const TEST_AMOUNT = 0.0001;

    beforeAll(() => {
        console.log('Integration tests running with keeper:', keeper.publicKey.toBase58().slice(0, 8) + '...');
    });

    // =========================================================================
    // SCENARIO 1: Non-graduated token (pump.fun bonding curve)
    // =========================================================================

    describe('Scenario 1: Non-graduated pump.fun token', () => {
        const skipIfNoMint = mints.pumpfun ? it : it.skip;

        skipIfNoMint('should check bonding curve is active', async () => {
            const isActive = await isBondingCurveActive(mints.pumpfun!, keeper);
            console.log(`   Bonding curve active: ${isActive}`);
            expect(typeof isActive).toBe('boolean');
        });

        skipIfNoMint('should buy token on pump.fun bonding curve', async () => {
            // First verify it's actually on bonding curve
            const isActive = await isBondingCurveActive(mints.pumpfun!, keeper);

            if (!isActive) {
                console.log('   Token has graduated - skipping pumpfun test');
                return;
            }

            const result = await buy(mints.pumpfun!, TEST_AMOUNT, keeper);

            expect(result.venue).toBe('pumpfun');
            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            console.log(`   Venue: ${result.venue}`);
            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
        });
    });

    // =========================================================================
    // SCENARIO 2a: Old graduated token (bonding curve closed/reclaimed)
    // =========================================================================

    describe('Scenario 2a: Old graduated token (account closed)', () => {
        const skipIfNoMint = mints.graduated ? it : it.skip;

        skipIfNoMint('should detect inactive bonding curve (account too small)', async () => {
            const isActive = await isBondingCurveActive(mints.graduated!, keeper);
            console.log(`   Bonding curve active: ${isActive}`);

            // Old graduated token - account closed or < 81 bytes
            expect(isActive).toBe(false);
        });

        skipIfNoMint('should buy old graduated token via DEX', async () => {
            const result = await buy(mints.graduated!, TEST_AMOUNT, keeper);

            expect(result.venue).toBe('dex');
            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            console.log(`   Venue: ${result.venue}`);
            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
        });
    });

    // =========================================================================
    // SCENARIO 2b: Fresh graduated token (bonding curve exists, complete=true)
    // =========================================================================

    describe('Scenario 2b: Fresh graduated token (complete=true)', () => {
        const skipIfNoMint = mints.graduatedFresh ? it : it.skip;

        skipIfNoMint('should detect inactive bonding curve (complete=true)', async () => {
            const isActive = await isBondingCurveActive(mints.graduatedFresh!, keeper);
            console.log(`   Bonding curve active: ${isActive}`);

            // Fresh graduated token - account exists but complete=true
            expect(isActive).toBe(false);
        });

        skipIfNoMint('should buy fresh graduated token via DEX', async () => {
            const result = await buy(mints.graduatedFresh!, TEST_AMOUNT, keeper);

            expect(result.venue).toBe('dex');
            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            console.log(`   Venue: ${result.venue}`);
            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
        });
    });

    // =========================================================================
    // SCENARIO 3: Regular DEX token (not pump.fun)
    // =========================================================================

    describe('Scenario 3: Regular DEX token', () => {
        const skipIfNoMint = mints.dex ? it : it.skip;

        skipIfNoMint('should have no bonding curve', async () => {
            const isActive = await isBondingCurveActive(mints.dex!, keeper);
            console.log(`   Bonding curve active: ${isActive}`);

            // Regular DEX token has no bonding curve
            expect(isActive).toBe(false);
        });

        skipIfNoMint('should buy regular token via Jupiter DEX', async () => {
            const result = await buy(mints.dex!, TEST_AMOUNT, keeper);

            expect(result.venue).toBe('dex');
            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            console.log(`   Venue: ${result.venue}`);
            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
        });
    });

    // =========================================================================
    // ROUTING LOGIC
    // =========================================================================

    describe('Routing logic', () => {
        it('should route active bonding curve to pumpfun', async () => {
            if (!mints.pumpfun) {
                console.log('   Skipping: TEST_MINT_PUMPFUN not set');
                return;
            }

            const isActive = await isBondingCurveActive(mints.pumpfun, keeper);

            if (isActive) {
                const result = await buy(mints.pumpfun, TEST_AMOUNT, keeper);
                expect(result.venue).toBe('pumpfun');
            } else {
                console.log('   Token graduated, testing DEX route instead');
                const result = await buy(mints.pumpfun, TEST_AMOUNT, keeper);
                expect(result.venue).toBe('dex');
            }
        });
    });
});

// =============================================================================
// SKIP MESSAGE
// =============================================================================

if (!canRunIntegrationTests()) {
    describe('buy integration', () => {
        it('should be skipped - KEEPER_SECRET_KEY not configured', () => {
            console.log('Integration tests skipped: KEEPER_SECRET_KEY not set in .env');
            expect(true).toBe(true);
        });
    });
}
