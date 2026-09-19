// orchestrator/refunds.ts
// Returning the SOL that could not be spent on buying.

/**
 * Why.
 *
 * We promise one thing: the SOL from the pool goes into public purchases of the
 * named coins. If some purchases did not go through (the coin collapsed into
 * illiquidity, the node went down, the attempts ran out), that SOL stays on the
 * keeper wallet. The promise about it was not kept, so the money has to go back
 * to the people who put it in. Quietly keeping it is not an option: it is
 * somebody else's money.
 *
 * How it is worked out.
 *
 * 1. Per coin: what was allocated to it minus what was actually spent.
 * 2. The remainder is split between the people behind that coin, by the size of
 *    their commit.
 * 3. The network fee comes out of the refund: the keeper pays it, and we never
 *    signed up to cover it out of our own pocket. Transfers go in batches of
 *    several recipients per transaction, so the fee each one carries is several
 *    times smaller than sending one by one.
 * 4. Refunds below a threshold are not sent: the fee would eat them whole.
 *
 * A double send is ruled out the same way as in token delivery: a record has a
 * status and a "sent but not confirmed" signature, which is checked on the
 * network before any repeat.
 */

import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import { connection } from "../solana/connection";
import { sendTransaction } from "../solana/transaction";
import { Logger, logger as rootLogger } from "../logger";
import { TX_FEE_SOL } from "../scheduler/fees";
import { budgetInstructions, refundComputeUnits } from "../solana/priorityFee";
import { OrchestratorStateManager } from "./state";
import { LotteryState, RefundRecord } from "./types";

/** How many recipients go into one transaction. */
export const REFUND_BATCH_SIZE = 8;

/**
 * We do not try to return less than this: after the fee only pennies would be
 * left, while the transaction would still cost money and time.
 */
export const MIN_REFUND_SOL = 0.002;

/** A remainder below this is treated as fully spent. */
export const MIN_UNSPENT_SOL = 0.001;

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface RefundDeps {
    keeper: Keypair;
    logger?: Logger;
    /** Overrides sending, for tests. */
    send?: (tx: Transaction, keeper: Keypair) => Promise<string>;
    /** Overrides the signature check, for tests. */
    signatureLanded?: (signature: string) => Promise<boolean | null>;
}

// =============================================================================
// THE REFUND PLAN
// =============================================================================

/** Who stood behind a coin and with how much. */
export function stakesByMint(state: LotteryState): Map<string, Map<string, number>> {
    const byMint = new Map<string, Map<string, number>>();
    for (const send of state.sends ?? []) {
        const recipients = byMint.get(send.mint) ?? new Map<string, number>();
        // One commit produces several deliveries across rounds, so we take the
        // maximum rather than the sum: this is the size of the commit, not how
        // many there were.
        recipients.set(send.recipient, Math.max(recipients.get(send.recipient) ?? 0, send.recipientBetSol));
        byMint.set(send.mint, recipients);
    }
    return byMint;
}

/**
 * What to return for each coin.
 *
 * `spentByMint` is computed from the batch files: in the round state that field
 * only appears after buying, and we need to work with older files too.
 */
export function planRefunds(state: LotteryState, spentByMint: Map<string, number>): RefundRecord[] {
    const stakes = stakesByMint(state);
    const now = Date.now();
    const plan: RefundRecord[] = [];

    for (const token of state.tokenBuys ?? []) {
        const spent = spentByMint.get(token.mint) ?? token.spentSol ?? 0;
        const unspent = round9(token.adjustedSolAmount - spent);
        if (unspent < MIN_UNSPENT_SOL) {
            continue;
        }

        const recipients = stakes.get(token.mint);
        if (!recipients || recipients.size === 0) {
            // Nobody to return it to: no one stands behind this coin. That
            // should not happen, but staying quiet about it is not an option —
            // the money stays on the keeper.
            continue;
        }

        const totalStake = [...recipients.values()].reduce((sum, value) => sum + value, 0);
        if (totalStake <= 0) {
            continue;
        }

        // The fee per person: one transaction per batch of recipients.
        const perRecipientFee = round9(TX_FEE_SOL / Math.min(REFUND_BATCH_SIZE, recipients.size));

        for (const [recipient, stake] of recipients) {
            const gross = round9((unspent * stake) / totalStake);
            const net = round9(gross - perRecipientFee);
            const id = `${token.mint}:${recipient}`;

            if (net < MIN_REFUND_SOL) {
                plan.push({
                    id,
                    mint: token.mint,
                    recipient,
                    grossSol: gross,
                    feeSol: perRecipientFee,
                    amountSol: 0,
                    status: "skipped",
                    errorMessage: "Too small to be worth the network fee",
                    attempts: 0,
                    updatedAt: now,
                });
                continue;
            }

            plan.push({
                id,
                mint: token.mint,
                recipient,
                grossSol: gross,
                feeSol: perRecipientFee,
                amountSol: net,
                status: "pending",
                attempts: 0,
                updatedAt: now,
            });
        }
    }

    return plan;
}

// =============================================================================
// SENDING
// =============================================================================

/**
 * Returns the unspent SOL.
 *
 * The function is idempotent: refunds already sent are skipped, and a stuck
 * signature is checked against the network before any repeat.
 */
export async function refundUnspent(
    stateManager: OrchestratorStateManager,
    spentByMint: Map<string, number>,
    deps: RefundDeps
): Promise<{ sent: number; skipped: number; failed: number; solReturned: number }> {
    const log = deps.logger ?? rootLogger;
    const send = deps.send ?? sendTransaction;
    const state = stateManager.getState();

    if (!state.refunds || state.refunds.length === 0) {
        const plan = planRefunds(state, spentByMint);
        if (plan.length === 0) {
            return { sent: 0, skipped: 0, failed: 0, solReturned: 0 };
        }
        stateManager.setRefunds(plan);
    }

    const pending = stateManager.getState().refunds!.filter((refund) => refund.status === "pending" || refund.status === "in_progress");
    if (pending.length === 0) {
        const done = stateManager.getState().refunds!;
        return summarize(done);
    }

    log.warn(
        { event: "refund.start", count: pending.length, sol: round9(pending.reduce((sum, r) => sum + r.amountSol, 0)) },
        `Returning unspent SOL to ${pending.length} participants`
    );

    for (let index = 0; index < pending.length; index += REFUND_BATCH_SIZE) {
        const chunk = pending.slice(index, index + REFUND_BATCH_SIZE);
        await sendChunk(chunk, stateManager, deps, log);
    }

    return summarize(stateManager.getState().refunds!);
}

async function sendChunk(
    chunk: RefundRecord[],
    stateManager: OrchestratorStateManager,
    deps: RefundDeps,
    log: Logger
): Promise<void> {
    // First deal with anyone who already has an unconfirmed signature: sending
    // to the same person again is a double payout from a shared remainder.
    const ready: RefundRecord[] = [];
    for (const refund of chunk) {
        if (!refund.pendingSignature) {
            ready.push(refund);
            continue;
        }
        const landed = await checkSignature(refund.pendingSignature, deps);
        if (landed === true) {
            stateManager.updateRefund(refund.id, {
                status: "completed",
                signature: refund.pendingSignature,
                pendingSignature: undefined,
            });
            log.info({ event: "refund.already_landed", refundId: refund.id }, "Refund had already landed");
            continue;
        }
        if (landed === null) {
            // We do not know whether it arrived. Leave it as it is: the next
            // pass checks again. Sending blind is not allowed.
            log.warn({ event: "refund.pending_unknown", refundId: refund.id }, "Cannot tell whether the refund landed");
            continue;
        }
        ready.push(refund);
    }

    if (ready.length === 0) {
        return;
    }

    // Paying for queue position. The refund is the last thing a round does and
    // it must not sit waiting for a block: the money has to get back to people
    // today, not when the network calms down. The ceiling is token and has
    // already been subtracted from the refund as the network fee.
    const budget = await budgetInstructions(
        "refund",
        refundComputeUnits(ready.length),
        [deps.keeper.publicKey]
    );
    const transaction = new Transaction().add(...budget);
    for (const refund of ready) {
        transaction.add(
            SystemProgram.transfer({
                fromPubkey: deps.keeper.publicKey,
                toPubkey: new PublicKey(refund.recipient),
                lamports: Math.floor(refund.amountSol * LAMPORTS_PER_SOL),
            })
        );
        stateManager.updateRefund(refund.id, { status: "in_progress", attempts: refund.attempts + 1 });
    }

    try {
        const signature = await (deps.send ?? sendTransaction)(transaction, deps.keeper);
        for (const refund of ready) {
            stateManager.updateRefund(refund.id, {
                status: "completed",
                signature,
                pendingSignature: undefined,
            });
        }
        log.info(
            {
                event: "refund.sent",
                signature,
                recipients: ready.length,
                sol: round9(ready.reduce((sum, r) => sum + r.amountSol, 0)),
            },
            `Refunded ${ready.length} participants`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A signature in the error means the transaction went out: it cannot be
        // counted as a failure, or a repeat would send the money twice.
        const signature = extractSignature(error);
        for (const refund of ready) {
            stateManager.updateRefund(refund.id, {
                status: signature ? "in_progress" : "failed",
                pendingSignature: signature ?? undefined,
                errorMessage: message,
            });
        }
        log.error(
            { event: "refund.failed", error: message, recipients: ready.length, signature },
            `Refund of ${ready.length} participants failed`
        );
    }
}

async function checkSignature(signature: string, deps: RefundDeps): Promise<boolean | null> {
    if (deps.signatureLanded) {
        return deps.signatureLanded(signature);
    }
    try {
        const status = await connection.getSignatureStatus(signature);
        const landed =
            (status.value?.confirmationStatus === "confirmed" || status.value?.confirmationStatus === "finalized") &&
            !status.value?.err;
        if (landed) {
            return true;
        }
        // No transaction at all, so it never arrived and can be sent again.
        return status.value === null ? false : !!status.value?.err;
    } catch {
        return null;
    }
}

function extractSignature(error: unknown): string | null {
    const candidate = (error as { signature?: unknown })?.signature;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function summarize(refunds: RefundRecord[]) {
    return {
        sent: refunds.filter((refund) => refund.status === "completed").length,
        skipped: refunds.filter((refund) => refund.status === "skipped").length,
        failed: refunds.filter((refund) => refund.status === "failed").length,
        solReturned: round9(
            refunds.filter((refund) => refund.status === "completed").reduce((sum, refund) => sum + refund.amountSol, 0)
        ),
    };
}

function round9(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}
