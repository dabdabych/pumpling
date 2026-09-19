// tests/setup.ts
// Common test setup: load .env, initialize keypairs and test tokens

import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';

// =============================================================================
// KEEPER KEYPAIR
// =============================================================================

/**
 * Load keeper keypair from environment.
 * Returns null if KEEPER_SECRET_KEY is not set (for unit tests).
 */
export function loadKeeper(): Keypair | null {
    const secret = process.env.KEEPER_SECRET_KEY;
    if (!secret) {
        return null;
    }
    try {
        return Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(secret))
        );
    } catch {
        return null;
    }
}

// =============================================================================
// TEST TOKENS
// =============================================================================

/**
 * Load test token mints from environment.
 * Returns null if not set.
 */
export function loadTestMints(): {
    pumpfun: PublicKey | null;
    graduated: PublicKey | null;
    graduatedFresh: PublicKey | null;
    dex: PublicKey | null;
    recipient: PublicKey | null;
} {
    const pumpfun = process.env.TEST_MINT_PUMPFUN || process.env.TEST_MINT;
    const graduated = process.env.TEST_MINT_GRADUATED;
    const graduatedFresh = process.env.TEST_MINT_GRADUATED_FRESH;
    const dex = process.env.TEST_MINT_DEX;
    const recipient = process.env.TEST_RECIPIENT;

    return {
        pumpfun: pumpfun ? new PublicKey(pumpfun) : null,
        graduated: graduated ? new PublicKey(graduated) : null,
        graduatedFresh: graduatedFresh ? new PublicKey(graduatedFresh) : null,
        dex: dex ? new PublicKey(dex) : null,
        recipient: recipient ? new PublicKey(recipient) : null,
    };
}

// =============================================================================
// GLOBAL SETUP
// =============================================================================

// Lazy-loaded globals (only initialized when accessed)
let _keeper: Keypair | null | undefined;
let _testMints: ReturnType<typeof loadTestMints> | undefined;

export function getKeeper(): Keypair {
    if (_keeper === undefined) {
        _keeper = loadKeeper();
    }
    if (!_keeper) {
        throw new Error('KEEPER_SECRET_KEY not set in .env');
    }
    return _keeper;
}

export function getTestMints() {
    if (_testMints === undefined) {
        _testMints = loadTestMints();
    }
    return _testMints;
}

// =============================================================================
// SKIP HELPERS
// =============================================================================

/**
 * Skip integration test if required env vars are not set
 */
export function skipIfNoKeeper(): void {
    if (!loadKeeper()) {
        console.warn('Skipping: KEEPER_SECRET_KEY not set');
    }
}

/**
 * Check if integration tests can run
 */
export function canRunIntegrationTests(): boolean {
    return loadKeeper() !== null;
}
