// orchestrator/orchestrator.ts
// executeLottery — main entry point for Layer 3

import { Keypair, PublicKey } from "@solana/web3.js";
import { batchBuy } from "../scheduler";
import { classifyError } from "../scheduler/errors";
import { logger as rootLogger, Logger } from "../logger";
import { Semaphore } from "./semaphore";
import { calculateSendReserve, distributeBuyBudget } from "./fees";
import {
    calculateSendN,
    generateSendRecords,
    executeSendRounds,
    sleep,
    snapshotRecipientAtas,
    MAX_SEND_ATTEMPTS,
} from "./sendRounds";
import { OrchestratorStateManager, batchStatePath, getDefaultLotteryStatePath } from "./state";
import { refundUnspent } from "./refunds";
import {
    ExecuteLotteryParams,
    LotteryState,
    LotteryResult,
    TokenBuyRecord,
} from "./types";

/**
 * Pauses between sweep passes. The first is immediate, then they grow: a
 * temporary glitch (a node blinking, a 429) usually passes within two minutes,
 * while an instant retry would hit the same wall.
 */
const SWEEP_DELAYS_MS = [0, 30_000, 120_000];

// =============================================================================
// DEFAULTS
// =============================================================================

/**
 * The defaults.
 *
 * The buying window and the number of delivery passes can be changed through
 * environment variables. That is for devnet: a purchase there cannot succeed
 * (neither pump.fun nor Jupiter exist on devnet) and waiting fifty minutes to
 * test refunds is pointless. In production the variables are unset and the
 * original numbers apply.
 */
function envNumber(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_BUY_CONCURRENCY = envNumber("BUY_CONCURRENCY", 50);
const DEFAULT_SEND_CONCURRENCY = envNumber("SEND_CONCURRENCY", 20);
const DEFAULT_BUY_WINDOW_MINUTES = envNumber("BUY_WINDOW_MINUTES", 50);
const DEFAULT_SEND_ROUNDS = envNumber("SEND_ROUNDS", 10);
// The send interval is buyWindowMinutes / sendRounds

// =============================================================================
// EXECUTE LOTTERY
// =============================================================================

export async function executeLottery(
    params: ExecuteLotteryParams
): Promise<LotteryResult> {
    const {
        lotteryId,
        tokens,
        keeper,
        buyConcurrency = DEFAULT_BUY_CONCURRENCY,
        sendConcurrency = DEFAULT_SEND_CONCURRENCY,
        buyWindowMinutes = DEFAULT_BUY_WINDOW_MINUTES,
        sendRounds = DEFAULT_SEND_ROUNDS,
        sleepFn = sleep,
    } = params;

    const stateFilePath =
        params.stateFilePath || getDefaultLotteryStatePath(lotteryId);

    const log = (params.logger || rootLogger).child({ lotteryId });

    log.info({
        event: "lottery.start",
        tokens: tokens.length,
        buyConcurrency,
        sendConcurrency,
        sendRounds,
        stateFilePath,
    }, "Lottery started");

    // =========================================================================
    // PHASE 1: PREPARATION
    // =========================================================================

    // Snapshot ATAs for recipients with <1 SOL bets (fraud guard)
    const ataSnapshot = await snapshotRecipientAtas(tokens, sendConcurrency);

    // Generate send records
    const sends = generateSendRecords(tokens, sendRounds, ataSnapshot);

    // Calculate send reserve (per unique mint:recipient pair, conservative)

    const uniqueRecipients = new Map<string, { sendN: number; hasAta: boolean }>();
    for (const s of sends) {
        const key = `${s.mint}:${s.recipient}`;
        const prev = uniqueRecipients.get(key);
        if (prev) {
            prev.sendN += 1;
        } else {
            uniqueRecipients.set(key, {
                sendN: 1,
                hasAta: s.hadAtaAtStart === true,
            });
        }
    }
    const uniqueRecipientValues = Array.from(uniqueRecipients.values());
    const sendReserve = calculateSendReserve(uniqueRecipientValues);
    const ataReserveCount = uniqueRecipientValues.filter((r) => !r.hasAta).length;

    const totalSol = tokens.reduce((s, t) => s + t.totalSol, 0);
    const buyBudget = Math.max(0, totalSol - sendReserve);

    log.info({
        event: "lottery.prepared",
        totalSol,
        totalSends: sends.length,
        uniqueRecipients: uniqueRecipients.size,
        ataReserveCount,
        sendReserve,
        buyBudget,
    }, `Prepared: ${totalSol.toFixed(4)} SOL, ${sends.length} sends, budget ${buyBudget.toFixed(4)}`);

    // Distribute buy budget
    const adjustedAmounts = distributeBuyBudget(tokens, buyBudget);

    // Create token buy records
    const tokenBuys: TokenBuyRecord[] = tokens.map((t, i) => ({
        mint: t.mint.toBase58(),
        adjustedSolAmount: adjustedAmounts[i],
        status: "pending" as const,
        updatedAt: Date.now(),
    }));

    // Initialize state
    const initialState: LotteryState = {
        lotteryId,
        totalSol,
        sendReserve,
        buyBudget,
        config: { buyConcurrency, sendConcurrency, buyWindowMinutes, sendRounds },
        tokenBuys,
        sends,
        summary: {
            tokensBought: 0,
            tokensFailed: 0,
            sendsTotal: sends.length,
            sendsCompleted: 0,
            sendsSatisfied: 0,
            sendsAbandoned: 0,
            sendsAtaMismatch: 0,
            startedAt: Date.now(),
        },
    };

    const stateManager = OrchestratorStateManager.create(
        initialState,
        stateFilePath
    );

    return runBuyAndSend({
        stateManager,
        plan: tokens.map((token, index) => ({
            mint: token.mint,
            solAmount: adjustedAmounts[index],
        })),
        keeper,
        buyConcurrency,
        sendConcurrency,
        buyWindowMinutes,
        sendRounds,
        sleepFn,
        stateFilePath,
        log,
        tokensTotal: tokens.length,
    });
}

// =============================================================================
// PHASES 2-3: the shared path for a first run and for recovery
// =============================================================================

/**
 * The parameters of a buy-and-deliver run.
 *
 * A separate function, because after the process dies the work is exactly the
 * same: buy what was not bought, deliver what was not delivered, sweep up the
 * tails and close the round. Duplicating this code would mean fixing it in two
 * places later.
 */
export interface RunBuyAndSendParams {
    stateManager: OrchestratorStateManager;
    plan: BuyPlanItem[];
    keeper: Keypair;
    buyConcurrency: number;
    sendConcurrency: number;
    buyWindowMinutes: number;
    sendRounds: number;
    sleepFn: (ms: number) => Promise<void>;
    stateFilePath: string;
    log: Logger;
    tokensTotal: number;
}

export async function runBuyAndSend(params: RunBuyAndSendParams): Promise<LotteryResult> {
    const {
        stateManager,
        plan,
        keeper,
        buyConcurrency,
        sendConcurrency,
        buyWindowMinutes,
        sendRounds,
        sleepFn,
        stateFilePath,
        log,
        tokensTotal,
    } = params;
    const lotteryId = stateManager.getState().lotteryId;

    // =========================================================================
    // PHASE 2: PARALLEL BUY + SEND
    // =========================================================================

    const startTime = Date.now();

    log.info({ event: "lottery.phase2_start" }, "Starting parallel buy + send");

    // Whatever happens during buying and delivery, the round must reach the
    // refund: somebody else's SOL is sitting on the keeper, and failing here
    // would quietly leave it there. We do not swallow the error, it surfaces
    // after phase 2.9.
    let phaseError: unknown = null;

    try {
        await Promise.all([
            buyLoop(
                plan,
                keeper,
                buyConcurrency,
                buyWindowMinutes,
                stateManager,
                log
            ),
            executeSendRounds({
                keeper,
                stateManager,
                totalRounds: sendRounds,
                intervalMs: (buyWindowMinutes / sendRounds) * 60 * 1000,
                sendConcurrency,
                startTime,
                logger: log,
            }),
        ]);

        // =========================================================================
        // PHASE 2.5: SWEEP — delivering everything that did not reach recipients
        //
        // 1. Tokens bought during the retry phase (sends stayed pending, balance was 0)
        // 2. Sends that failed with a retryable error (429, timeout) → reset to pending

        /**
         * Puts deliveries that failed for a temporary reason back in the queue.
         *
         * Called BEFORE EVERY pass, not once before the loop. The reset used to
         * sit outside, and the second and third passes were useless: inside
         * `executeSendRounds` with `totalRounds: 1` the condition
         * `round < totalRounds` is false, so a failed delivery immediately
         * became `abandoned` again, and the next iteration filtered on
         * `pending` and found nothing. The 30s and 120s pauses only worked for
         * deliveries stuck on a zero balance, when they were meant for exactly
         * the 429 and the blinking node.
         *
         * We do not reset the attempt counter and we respect the shared limit:
         * otherwise the sweep would get around MAX_SEND_ATTEMPTS by requeueing
         * deliveries that had used up their attempts.
         */
        const revivePendingSends = (): number => {
            let revived = 0;
            for (const s of stateManager.getState().sends) {
                if (s.status !== "abandoned" || !s.errorMessage) {
                    continue;
                }
                if (s.attempts >= MAX_SEND_ATTEMPTS) {
                    continue;
                }
                const { errorClass } = classifyError(new Error(s.errorMessage));
                if (errorClass !== "non-retryable") {
                    stateManager.updateSend(s.id, { status: "pending" });
                    stateManager.incrementMetric("sweep.resetToPending");
                    revived++;
                }
            }
            return revived;
        };

        const firstRevived = revivePendingSends();
        const pendingAfterReset = stateManager.getState().sends.filter(
            (s) => s.status === "pending"
        );

        if (pendingAfterReset.length > 0) {
            log.info({
                event: "lottery.sweep_start",
                pendingCount: pendingAfterReset.length,
                resetFromAbandoned: firstRevived,
            }, `Sweep: ${pendingAfterReset.length} pending sends (${firstRevived} reset)`);

            // Three passes with a growing pause. A single immediate pass hit
            // the same wall a second later: if the node blinked or a 429 came
            // back, a second changes nothing. Within two minutes a temporary
            // cause usually clears by itself.
            for (const [pass, delayMs] of SWEEP_DELAYS_MS.entries()) {
                // The first pass works with what the reset above returned;
                // after that we requeue whatever failed on the previous pass.
                const revived = pass === 0 ? firstRevived : revivePendingSends();
                const stillPending = stateManager
                    .getState()
                    .sends.filter((s) => s.status === "pending");
                if (stillPending.length === 0) {
                    break;
                }
                if (delayMs > 0) {
                    log.info({
                        event: "lottery.sweep_wait",
                        delayMs,
                        pendingCount: stillPending.length,
                        revived,
                    }, `Sweep: ${stillPending.length} left, waiting ${delayMs / 1000}s`);
                    await sleepFn(delayMs);
                }
                await executeSendRounds({
                    keeper,
                    stateManager,
                    totalRounds: 1,
                    intervalMs: 0,
                    sendConcurrency,
                    startTime: Date.now() - 1,
                    isSweep: true,
                    logger: log,
                });
            }
        }
    } catch (error) {
        phaseError = error;
        log.error({
            event: "lottery.phase2_failed",
            error: error instanceof Error ? error.message : String(error),
        }, "Buy and send phase broke off; going on to refunds");
    }

    // =========================================================================
    // PHASE 2.9: RETURNING THE UNSPENT SOL
    //
    // The promise was one thing: the SOL goes into buying the named coins.
    // Whatever could not be spent goes back to the people who put it in, minus
    // the network fee. Otherwise somebody else's money quietly stays on the
    // keeper wallet.

    try {
        const spentByMint = new Map<string, number>();
        for (const token of stateManager.getState().tokenBuys ?? []) {
            spentByMint.set(token.mint, token.spentSol ?? 0);
        }
        const refunded = await refundUnspent(stateManager, spentByMint, { keeper, logger: log });
        if (refunded.sent > 0 || refunded.failed > 0) {
            log.warn({ event: "lottery.refunds", ...refunded }, `Refunds: ${refunded.sent} sent, ${refunded.failed} failed, ${refunded.solReturned} SOL returned`);
        }
    } catch (error) {
        // A refund must not stop the round from closing: token delivery has
        // already happened, and unsent refunds stay in the state and go out on
        // the next recovery pass.
        log.error(
            { event: "lottery.refunds_failed", error: error instanceof Error ? error.message : String(error) },
            "Refund phase failed"
        );
    }

    // =========================================================================
    // PHASE 3: FINALIZE
    // =========================================================================

    stateManager.finalize();
    const finalState = stateManager.getState();

    // The refund ran and the state is written — now we can fail honestly.
    // The phase worker sees it above and turns it into an alert.
    if (phaseError) {
        throw phaseError;
    }

    const sendsDelivered =
        finalState.summary.sendsCompleted + finalState.summary.sendsSatisfied;

    log.info({
        event: "lottery.complete",
        tokensBought: finalState.summary.tokensBought,
        tokensTotal,
        tokensFailed: finalState.summary.tokensFailed,
        sendsCompleted: finalState.summary.sendsCompleted,
        sendsSatisfied: finalState.summary.sendsSatisfied,
        sendsDelivered,
        sendsTotal: finalState.summary.sendsTotal,
        sendsAbandoned: finalState.summary.sendsAbandoned,
        sendsAtaMismatch: finalState.summary.sendsAtaMismatch,
    }, `Lottery complete: ${finalState.summary.tokensBought}/${tokensTotal} bought, ${sendsDelivered}/${finalState.summary.sendsTotal} delivered (${finalState.summary.sendsCompleted} sent + ${finalState.summary.sendsSatisfied} satisfied)`);

    return {
        lotteryId,
        stateFilePath,
        summary: finalState.summary,
    };
}

// =============================================================================
// BUY LOOP
// =============================================================================

/** What is left to buy for a coin: the address and this pass's amount. */
export interface BuyPlanItem {
    mint: PublicKey;
    solAmount: number;
}

export async function buyLoop(
    plan: BuyPlanItem[],
    keeper: Keypair,
    buyConcurrency: number,
    buyWindowMinutes: number,
    stateManager: OrchestratorStateManager,
    log: Logger
): Promise<void> {
    const sem = new Semaphore(buyConcurrency);

    await Promise.all(
        plan.map((token) =>
            sem.use(async () => {
                const mintStr = token.mint.toBase58();
                const adjustedSol = token.solAmount;
                const tlog = log.child({ mint: mintStr.slice(0, 8) });

                if (adjustedSol <= 0) {
                    stateManager.markTokenBuyFailed(mintStr, "Adjusted amount <= 0");
                    stateManager.incrementMetric("tokenSkippedZeroBudget");
                    tlog.warn({ event: "lottery.token_skipped_zero_budget" }, "Token skipped: zero budget");
                    return;
                }

                // The batch file path is fixed before buying: after a crash it
                // shows what has already been bought, so only the remainder is.
                const batchStateFile = batchStatePath(
                    stateManager.getState().lotteryId,
                    mintStr,
                    (stateManager.getTokenBuy(mintStr)?.attempts ?? 0) + 1
                );
                stateManager.startTokenBuy(mintStr, batchStateFile);

                try {
                    const result = await batchBuy({
                        mint: token.mint,
                        totalSolAmount: adjustedSol,
                        keeper,
                        windowMinutes: buyWindowMinutes,
                        stateFilePath: batchStateFile,
                        logger: tlog,
                    });
                    stateManager.addTokenBuySpent(mintStr, result.summary.totalSolSpent ?? 0);

                    // batchBuy returns a summary even when not a single
                    // purchase went through — it only throws on a complete
                    // refusal. Marking "bought" unconditionally turned a batch
                    // where all the SOL was stuck on the keeper into a green
                    // report.
                    if (result.summary.completedPurchases === 0) {
                        stateManager.markTokenBuyFailed(
                            mintStr,
                            `No purchases completed (${result.summary.abandonedPurchases} abandoned)`
                        );
                        tlog.error({
                            event: "lottery.token_buy_empty",
                            abandoned: result.summary.abandonedPurchases,
                            batchStateFile: result.stateFilePath,
                        }, "Buy produced nothing: every purchase abandoned");
                        return;
                    }

                    stateManager.markTokenBuyCompleted(
                        mintStr,
                        result.runId,
                        result.stateFilePath
                    );

                    tlog.info({
                        event: "lottery.token_buy_complete",
                        completed: result.summary.completedPurchases,
                        abandoned: result.summary.abandonedPurchases,
                        solSpent: result.summary.totalSolSpent,
                    }, `Buy complete: ${result.summary.completedPurchases} purchases`);
                } catch (error) {
                    const msg =
                        error instanceof Error ? error.message : String(error);
                    stateManager.markTokenBuyFailed(mintStr, msg);
                    tlog.error({
                        event: "lottery.token_buy_failed",
                        error: msg,
                    }, `Buy failed: ${msg}`);
                }
            })
        )
    );
}
