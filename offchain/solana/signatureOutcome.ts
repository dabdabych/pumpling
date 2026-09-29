// solana/signatureOutcome.ts
// Whether a transaction we signed has landed, never will, or may still.

/**
 * "The node has no such signature" is not the same as "it will never land".
 * A leader can still pick the transaction up for as long as its blockhash is
 * valid, up to `lastValidBlockHeight`. Signing a replacement before then is how
 * both end up on chain. The Solana guide on retrying transactions
 * (solana.com/developers/guides/advanced/retry) says so directly: "Before
 * re-signing any transaction, it is very important to ensure that the initial
 * transaction's blockhash has expired. If the initial blockhash is still valid,
 * it is possible for both transactions to be accepted by the network."
 *
 * So a missing signature counts as `absent` only once the chain is past that
 * height:
 *
 *  - the height is read BEFORE the status. If the height was already past the
 *    limit, every block that could hold the transaction existed before we
 *    asked about the signature, so the answer covers all of them;
 *  - the height is the `finalized` one, which trails `confirmed` by about 30
 *    blocks, and it has to clear the limit by a further margin, because the
 *    height and the status can come from different nodes behind one provider.
 *
 * Waiting costs a pass: at most one delivery round, a minute or two in the
 * sweep. Guessing wrong on a burn destroys somebody else's tokens.
 */

import { Connection } from "@solana/web3.js";

import { connection as defaultConnection } from "./connection";

export type SignatureOutcome =
    /** Confirmed or finalized, and it succeeded. */
    | "landed"
    /** Not on chain, and it can no longer get there. Safe to sign again. */
    | "absent"
    /** On chain, and it failed: its fee was paid, nothing else happened. */
    | "failed"
    /** Cannot tell yet: still in flight, only processed, or the node did not answer. */
    | "unknown";

/**
 * Blocks past `lastValidBlockHeight`, on top of reading the `finalized` height,
 * before a missing signature counts as gone. `finalized` already trails
 * `confirmed` by about 32 blocks; this doubles that, about 25 seconds in all.
 * Longer would be safer by nothing measurable and would cost the purchase
 * ladder, which waits this out before every re-sign, time from a window
 * capped at fifteen minutes.
 */
export const EXPIRY_MARGIN_BLOCKS = 32;

export interface OutcomeDeps {
    connection?: Pick<Connection, "getSignatureStatus" | "getBlockHeight">;
}

/**
 * @param lastValidBlockHeight the limit of the blockhash the transaction was
 *   signed with. Without it a missing signature is taken as absent, which is
 *   what every caller did before; pass it wherever it is known.
 */
export async function signatureOutcome(
    signature: string,
    lastValidBlockHeight?: number,
    deps: OutcomeDeps = {}
): Promise<SignatureOutcome> {
    const conn = deps.connection ?? defaultConnection;
    try {
        const height = lastValidBlockHeight === undefined ? null : await conn.getBlockHeight("finalized");
        const status = await conn.getSignatureStatus(signature, {
            // Without it the node looks only in its recent status cache, and an
            // old transaction reads as never sent (checked 2026-09-28 on the
            // public node with a delivery a few hours old).
            searchTransactionHistory: true,
        });
        const value = status.value;
        if (value === null) {
            if (height !== null && height <= lastValidBlockHeight! + EXPIRY_MARGIN_BLOCKS) {
                return "unknown";
            }
            return "absent";
        }
        if (value.err) {
            return "failed";
        }
        return value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized"
            ? "landed"
            : "unknown";
    } catch {
        return "unknown";
    }
}
