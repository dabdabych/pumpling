// tests/unit/pumpfun/quoteMint.test.ts
// Reading the curve asset ("Custom Pairs", on pump.fun since 2026-09-09).
//
// This function decides whether a purchase goes to the curve or the
// aggregator. An error one way is a doomed transaction with
// `UnsupportedQuoteMint`, the other way an ordinary SOL coin goes to the
// aggregator past the curve.

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { readQuoteMint, isNativeSolQuote } from '../../../pumpfun/buy';

const QUOTE_OFFSET = 83;
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

/** A curve account of the right length with a given quote at offset 83. */
function curve(quote: PublicKey | null, length = 151): Buffer {
    const data = Buffer.alloc(length);
    if (quote && length >= QUOTE_OFFSET + 32) {
        quote.toBuffer().copy(data, QUOTE_OFFSET);
    }
    return data;
}

describe('readQuoteMint', () => {
    it('native SOL is written as the System Program, not as WSOL', () => {
        // pump.fun puts 32 zero bytes in this field. Checked against the
        // quote_mint field of their API and against live 2024 curves.
        expect(readQuoteMint(curve(SystemProgram.programId)).toBase58()).toBe(
            SystemProgram.programId.toBase58()
        );
        expect(isNativeSolQuote(readQuoteMint(curve(null)))).toBe(true);
    });

    it('reads a non-SOL quote', () => {
        expect(readQuoteMint(curve(USDC)).toBase58()).toBe(USDC.toBase58());
        expect(isNativeSolQuote(readQuoteMint(curve(USDC)))).toBe(false);
    });

    it('WSOL does not count as native', () => {
        // A separate mint, not native SOL: buy_exact_sol_in will not take it.
        // Treating it as "ours" would mean sending doomed transactions.
        expect(isNativeSolQuote(readQuoteMint(curve(WSOL)))).toBe(false);
    });

    describe('account length', () => {
        it('an account ending exactly at the field is read in full', () => {
            expect(readQuoteMint(curve(USDC, QUOTE_OFFSET + 32)).toBase58()).toBe(
                USDC.toBase58()
            );
        });

        it('a short account means the old layout, so SOL', () => {
            // Before Custom Pairs the field did not exist at all and a curve
            // could only be in SOL. Returning SOL rather than throwing matters:
            // otherwise ordinary coins on the old layout would stop being bought.
            for (const len of [0, 82, QUOTE_OFFSET + 31]) {
                expect(isNativeSolQuote(readQuoteMint(curve(USDC, len)))).toBe(true);
            }
        });

        it('a truncated account does not parse into a junk address', () => {
            // The buffer is shorter than the field: subarray past the end would
            // return an empty slice and PublicKey of that a zero address. Here
            // that IS SOL, but we check it neither throws nor invents a mint.
            const got = readQuoteMint(curve(USDC, 100));
            expect(got.toBase58()).toBe(SystemProgram.programId.toBase58());
        });
    });
});
