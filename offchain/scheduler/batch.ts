// scheduler/batch.ts
// The main batch purchase logic

import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { connection } from "../solana/connection";
import { buy } from "../buy";
import {
    BatchBuyParams,
    BatchBuyResult,
    PurchaseRecord,
} from "./types";
import { calculateN, calculateFees, splitAmount, ATA_FEE_SOL, BUY_TX_FEE_SOL } from "./fees";
import { createSchedule, sleepUntil, formatDuration } from "./timing";
import {
    getSlippageForAttempt,
    canRetry,
    formatSlippage,
    MAX_RETRIES,
} from "./slippage";
import {
    BatchStateManager,
    generateRunId,
    generatePurchaseId,
    getDefaultStatePath,
} from "./state";
import { classifyError, isSlippageError } from "./errors";
import { getErrorVenue } from "../solana/transaction";
import { inspectMint } from "../solana/tokenExtensions";
import { PostSendError } from "../pumpfun/buy";
import { logger as rootLogger, Logger } from "../logger";
import type { BuyResult } from "../buy";

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_WINDOW_MINUTES = 50;

/**
 * The minimum retry window. This used to be 10 minutes and served as the base
 * for a formula built on the SHARE of failures — but the work depends on their
 * COUNT: five failures out of ten and five out of a hundred take the same time
 * yet used to get different windows. Now it is simply a lower bound.
 */
const DEFAULT_RETRY_BUFFER_MINUTES = 3;

/** How much time we allow per failed purchase: up to 4 attempts. */
const RETRY_SECONDS_PER_PURCHASE = 25;

/**
 * The cap on the retry window.
 *
 * 15 rather than 10 or 20, for two reasons. Ten would be enough for
 * completeness: the worst case of a 111 SOL round is 70 coins at 1.538 SOL,
 * which is 11 purchases per coin, and 10 minutes fits up to 15 retries per
 * coin. But a short window compresses the same work and RAISES the peak load on
 * the node: with 50 coins in parallel that is ~48 RPS against ~35 at fifteen
 * minutes, and the Helius Developer plan is 50 RPS. Twenty minutes would load
 * it even less but would stretch a publicly announced round.
 */
const MAX_RETRY_WINDOW_MINUTES = 15;
const DEFAULT_START_SLIPPAGE_BPS = 300;
const DEFAULT_MAX_SLIPPAGE_BPS = 1300;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Checks the status of a previously sent tx before a retry.
 * If the tx is confirmed the purchase already happened and no retry is needed.
 * Returns the signature when the tx is confirmed, null when a retry is allowed.
 */
async function checkPendingSignature(
    error: unknown
): Promise<string | null> {
    if (!(error instanceof PostSendError) || !error.signature) {
        return null;
    }

    try {
        const status = await connection.getSignatureStatus(error.signature);
        if (
            (status.value?.confirmationStatus === "confirmed" ||
                status.value?.confirmationStatus === "finalized") &&
            // err matters: a transaction that arrived and failed on chain is
            // also "confirmed". Without this check a failure counted as a
            // purchase — the retry was switched off, the SOL stayed on the
            // keeper, and the round reported success. A slippage rejection
            // looks exactly like this, so it was the most common case.
            !status.value?.err
        ) {
            return error.signature;
        }
    } catch {
        // An RPC error during the check: safer not to retry.
        // But the blockhash has most likely expired anyway, so we skip.
    }

    return null;
}

/**
 * The transaction may have reached the network, so check before counting the
 * purchase as failed. Returns true if the signature confirmed and the purchase
 * is closed.
 *
 * Must be called BEFORE any decision to retry: otherwise a transaction that did
 * arrive gets repeated and the coin is bought twice.
 */
async function tryConfirmPending(
    error: unknown,
    purchaseIndex: number,
    stateManager: BatchStateManager,
    plog: Logger
): Promise<boolean> {
    const confirmedSig = await checkPendingSignature(error);
    if (!confirmedSig) {
        return false;
    }
    // The venue comes from the error label rather than being hardcoded:
    // PostSendError arrives from all three paths, and a purchase through DEX or
    // PumpSwap would be recorded as pumpfun — not only in the metric but in the
    // purchase record itself.
    const venue = getErrorVenue(error) ?? "pumpfun";
    stateManager.markCompleted(purchaseIndex, confirmedSig, venue);
    recordVenueRouting(stateManager, { signature: confirmedSig, venue });
    stateManager.incrementMetric("retry.pendingTxConfirmed");
    plog.info({
        event: "purchase.pending_confirmed",
        signature: confirmedSig.slice(0, 16),
    }, "Confirmed from pending tx");
    return true;
}

/**
 * The only place where a failed purchase is given a status.
 *
 * There used to be two: the general handler and the exit from the slippage
 * ladder. The second one could only `markFailed` — it did not classify the
 * error and, crucially, did not store `pendingSignature`. If a ladder attempt
 * failed with `PostSendError`, the transaction stayed in the network, the
 * signature was lost, and the retry phase bought a second time. One function
 * for both paths makes that divergence impossible.
 */
function recordPurchaseFailure(
    error: unknown,
    purchaseIndex: number,
    stateManager: BatchStateManager,
    plog: Logger
): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const classification = classifyError(error);

    stateManager.incrementMetric(`errors.${classification.errorClass}`);
    if (classification.pattern) {
        stateManager.incrementErrorPattern(classification.pattern);
    }

    if (classification.errorClass === "non-retryable") {
        stateManager.markAbandoned(purchaseIndex, errorMessage);
        stateManager.incrementMetric("retry.nonRetryableAbandon");
        plog.warn({
            event: "purchase.abandoned_non_retryable",
            errorClass: classification.errorClass,
            pattern: classification.pattern,
            error: errorMessage,
        }, `Abandoned (non-retryable: ${classification.pattern})`);
        return;
    }

    stateManager.markFailed(purchaseIndex, errorMessage);
    // The retry phase needs the signature: before repeating it checks whether
    // the transaction arrived, so it does not buy twice.
    if (error instanceof PostSendError && error.signature) {
        stateManager.updatePurchase(purchaseIndex, {
            pendingSignature: error.signature,
        });
        stateManager.incrementMetric("venueRouting.postSendErrorBlocked");
    }
    if (classification.errorClass === "unknown") {
        stateManager.incrementMetric("retry.unknownDeferred");
        plog.warn({
            event: "purchase.deferred_to_retry",
            errorClass: "unknown",
            error: errorMessage,
        }, "Failed (unknown error, will retry)");
    } else {
        stateManager.incrementMetric("retry.retryableDeferred");
        plog.info({
            event: "purchase.deferred_to_retry",
            errorClass: classification.errorClass,
            pattern: classification.pattern,
            error: errorMessage,
        }, "Failed (retryable, will retry)");
    }
}

/**
 * The keeper running out of funds.
 *
 * Kept apart from the general classification: there `insufficient funds` is
 * rightly non-retryable for DELIVERIES, but for a purchase it is fixable — the
 * balance is shared by fifty batches, and neighbours may have taken it between
 * our check and sending the transaction.
 */
function isInsufficientFunds(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("insufficient lamports") ||
        message.includes("insufficient funds") ||
        message.includes("Insufficient funds")
    );
}

/**
 * How much SOL we leave on the keeper for the costs of THIS purchase.
 *
 * ATA rent is only budgeted when the token account does not exist yet: if it
 * does, there is no need to pay for it twice, and reserving that 0.00204 would
 * mean underbuying on every purchase in the batch.
 *
 * There used to be a flat 0.002 here, less than the rent alone (0.00204). At
 * the tail of a batch, which is exactly where the shrinking kicks in, a
 * purchase was shrunk to an amount too small to create the account, and failed.
 *
 * The reserve stays a per-purchase calculation rather than a per-round one: the
 * keeper is shared by fifty batches and each one only sees its own. There is no
 * way to estimate the others' needs from here, so what protects against the
 * race for the shared balance is not this number but the recovery from
 * `insufficient funds` in the main loop.
 *
 * We count the PURCHASE fee, not the general one: since 2026-09-19 a purchase
 * also pays for its place in the block, up to 0.0001 SOL on top of the base
 * fee. With the old constant (0.00001) a shrunk purchase would take for itself
 * the money it still has to pay for its own sending, and fail again.
 */
function keeperFloorSol(needsAta: boolean): number {
    return (needsAta ? ATA_FEE_SOL : 0) + 2 * BUY_TX_FEE_SOL;
}

/** Below this a purchase is pointless: the fees would eat it whole. */
const MIN_PURCHASE_SOL = 0.001;

/**
 * How much can actually be spent on this purchase.
 *
 * The amounts are fixed in PHASE 1 and know nothing about what the balance is
 * doing. If slippage ate more than planned, there is not enough left for the
 * tail, and the transaction fails with `insufficient lamports` — which is
 * non-retryable, so the purchase is dropped without a single attempt. Worse,
 * the following purchases are planned at the same amounts and fail the same
 * way: one shortfall used to carry off the whole rest of the batch.
 *
 * So instead of refusing we shrink the purchase to fit what is there.
 *
 * @returns the amount to buy with, or null if there is no money left at all
 */
async function resolveSpendableAmount(
    keeper: PublicKey,
    scheduled: number,
    needsAta: boolean
): Promise<number | null> {
    let balanceSol: number;
    try {
        balanceSol = (await connection.getBalance(keeper)) / LAMPORTS_PER_SOL;
    } catch {
        // The balance could not be read: do not block the purchase, let the network decide.
        return scheduled;
    }

    const spendable = balanceSol - keeperFloorSol(needsAta);
    if (spendable >= scheduled) {
        return scheduled;
    }
    if (spendable < MIN_PURCHASE_SOL) {
        return null;
    }
    // No headroom for slippage is needed here: on both paths the spend now
    // strictly equals the amount passed in. `buy_exact_sol_in` debits exactly
    // `spendable_sol_in` (subtracting the fee inside), and Jupiter works
    // exact-in on the input SOL — in both cases slippage bounds the minimum
    // tokens RECEIVED, not the maximum debited.
    // Verified with live transactions on 2026-08-29: both on the curve and
    // through Raydium a purchase took exactly 0.01 SOL at 300 bps slippage.
    // Round down to the lamport, so we never ask for more than there is.
    return Math.floor(spendable * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
}

/**
 * Checks whether the keeper's ATA exists.
 */
async function checkAtaExists(
    mint: PublicKey,
    owner: PublicKey
): Promise<boolean> {
    try {
        const mintInfo = await connection.getAccountInfo(mint);
        if (!mintInfo) {
            return false;
        }
        const tokenProgramId = mintInfo.owner;
        const ata = getAssociatedTokenAddressSync(
            mint,
            owner,
            false,
            tokenProgramId
        );
        const account = await connection.getAccountInfo(ata);
        return account !== null;
    } catch {
        return false;
    }
}

function recordVenueRouting(
    stateManager: BatchStateManager,
    result: BuyResult
): void {
    if (result.fallback && result.venue === "pumpswap") {
        stateManager.incrementMetric("venueRouting.fallbackToPumpswap");
    } else if (result.fallback) {
        stateManager.incrementMetric("venueRouting.fallbackToDex");
    } else if (result.venue === "pumpfun") {
        stateManager.incrementMetric("venueRouting.pumpfunDirect");
    } else {
        stateManager.incrementMetric("venueRouting.dexDirect");
    }
}

// logProgress removed — replaced by structured pino events

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Buys a token in a batch, spread out over time.
 *
 * The algorithm:
 * 1. Works out N purchases from the total amount
 * 2. Subtracts the fees (ATA, transactions)
 * 3. Splits the amount between the purchases with randomisation
 * 4. Builds a schedule with random intervals
 * 5. Runs the purchases in the main window
 * 6. Retries the failed ones in the buffer window
 * 7. Saves state to JSON after every operation
 *
 * @param params - the batch purchase parameters
 * @returns the result with a summary and the path to the state file
 *
 * @example
 * const result = await batchBuy({
 *     mint: new PublicKey("..."),
 *     totalSolAmount: 5,
 *     keeper: myKeypair,
 * });
 * console.log(result.summary.completedPurchases);
 */
export async function batchBuy(params: BatchBuyParams): Promise<BatchBuyResult> {
    const {
        mint,
        totalSolAmount,
        keeper,
        windowMinutes = DEFAULT_WINDOW_MINUTES,
        retryBufferMinutes = DEFAULT_RETRY_BUFFER_MINUTES,
        startSlippageBps = DEFAULT_START_SLIPPAGE_BPS,
        maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS,
    } = params;

    // ==========================================================================
    // PHASE 1: INITIALIZATION
    // ==========================================================================

    // Generate the IDs
    const runId = generateRunId();
    const stateFilePath = params.stateFilePath || getDefaultStatePath(runId);

    // A child logger carrying the batch context
    const log = (params.logger || rootLogger).child({ runId, mint: mint.toBase58().slice(0, 8) });

    // Work out N
    const n = calculateN(totalSolAmount);

    // Delivering what we buy has to be physically possible. We check BEFORE
    // spending anything: SOL on the keeper can be returned, but a token that
    // cannot be transferred stays there forever. Trading a refundable asset for
    // an unrefundable one is the worst outcome available.
    const extensions = await inspectMint(mint, log);
    if (extensions.blockers.length) {
        log.error({
            event: "batch.mint_not_distributable",
            mint: mint.toBase58(),
            blockers: extensions.blockers,
        }, `Refusing to buy: ${extensions.blockers.join("; ")}`);
        throw new Error(
            `Mint cannot be distributed to winners: ${extensions.blockers.join("; ")}`
        );
    }

    // Check the ATA
    const hasAta = await checkAtaExists(mint, keeper.publicKey);

    // Work out the fees
    const fees = calculateFees(totalSolAmount, n, hasAta);

    // Split the amounts
    const amounts = splitAmount(fees.netAmount, n);
    const avgAmount = fees.netAmount / n;

    // Build the schedule
    const startTime = Date.now();
    const scheduledTimes = createSchedule(n, startTime, windowMinutes);

    // Create the purchase records
    const purchases: PurchaseRecord[] = amounts.map((amount, i) => ({
        id: generatePurchaseId(i + 1, runId),
        index: i + 1,
        scheduledAt: scheduledTimes[i],
        solAmount: amount,
        status: "pending" as const,
        attempts: 0,
        updatedAt: Date.now(),
    }));

    // Initialise the state manager
    const stateManager = BatchStateManager.create(
        runId,
        mint.toBase58(),
        totalSolAmount,
        purchases,
        {
            windowMinutes,
            retryBufferMinutes,
            startSlippageBps,
            maxSlippageBps,
        },
        stateFilePath
    );

    log.info({
        event: "batch.init",
        stateFilePath,
        purchases: n,
        hasAta,
        totalFees: fees.totalFees,
        netAmount: fees.netAmount,
        avgPerPurchase: avgAmount,
        windowMinutes,
        retryBufferMinutes,
    }, "Batch buy initialized");

    // ==========================================================================
    // PHASE 2: MAIN PURCHASE LOOP
    // ==========================================================================

    // Set when the balance was not even enough for a minimum purchase.
    let keeperDrained = false;

    for (let i = 0; i < purchases.length; i++) {
        const purchase = purchases[i];
        const plog = log.child({ purchaseIndex: purchase.index });
        const timeUntil = purchase.scheduledAt - Date.now();

        if (timeUntil > 0) {
            plog.debug({ event: "purchase.waiting", waitMs: timeUntil }, `Waiting ${formatDuration(timeUntil)}`);
            await sleepUntil(purchase.scheduledAt);
        }

        // The keeper already ran dry on an earlier purchase: do not spend an
        // attempt. The signal is local, with no call to the node: within this
        // batch the money cannot come from anywhere, and without it every
        // remaining purchase would burn a transaction for nothing.
        if (keeperDrained) {
            stateManager.markAbandoned(
                purchase.index,
                "Keeper balance exhausted before this purchase"
            );
            stateManager.incrementMetric("balance.abandonedEmpty");
            continue;
        }

        // We deliberately do NOT read the balance up front. Shrinking is only
        // needed on an almost empty keeper, that is in the rare tail of a
        // round, while the request would cost 1 of the 8 calls to the node on
        // EVERY purchase — about 12% of the peak load in the retry window,
        // which is exactly where we approach the plan's limit.
        //
        // An early check would not help much anyway: the keeper is shared by
        // fifty batches, and between reading the balance and sending it can be
        // taken by neighbours. So we would pay for a check that guarantees
        // nothing. Instead we recover from an actual `insufficient funds` in
        // the error handler below, where the balance is re-read once and only
        // when it is really needed.
        const slippage = getSlippageForAttempt(1, startSlippageBps, maxSlippageBps);
        // The amount for this purchase. It changes if we had to shrink to fit
        // the remainder, and every later attempt must then use the new one.
        let spendable = purchase.solAmount;

        // Make the purchase
        stateManager.markInProgress(purchase.index, slippage);

        plog.info({
            event: "purchase.buying",
            solAmount: spendable,
            slippageBps: slippage,
            progress: `${purchase.index}/${n}`,
        }, `Buying ${spendable.toFixed(6)} SOL`);

        try {
            const result = await buy(mint, spendable, keeper, slippage, plog);
            stateManager.markCompleted(
                purchase.index,
                result.signature,
                result.venue
            );

            recordVenueRouting(stateManager, result);

            plog.info({
                event: "purchase.completed",
                venue: result.venue,
                fallback: result.fallback || false,
                signature: result.signature.slice(0, 16),
                progress: `${purchase.index}/${n}`,
            }, `Completed via ${result.venue}`);
        } catch (error) {
            // The error we will end up keeping: the slippage ladder below may
            // replace it with its own, later one.
            let failure: unknown = error;

            // PostSendError with a signature: check, the tx may already have gone through
            if (await tryConfirmPending(failure, purchase.index, stateManager, plog)) {
                continue;
            }

            // Out of money. This used to be a death sentence: `insufficient
            // funds` is classified as non-retryable and the purchase was
            // dropped for good. But the keeper is shared by fifty batches, so
            // the remainder may have been taken by neighbours. We read the
            // balance — once, and only now that it is really needed — and
            // shrink to what is actually there.
            if (isInsufficientFunds(failure)) {
                const shrunk = await resolveSpendableAmount(
                    keeper.publicKey,
                    spendable,
                    !hasAta
                );
                if (shrunk === null) {
                    // Not even enough on the keeper for a minimum purchase.
                    // Nothing to retry with: the money will not appear by itself.
                    keeperDrained = true;
                    stateManager.markAbandoned(
                        purchase.index,
                        "Keeper balance exhausted before this purchase"
                    );
                    stateManager.incrementMetric("balance.abandonedEmpty");
                    plog.warn({
                        event: "purchase.abandoned_no_balance",
                        scheduled: purchase.solAmount,
                    }, "Abandoned: keeper has nothing left to spend");
                    continue;
                }
                if (shrunk < spendable) {
                    stateManager.incrementMetric("balance.shrunkAfterFailure");
                    stateManager.incrementMetric("balance.shrunkToFit");
                    plog.warn({
                        event: "purchase.shrunk_after_insufficient_funds",
                        attempted: spendable,
                        retryWith: shrunk,
                    }, `Insufficient funds at ${spendable.toFixed(6)}, retrying with ${shrunk.toFixed(6)} SOL`);
                    stateManager.updatePurchase(purchase.index, {
                        plannedSolAmount: purchase.plannedSolAmount ?? purchase.solAmount,
                        solAmount: shrunk,
                    });
                    // From here this purchase lives with the shrunk amount: the
                    // slippage ladder below has to take that one, not the
                    // original, or it would repeat an amount that cannot fit.
                    spendable = shrunk;
                    stateManager.markInProgress(purchase.index, slippage);
                    try {
                        const result = await buy(mint, spendable, keeper, slippage, plog);
                        stateManager.markCompleted(
                            purchase.index,
                            result.signature,
                            result.venue
                        );
                        recordVenueRouting(stateManager, result);
                        plog.info({
                            event: "purchase.completed",
                            venue: result.venue,
                            shrunkAfterFailure: true,
                            signature: result.signature.slice(0, 16),
                        }, `Completed via ${result.venue} after shrinking`);
                        continue;
                    } catch (shrunkError) {
                        // It did not help: on through the general path, with the new error.
                        failure = shrunkError;
                        if (await tryConfirmPending(failure, purchase.index, stateManager, plog)) {
                            continue;
                        }
                    }
                }
            }

            // A slippage error → climb the ladder right here instead of
            // deferring to the retry phase. The point is that a purchase is
            // scheduled for a particular moment: postpone it by half an hour
            // and the candle does not appear when it was needed. On live coins
            // 5% is often not enough, so we go up to the third step (900 bps)
            // and leave the last one (1300) to the retry phase — by then the
            // spike may have died down, and there the ladder starts again from
            // 300 to catch a cheap fill.
            //
            // "Instantly" is relative here: every attempt includes building a
            // transaction and waiting for confirmation, so it takes seconds.
            if (isSlippageError(failure)) {
                let instantDone = false;
                let lastError: unknown = failure;

                for (const attempt of [2, 3]) {
                    const instantSlippage = getSlippageForAttempt(
                        attempt,
                        startSlippageBps,
                        maxSlippageBps
                    );
                    stateManager.incrementMetric("retry.slippageInstantRetry");
                    plog.warn({
                        event: "purchase.slippage_retry",
                        attempt,
                        toBps: instantSlippage,
                    }, `Slippage error, instant retry at ${formatSlippage(instantSlippage)}`);
                    stateManager.markInProgress(purchase.index, instantSlippage);

                    try {
                        // The same shrunk amount: the balance has not grown since the last attempt.
                        const result = await buy(mint, spendable, keeper, instantSlippage, plog);
                        stateManager.markCompleted(
                            purchase.index,
                            result.signature,
                            result.venue
                        );
                        stateManager.incrementMetric("retry.slippageInstantRetrySuccess");
                        recordVenueRouting(stateManager, result);
                        plog.info({
                            event: "purchase.completed",
                            venue: result.venue,
                            instantRetry: true,
                            slippageBps: instantSlippage,
                            signature: result.signature.slice(0, 16),
                        }, `Completed via ${result.venue} (instant retry at ${formatSlippage(instantSlippage)})`);
                        instantDone = true;
                        break;
                    } catch (retryError) {
                        lastError = retryError;
                        // Not slippage — raising the ceiling further is pointless
                        if (!isSlippageError(retryError)) {
                            break;
                        }
                    }
                }

                if (instantDone) {
                    continue;
                }

                // From here the general handler decides, and it decides on the
                // LAST error of the ladder rather than the first: that one may
                // carry the signature of a transaction that flew, or be
                // non-retryable.
                failure = lastError;

                // The check comes BEFORE the failure counter: the last attempt
                // may have arrived, and then there is no failure to count.
                if (await tryConfirmPending(failure, purchase.index, stateManager, plog)) {
                    continue;
                }

                stateManager.incrementMetric("retry.slippageInstantRetryFail");
                plog.warn({
                    event: "purchase.slippage_retry_failed",
                    error: lastError instanceof Error ? lastError.message : String(lastError),
                }, "Instant retries exhausted, deferring to retry phase");
            }

            recordPurchaseFailure(failure, purchase.index, stateManager, plog);
        }
    }

    // ==========================================================================
    // PHASE 3: RETRY BUFFER
    // ==========================================================================

    const failedPurchases = stateManager.getFailedPurchases();

    if (failedPurchases.length > 0) {
        // The window is computed from the NUMBER of failures, not their share:
        // the work depends on how many purchases have to be repeated, not on
        // what fraction they are. The old formula gave 10 minutes for three
        // failures (under two are needed) and only 20 for a hundred (up to an
        // hour is needed) — generous where pennies would do and stingy where it
        // did not help.
        const adaptiveRetryWindowMinutes = Math.min(
            MAX_RETRY_WINDOW_MINUTES,
            Math.max(
                retryBufferMinutes,
                Math.ceil(
                    (failedPurchases.length * RETRY_SECONDS_PER_PURCHASE) / 60
                )
            )
        );

        log.info({
            event: "batch.retry_start",
            failedCount: failedPurchases.length,
            failedRate: Math.round((failedPurchases.length / n) * 100),
            retryWindowMinutes: adaptiveRetryWindowMinutes,
        }, `Retry buffer: ${adaptiveRetryWindowMinutes} min, ${failedPurchases.length} failed`);

        // Spread the retries across the buffer window (one wait per purchase)
        const retryWindowMs = adaptiveRetryWindowMinutes * 60 * 1000;
        const retryStart = Date.now();
        const retryEnd = retryStart + retryWindowMs;
        const retryInterval = retryWindowMs / (failedPurchases.length + 1);

        for (let i = 0; i < failedPurchases.length; i++) {
            const purchase = failedPurchases[i];
            const targetTime = retryStart + (i + 1) * retryInterval;

            if (Date.now() < targetTime) {
                await sleepUntil(targetTime);
            }

            const rlog = log.child({ purchaseIndex: purchase.index });

            // Check the pending signature: the tx may have confirmed since the main loop
            if (purchase.pendingSignature) {
                try {
                    const status = await connection.getSignatureStatus(purchase.pendingSignature);
                    if (
                        (status.value?.confirmationStatus === "confirmed" ||
                            status.value?.confirmationStatus === "finalized") &&
                        // See checkPendingSignature: confirmed without checking
                        // err means "failed on chain", not "bought".
                        !status.value?.err
                    ) {
                        stateManager.markCompleted(
                            purchase.index,
                            purchase.pendingSignature,
                            purchase.venue ?? "pumpfun"
                        );
                        stateManager.incrementMetric("retry.pendingTxConfirmed");
                        rlog.info({
                            event: "purchase.pending_confirmed",
                            signature: purchase.pendingSignature.slice(0, 16),
                            phase: "retry",
                        }, "Confirmed from pending tx");
                        continue;
                    }
                } catch {
                    // The check failed: carry on with the retry
                }
            }

            // The retry phase starts at attempt 1, regardless of the main loop
            let retryAttempts = 0;

            while (canRetry(retryAttempts)) {
                if (Date.now() > retryEnd) {
                    stateManager.markAbandoned(
                        purchase.index,
                        "Retry window expired"
                    );
                    stateManager.incrementMetric("retry.windowExpiredAbandon");
                    rlog.warn({ event: "purchase.abandoned_window_expired" }, "Abandoned (retry window expired)");
                    break;
                }

                retryAttempts++;
                const slippage = getSlippageForAttempt(
                    retryAttempts,
                    startSlippageBps,
                    maxSlippageBps
                );

                // By now the balance may have dropped because of other
                // purchases, so we recompute before every attempt.
                // Here we read the balance UP FRONT, unlike the main loop, and
                // the reason is not caution but the different cost of a
                // mistake. The main loop has time to spare: a burnt attempt
                // costs nothing, so it is cheaper not to ask. The retry window
                // is capped at fifteen minutes and attempts inside it are
                // scarce: wasting one costs more than one call to the node.
                // Drop the check and, if even every tenth retry loses an
                // attempt, the saved requests are cancelled out.
                const retrySpendable = await resolveSpendableAmount(
                    keeper.publicKey,
                    purchase.solAmount,
                    !hasAta
                );
                if (retrySpendable === null) {
                    stateManager.markAbandoned(
                        purchase.index,
                        "Keeper balance exhausted before retry"
                    );
                    stateManager.incrementMetric("balance.abandonedEmpty");
                    rlog.warn({ event: "purchase.abandoned_no_balance", phase: "retry" },
                        "Abandoned: keeper has nothing left to spend");
                    break;
                }
                if (retrySpendable < purchase.solAmount) {
                    stateManager.updatePurchase(purchase.index, {
                        plannedSolAmount:
                            purchase.plannedSolAmount ?? purchase.solAmount,
                        solAmount: retrySpendable,
                    });
                    stateManager.incrementMetric("balance.shrunkToFit");
                }

                stateManager.markInProgress(purchase.index, slippage);
                rlog.info({
                    event: "purchase.retry_attempt",
                    attempt: retryAttempts,
                    solAmount: retrySpendable,
                    slippageBps: slippage,
                }, `Retry #${retryAttempts}, slippage: ${formatSlippage(slippage)}`);

                try {
                    const result = await buy(
                        mint,
                        retrySpendable,
                        keeper,
                        slippage,
                        rlog
                    );
                    stateManager.markCompleted(
                        purchase.index,
                        result.signature,
                        result.venue
                    );
                    stateManager.incrementMetric("retry.retrySuccess");

                    recordVenueRouting(stateManager, result);

                    rlog.info({
                        event: "purchase.retry_success",
                        venue: result.venue,
                        attempt: retryAttempts,
                        signature: result.signature.slice(0, 16),
                    }, `Retry succeeded via ${result.venue}`);
                    break; // Success — leave the retry loop
                } catch (retryError) {
                    // Check the pending signature from the retry
                    const retryConfirmedSig = await checkPendingSignature(retryError);
                    if (retryConfirmedSig) {
                        stateManager.markCompleted(
                            purchase.index,
                            retryConfirmedSig,
                            getErrorVenue(retryError) ?? purchase.venue ?? "pumpfun"
                        );
                        stateManager.incrementMetric("retry.pendingTxConfirmed");
                        rlog.info({
                            event: "purchase.pending_confirmed",
                            signature: retryConfirmedSig.slice(0, 16),
                            phase: "retry",
                        }, "Confirmed from pending tx (retry)");
                        break;
                    }

                    const retryErrorMessage =
                        retryError instanceof Error ? retryError.message : String(retryError);
                    const retryClassification = classifyError(retryError);

                    // Error counters
                    stateManager.incrementMetric(`errors.${retryClassification.errorClass}`);
                    if (retryClassification.pattern) {
                        stateManager.incrementErrorPattern(retryClassification.pattern);
                    }

                    // Store the pending signature for the next retry
                    if (retryError instanceof PostSendError && retryError.signature) {
                        stateManager.updatePurchase(purchase.index, {
                            pendingSignature: retryError.signature,
                        });
                    }

                    // Non-retryable during a retry — abandon at once
                    if (retryClassification.errorClass === "non-retryable") {
                        stateManager.markAbandoned(purchase.index, retryErrorMessage);
                        stateManager.incrementMetric("retry.nonRetryableAbandon");
                        rlog.warn({
                            event: "purchase.abandoned_non_retryable",
                            pattern: retryClassification.pattern,
                            error: retryErrorMessage,
                            phase: "retry",
                        }, `Abandoned (non-retryable: ${retryClassification.pattern})`);
                        break;
                    }

                    if (retryAttempts > MAX_RETRIES) {
                        stateManager.markAbandoned(purchase.index, retryErrorMessage);
                        stateManager.incrementMetric("retry.maxAttemptsAbandon");
                        rlog.warn({
                            event: "purchase.abandoned_max_attempts",
                            attempts: retryAttempts,
                            error: retryErrorMessage,
                        }, `Abandoned after ${retryAttempts} attempts`);
                    } else {
                        stateManager.markFailed(purchase.index, retryErrorMessage);
                        rlog.warn({
                            event: "purchase.retry_failed",
                            attempt: retryAttempts,
                            errorClass: retryClassification.errorClass,
                            error: retryErrorMessage,
                        }, `Retry #${retryAttempts} failed (${retryClassification.errorClass})`);
                    }
                }
            }

            // Still failed after every retry — mark it abandoned
            const updatedPurchase = stateManager.getPurchase(purchase.index);
            if (updatedPurchase?.status === "failed") {
                stateManager.markAbandoned(
                    purchase.index,
                    updatedPurchase.errorMessage || "Max retries exceeded"
                );
            }
        }
    }

    // ==========================================================================
    // PHASE 4: FINALIZE
    // ==========================================================================

    stateManager.finalize();
    const finalState = stateManager.getState();

    const duration = finalState.summary.finishedAt && finalState.summary.startedAt
        ? finalState.summary.finishedAt - finalState.summary.startedAt
        : undefined;

    log.info({
        event: "batch.complete",
        completed: finalState.summary.completedPurchases,
        total: n,
        abandoned: finalState.summary.abandonedPurchases,
        totalSolSpent: finalState.summary.totalSolSpent,
        durationMs: duration,
    }, `Batch complete: ${finalState.summary.completedPurchases}/${n}, spent ${finalState.summary.totalSolSpent.toFixed(6)} SOL`);

    return {
        runId,
        stateFilePath,
        summary: finalState.summary,
    };
}
