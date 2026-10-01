// orchestrator/purchaseTokens.ts
// How many tokens a coin's purchases actually brought.

/**
 * B in the delivery rule: every token bought for a coin.
 *
 * Until now it was inferred as "what the keeper holds plus what it has sent",
 * which is right only while the keeper's balance is read correctly. A balance
 * read straight after our own transaction can come back from a node that has
 * not caught up (seen on 2026-09-28: the keeper still showed 10.5M after they
 * had left). For a delivery that is harmless, a transfer of more than the
 * account holds fails on chain. For a burn it is not: a burn worked out from an
 * inflated balance succeeds, and it destroys tokens that belong to others.
 *
 * So B comes from the purchases themselves. Each confirmed purchase is read
 * once, the keeper's token delta taken from `pre/postTokenBalances`, and kept
 * in the round's state. A purchase that has not been read yet simply does not
 * count: B is a lower bound until then, which under-burns and under-delivers
 * for a round at most, and never the other way.
 *
 * Batch files are only read here, never written. They belong to the batch that
 * writes them in the same process, and a write from outside would be lost on
 * its next save.
 */

import { PublicKey } from "@solana/web3.js";

import { Logger, logger as rootLogger } from "../logger";
import { DebitDeps, readKeeperEffects } from "../solana/debits";
import { BatchState } from "../scheduler/types";
import { OrchestratorStateManager } from "./state";
import { LotteryState, TokenBuyRecord } from "./types";

export type BatchLoader = (filePath?: string) => BatchState | null;

/** The signatures of a coin's completed purchases, across every batch it had. */
export function completedPurchaseSignatures(token: TokenBuyRecord, loadBatch: BatchLoader): string[] {
    const files = token.batchStateFiles?.length
        ? token.batchStateFiles
        : token.batchStateFile
            ? [token.batchStateFile]
            : [];
    const signatures: string[] = [];
    for (const file of files) {
        const batch = loadBatch(file);
        for (const purchase of batch?.purchases ?? []) {
            if (purchase.status === "completed" && purchase.signature) {
                signatures.push(purchase.signature);
            }
        }
    }
    return [...new Set(signatures)];
}

/**
 * Earlier attempts whose signature was kept because they might have landed:
 * a purchase's `pendingSignature` when it is not the one it completed with.
 *
 * The refund already charges the round for these (`refundLedger.buySpend`), and
 * for the same reason they count here: an attempt that quietly landed did not
 * only pay a fee, it bought, and its tokens are on the keeper with everyone
 * else's. Leaving them out would strand them there.
 */
export function pendingPurchaseSignatures(token: TokenBuyRecord, loadBatch: BatchLoader): string[] {
    return pendingPurchaseAttempts(token, loadBatch).map((attempt) => attempt.signature);
}

interface PendingAttempt {
    signature: string;
    /** The purchase record's last update: the attempt was signed no later than this. */
    updatedAt: number;
}

function pendingPurchaseAttempts(token: TokenBuyRecord, loadBatch: BatchLoader): PendingAttempt[] {
    const files = token.batchStateFiles?.length
        ? token.batchStateFiles
        : token.batchStateFile
            ? [token.batchStateFile]
            : [];
    const attempts = new Map<string, PendingAttempt>();
    for (const file of files) {
        const batch = loadBatch(file);
        for (const purchase of batch?.purchases ?? []) {
            if (purchase.pendingSignature && purchase.pendingSignature !== purchase.signature) {
                attempts.set(purchase.pendingSignature, {
                    signature: purchase.pendingSignature,
                    updatedAt: purchase.updatedAt,
                });
            }
            // Every attempt the purchase sent, not only the last one: a
            // purchase signed again after its blockhash ran out has several,
            // and whichever landed bought. Its own signing time is exact.
            for (const attempt of purchase.sentAttempts ?? []) {
                if (attempt.signature !== purchase.signature) {
                    attempts.set(attempt.signature, { signature: attempt.signature, updatedAt: attempt.at });
                }
            }
        }
    }
    return [...attempts.values()];
}

/**
 * After this long an earlier attempt that the node does not have is taken as
 * never landed and recorded as zero, so it is not asked about every round.
 * A transaction can only land while its blockhash is valid, about a minute
 * after signing, and the attempt was signed before its record last changed.
 */
export const PENDING_FINAL_AFTER_MS = 5 * 60_000;

export interface Bought {
    /** Tokens from the purchases already read, raw units. */
    known: bigint;
    /** Completed purchases not read yet. B is not final until this is empty. */
    unread: string[];
    /**
     * Earlier attempts not found on chain yet. Almost always they expired and
     * never will be; they are asked about again, and never waited for.
     */
    unreadPending: string[];
}

/** What is known to have been bought for a coin. */
export function tokensBought(state: LotteryState, mint: string, loadBatch: BatchLoader): Bought {
    const token = (state.tokenBuys ?? []).find((t) => t.mint === mint);
    if (!token) {
        return { known: 0n, unread: [], unreadPending: [] };
    }
    const recorded = state.purchaseTokens ?? {};
    let known = 0n;
    const unread: string[] = [];
    const unreadPending: string[] = [];
    const completed = completedPurchaseSignatures(token, loadBatch);
    const seen = new Set(completed);
    for (const signature of completed) {
        const raw = recorded[signature];
        if (raw === undefined) {
            unread.push(signature);
        } else {
            known += BigInt(raw);
        }
    }
    for (const signature of pendingPurchaseSignatures(token, loadBatch)) {
        if (seen.has(signature)) {
            continue;
        }
        const raw = recorded[signature];
        if (raw === undefined) {
            unreadPending.push(signature);
        } else {
            known += BigInt(raw);
        }
    }
    return { known, unread, unreadPending };
}

/**
 * Reads the purchases of these coins that have not been read yet.
 *
 * A purchase the node does not have yet (it was confirmed a moment ago and this
 * node lags) stays unread and is tried again next time. A purchase that is
 * found but brought no tokens of its coin — which a confirmed purchase cannot —
 * is recorded as zero rather than read forever.
 */
export async function refreshPurchaseTokens(
    stateManager: OrchestratorStateManager,
    keeper: PublicKey,
    mints: string[],
    loadBatch: BatchLoader,
    deps: DebitDeps & { logger?: Logger; now?: () => number } = {}
): Promise<void> {
    const log = deps.logger ?? rootLogger;
    const now = (deps.now ?? Date.now)();
    const state = stateManager.getState();
    const wanted = new Map<string, string>(); // signature -> mint
    const pending = new Map<string, number>(); // signature -> updatedAt
    for (const mint of mints) {
        const bought = tokensBought(state, mint, loadBatch);
        for (const signature of bought.unread) {
            wanted.set(signature, mint);
        }
        const token = (state.tokenBuys ?? []).find((t) => t.mint === mint);
        const attempts = token ? pendingPurchaseAttempts(token, loadBatch) : [];
        for (const signature of bought.unreadPending) {
            wanted.set(signature, mint);
            pending.set(signature, attempts.find((a) => a.signature === signature)?.updatedAt ?? now);
        }
    }
    if (wanted.size === 0) {
        return;
    }

    const effects = await readKeeperEffects([...wanted.keys()], keeper, deps);
    const found = new Map<string, bigint>();
    for (const [signature, mint] of wanted) {
        const effect = effects.get(signature);
        if (!effect) {
            // The request failed: nothing is known, ask again next time.
            continue;
        }
        if (!effect.found) {
            // Not on chain. For an earlier attempt signed long enough ago that
            // is final: it expired on the way.
            const signedBy = pending.get(signature);
            if (signedBy !== undefined && now - signedBy > PENDING_FINAL_AFTER_MS) {
                found.set(signature, 0n);
            }
            continue;
        }
        const delta = effect.tokenDeltas.get(mint) ?? 0n;
        // An earlier attempt that failed on chain changed no balances: zero,
        // and nothing to report.
        if (delta <= 0n && !pending.has(signature)) {
            log.warn(
                { event: "purchase_tokens.none", signature: signature.slice(0, 16), mint: mint.slice(0, 8) },
                "A completed purchase brought no tokens of its coin"
            );
        }
        found.set(signature, delta > 0n ? delta : 0n);
    }
    stateManager.recordPurchaseTokens(found);

    const missing = [...wanted.keys()].filter((signature) => !found.has(signature) && !pending.has(signature)).length;
    if (missing > 0) {
        log.info(
            { event: "purchase_tokens.unread", count: missing },
            `${missing} purchase(s) not readable yet, will retry`
        );
    }
}
