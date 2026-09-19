// tests/unit/pumpfun/feeRecipients.test.ts
// Choosing the fee recipient on pump.fun.
//
// A mistake here breaks EVERY purchase with NotAuthorized, so the rule is
// pinned down by tests. Verified by simulation on mainnet on 2026-09-08 both
// ways: a coin with is_mayhem_mode = 1 accepts only the reserved list, a coin
// with is_mayhem_mode = 0 only the ordinary one.

import { PublicKey } from '@solana/web3.js';
import { allowedFeeRecipients, PumpGlobal } from '../../../pumpfun/buy';

/** Distinguishable placeholder addresses: what matters is which came from where. */
function pk(seed: number): PublicKey {
    const b = Buffer.alloc(32);
    b.writeUInt32BE(seed, 0);
    return new PublicKey(b);
}

const NORMAL_MAIN = pk(1);
const NORMAL_LIST = [pk(10), pk(11), pk(12), pk(13), pk(14), pk(15), pk(16)];
const RESERVED_MAIN = pk(2);
const RESERVED_LIST = [pk(20), pk(21), pk(22), pk(23), pk(24), pk(25), pk(26)];

function global(mayhemModeEnabled: boolean): PumpGlobal {
    return {
        feeRecipient: NORMAL_MAIN,
        feeRecipients: NORMAL_LIST,
        reservedFeeRecipient: RESERVED_MAIN,
        reservedFeeRecipients: RESERVED_LIST,
        buybackFeeRecipients: [pk(30)],
        mayhemModeEnabled,
    };
}

const b58 = (list: PublicKey[]): string[] => list.map((p) => p.toBase58());

describe('allowedFeeRecipients', () => {
    describe('picking the list by the coin\'s own flag', () => {
        it('an ordinary coin -> the ordinary list', () => {
            const got = allowedFeeRecipients(global(true), false);
            expect(b58(got)).toEqual(b58([NORMAL_MAIN, ...NORMAL_LIST]));
        });

        it('a Mayhem-mode coin -> the reserved list', () => {
            const got = allowedFeeRecipients(global(true), true);
            expect(b58(got)).toEqual(b58([RESERVED_MAIN, ...RESERVED_LIST]));
        });

        it('returns all 8 addresses, not just the head one', () => {
            // The head address plus seven from the array. If only one came
            // back, a round's whole fee would go to a single account, which is
            // a noticeable trail.
            expect(allowedFeeRecipients(global(false), false)).toHaveLength(8);
            expect(allowedFeeRecipients(global(true), true)).toHaveLength(8);
        });

        it('the lists do not overlap: they cannot be swapped unnoticed', () => {
            const normal = new Set(b58(allowedFeeRecipients(global(true), false)));
            const reserved = b58(allowedFeeRecipients(global(true), true));
            expect(reserved.some((a) => normal.has(a))).toBe(false);
        });
    });

    describe('the global flag does NOT pick the list', () => {
        // A regression. The old code looked at global.mayhemModeEnabled and,
        // with the mode on, sent the reserved list for EVERY coin — breaking
        // every purchase of an ordinary coin. These two tests fail on that
        // version: it would have returned the reserved list in the first case.
        it('mayhem_mode_enabled = true does not make an ordinary coin reserved', () => {
            const got = allowedFeeRecipients(global(true), false);
            expect(b58(got)).toEqual(b58([NORMAL_MAIN, ...NORMAL_LIST]));
        });

        it('the result depends only on the coin, whatever the global flag', () => {
            for (const flag of [true, false]) {
                expect(b58(allowedFeeRecipients(global(flag), false))).toEqual(
                    b58([NORMAL_MAIN, ...NORMAL_LIST])
                );
                expect(b58(allowedFeeRecipients(global(flag), true))).toEqual(
                    b58([RESERVED_MAIN, ...RESERVED_LIST])
                );
            }
        });
    });
});
