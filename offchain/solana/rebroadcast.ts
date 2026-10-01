// solana/rebroadcast.ts
// Sending a signed purchase and keeping it on the wire until it lands or expires.

/**
 * Two purchases of 27 in the demo round of 2026-09-29 never reached a block.
 * Both were sent once and then only waited on: the node that took them was
 * trusted to pass them on to the leader, did not, and forty seconds later the
 * blockhash expired. Neither signature is on chain.
 *
 * The Solana guide on retrying transactions
 * (solana.com/developers/guides/advanced/retry) describes exactly this: under
 * load an RPC node can fail to rebroadcast a transaction to the leader, and the
 * remedy is the application's own rebroadcasting, sending the same signed bytes
 * again until the blockhash expires. Helius says the same and adds that
 * `maxRetries` should then be 0, so the node's own retries do not run alongside
 * ours (helius.dev/docs/sending-transactions/optimizing-transactions).
 *
 * Sending the same bytes again cannot buy twice. They carry one signature, and
 * the runtime executes a signature at most once: a copy that arrives after the
 * first was processed is rejected as a duplicate. What can buy twice is a NEW
 * signature while the old one may still land, and nothing here signs anything.
 */

import { Connection, RpcResponseAndContext, SignatureResult } from "@solana/web3.js";

import { connection as defaultConnection, sendTxLimiter } from "./connection";

/**
 * How often the same transaction is sent again. The guide's example sends every
 * 500 ms; ours share one send limit with every other purchase and delivery in
 * flight (`SEND_TX_RATE_LIMIT`, 4 a second, under the Helius ceiling), so four
 * times less often leaves room for them. A blockhash lives about a minute:
 * twenty-odd more chances to reach a leader.
 */
export const REBROADCAST_INTERVAL_MS = 2_000;

export interface BlockhashStrategy {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
}

export interface RebroadcastDeps {
    connection?: Pick<Connection, "sendRawTransaction" | "confirmTransaction">;
    /** Taken before every send, the first included. */
    acquire?: () => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    intervalMs?: number;
    /** Called for each extra send; for metrics and tests. */
    onRebroadcast?: (count: number) => void;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends `raw` and waits for it at `confirmed`, sending the same bytes again
 * every couple of seconds until the wait ends.
 *
 * The wait is `confirmTransaction` with the blockhash strategy, exactly as the
 * buy paths used it: it resolves with the transaction's result, or throws
 * `TransactionExpiredBlockheightExceededError` ("block height exceeded") once
 * the chain is past `lastValidBlockHeight`. The rebroadcast only adds sends; the
 * outcome and its errors are the confirmation's.
 *
 * The first send goes out with `skipPreflight`, as every buy path already did
 * after its own simulation, and `maxRetries: 0`, because we retry ourselves.
 */
export async function sendAndConfirmWithRebroadcast(
    raw: Buffer | Uint8Array,
    strategy: BlockhashStrategy,
    deps: RebroadcastDeps = {}
): Promise<RpcResponseAndContext<SignatureResult>> {
    const conn = deps.connection ?? defaultConnection;
    const acquire = deps.acquire ?? (() => sendTxLimiter.acquire());
    const sleep = deps.sleep ?? sleepFor;
    const interval = deps.intervalMs ?? REBROADCAST_INTERVAL_MS;

    // The caller took its place in the send queue before signing, so the first
    // send does not queue again.
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });

    let settled = false;
    let resent = 0;
    const loop = (async () => {
        while (!settled) {
            await sleep(interval);
            if (settled) {
                return;
            }
            try {
                await acquire();
                if (settled) {
                    return;
                }
                await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
                resent++;
                deps.onRebroadcast?.(resent);
            } catch {
                // "Already processed", a node hiccup, a rate limit: none of them
                // says anything about the outcome, which is the confirmation's
                // to report. The next tick tries again.
            }
        }
    })();

    try {
        return await conn.confirmTransaction(strategy, "confirmed");
    } finally {
        // Not awaited: the loop may be half way through its sleep, and waiting
        // for it would add up to an interval to every purchase. It catches all
        // of its own errors and stops at its next look at the flag.
        settled = true;
        void loop;
    }
}
