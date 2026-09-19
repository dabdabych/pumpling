// tests/integration/send.test.ts
// Integration tests for send() function - requires mainnet connection and tokens

import { send } from '../../send';
import { getKeeper, getTestMints, canRunIntegrationTests } from '../setup';

// Increase timeout for blockchain operations
jest.setTimeout(60000);

// =============================================================================
// SETUP
// =============================================================================

const describeIfIntegration = canRunIntegrationTests() ? describe : describe.skip;

describeIfIntegration('send integration', () => {
    const keeper = getKeeper();
    const mints = getTestMints();

    // Small amount for testing - 1 token unit (raw, not considering decimals)
    const TEST_AMOUNT = 1n;

    beforeAll(() => {
        console.log('Integration tests running with keeper:', keeper.publicKey.toBase58().slice(0, 8) + '...');

        if (!mints.recipient) {
            console.log('WARNING: TEST_RECIPIENT not set - send tests will be skipped');
        }
    });

    // =========================================================================
    // SCENARIO 1: Send pump.fun token
    // =========================================================================

    describe('Scenario 1: Send pump.fun token', () => {
        const shouldRun = mints.pumpfun && mints.recipient;
        const skipIfNoConfig = shouldRun ? it : it.skip;

        skipIfNoConfig('should send pump.fun token to recipient', async () => {
            const result = await send(
                mints.pumpfun!,
                mints.recipient!,
                TEST_AMOUNT,
                keeper
            );

            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            expect(result.recipientAta).toBeDefined();

            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
            console.log(`   Recipient ATA: ${result.recipientAta.toBase58().slice(0, 8)}...`);
        });
    });

    // =========================================================================
    // SCENARIO 2: Send old graduated token
    // =========================================================================

    describe('Scenario 2: Send old graduated token', () => {
        const shouldRun = mints.graduated && mints.recipient;
        const skipIfNoConfig = shouldRun ? it : it.skip;

        skipIfNoConfig('should send old graduated token to recipient', async () => {
            const result = await send(
                mints.graduated!,
                mints.recipient!,
                TEST_AMOUNT,
                keeper
            );

            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            expect(result.recipientAta).toBeDefined();

            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
            console.log(`   Recipient ATA: ${result.recipientAta.toBase58().slice(0, 8)}...`);
        });
    });

    // =========================================================================
    // SCENARIO 3: Send fresh graduated token
    // =========================================================================

    describe('Scenario 3: Send fresh graduated token', () => {
        const shouldRun = mints.graduatedFresh && mints.recipient;
        const skipIfNoConfig = shouldRun ? it : it.skip;

        skipIfNoConfig('should send fresh graduated token to recipient', async () => {
            const result = await send(
                mints.graduatedFresh!,
                mints.recipient!,
                TEST_AMOUNT,
                keeper
            );

            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            expect(result.recipientAta).toBeDefined();

            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
            console.log(`   Recipient ATA: ${result.recipientAta.toBase58().slice(0, 8)}...`);
        });
    });

    // =========================================================================
    // SCENARIO 4: Send DEX token
    // =========================================================================

    describe('Scenario 4: Send DEX token', () => {
        const shouldRun = mints.dex && mints.recipient;
        const skipIfNoConfig = shouldRun ? it : it.skip;

        skipIfNoConfig('should send DEX token to recipient', async () => {
            const result = await send(
                mints.dex!,
                mints.recipient!,
                TEST_AMOUNT,
                keeper
            );

            expect(result.signature).toBeDefined();
            expect(typeof result.signature).toBe('string');
            expect(result.signature.length).toBeGreaterThan(0);

            expect(result.recipientAta).toBeDefined();

            console.log(`   Signature: ${result.signature.slice(0, 16)}...`);
            console.log(`   Recipient ATA: ${result.recipientAta.toBase58().slice(0, 8)}...`);
        });
    });

});

// =============================================================================
// SKIP MESSAGE
// =============================================================================

if (!canRunIntegrationTests()) {
    describe('send integration', () => {
        it('should be skipped - KEEPER_SECRET_KEY not configured', () => {
            console.log('Integration tests skipped: KEEPER_SECRET_KEY not set in .env');
            expect(true).toBe(true);
        });
    });
}
