// orchestrator/orchestrator.ts
// executeLottery — main entry point for Layer 3

import { Keypair, PublicKey } from "@solana/web3.js";
import { batchBuy } from "../scheduler";
import { classifyError } from "../scheduler/errors";
import { logger as rootLogger, Logger } from "../logger";
import { Semaphore } from "./semaphore";
import { calculateSendReserve, distributeBuyBudget } from "./fees";
import { TX_FEE_SOL } from "../scheduler/fees";
import { connection } from "../solana/connection";
import { finishBurns, settleAfterBuying } from "./settle";
import { burnWeightOf, hasBurn, sharesOf } from "./shares";
import { getTokenBalance } from "./sendRounds";
import {
    calculateSendN,
    generateSendRecords,
    executeSendRounds,
    sleep,
    snapshotRecipientAtas,
    MAX_SEND_ATTEMPTS,
} from "./sendRounds";
import { OrchestratorStateManager, batchStatePath, getDefaultLotteryStatePath } from "./state";
import { readBatchFile } from "./batchFile";
import { buildRefundLedger, collectRoundSignatures } from "./refundLedger";
import { readKeeperDebits } from "../solana/debits";
import { refundUnspent } from "./refunds";
import {
    ExecuteLotteryParams,
    LotteryState,
    LotteryResult,
    RecipientEntry,
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

/** Burn transactions beyond the delivery rounds: three sweep passes and the settlement. */
const BURN_EXTRA_PASSES = 4;

/** The commit in lamports: the payload's exact figure when it has one. */
function stakeLamportsOf(recipient: RecipientEntry): bigint {
    if (typeof recipient.amountLamports === "string" && /^\d+$/.test(recipient.amountLamports)) {
        return BigInt(recipient.amountLamports);
    }
    return BigInt(Math.round(recipient.amount * 1e9));
}

/** Σ(lamports × bps) for one recipient entry; see `burnWeightOf`. */
function burnWeightOfEntry(recipient: RecipientEntry): bigint {
    return burnWeightOf(stakeLamportsOf(recipient), recipient.burnWeight, recipient.burnBps);
}

/** Whether this entry asked for everything bought for it to be burned. */
function burnsEverything(recipient: RecipientEntry): boolean {
    const stake = stakeLamportsOf(recipient);
    return stake > 0n && burnWeightOfEntry(recipient) === stake * 10_000n;
}

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

    // Somebody who asked for everything bought for them to be burned gets no
    // deliveries at all: no records, no token account checked, no rent held
    // back for one. They are still in the round — `recipients` below — for
    // the burn, the refund of unspent SOL and the verification page.
    const deliveryTokens = tokens.map((token) => ({
        ...token,
        recipients: token.recipients.filter((recipient) => !burnsEverything(recipient)),
    }));

    // Snapshot ATAs for recipients with <1 SOL bets (fraud guard)
    const ataSnapshot = await snapshotRecipientAtas(deliveryTokens, sendConcurrency);

    // Generate send records
    const sends = generateSendRecords(deliveryTokens, sendRounds, ataSnapshot);

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
    // Burns are paid for out of the same reserve as deliveries: one transaction
    // per coin per delivery round, the sweep passes and the settlement.
    const burningCoins = tokens.filter((token) =>
        token.recipients.some((recipient) => burnWeightOfEntry(recipient) > 0n)
    ).length;
    const burnReserve = burningCoins * (sendRounds + BURN_EXTRA_PASSES) * TX_FEE_SOL;
    const sendReserve = calculateSendReserve(uniqueRecipientValues) + burnReserve;
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
        // What the draw gave the coin, and what the buying may spend of it:
        // the difference is this coin's share of the delivery reserve.
        targetSolAmount: t.totalSol,
        adjustedSolAmount: adjustedAmounts[i],
        recipients: t.recipients.map((recipient) => {
            const stake = stakeLamportsOf(recipient);
            const weight = burnWeightOfEntry(recipient);
            return {
                wallet: recipient.publickey.toBase58(),
                stakeLamports: stake.toString(),
                // For display only, to two decimals of a basis point.
                burnBps: stake > 0n ? Number((weight * 100n) / stake) / 100 : 0,
                burnWeight: weight.toString(),
            };
        }),
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

    // Every coin's supply and decimals, before a single purchase. The decimals
    // are what turns the round's raw figures into amounts on the site. The
    // supply is what the verification page sets against the supply afterwards
    // for a coin with burners, and anyone can check both in an explorer. Read
    // here and only here: after a crash some burns may already be done, and a
    // supply read then would hide them.
    const supplySemaphore = new Semaphore(Math.max(1, Math.min(10, sendConcurrency)));
    await Promise.all(initialState.tokenBuys.map((token) => supplySemaphore.use(async () => {
        try {
            const supply = await connection.getTokenSupply(new PublicKey(token.mint));
            stateManager.updateTokenBuy(token.mint, {
                supplyAtStart: supply.value.amount,
                decimals: supply.value.decimals,
            });
        } catch (error) {
            log.warn({ event: "lottery.supply_unreadable", mint: token.mint.slice(0, 8), error: String(error) },
                "Supply before the round could not be read");
        }
    })));

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
        // PHASE 2.4: SETTLEMENT — what the second pass bought after the last round
        //
        // Burns what is still owed and queues a top-up for every wallet short of
        // its share. The sweep below sends the top-ups. See `settle.ts` for the
        // round that needed this.

        const settled = await settleAfterBuying({
            stateManager,
            keeper,
            sendRounds,
            loadBatch: readBatchFile,
            tokenBalance: (mint) => getTokenBalance(mint, keeper.publicKey),
            sleepFn,
            logger: log,
        });

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
        // A burn the settlement could not finish, because its last transaction
        // might still have been landing, gets its last attempts here.
        await finishBurns({
            stateManager,
            keeper,
            mints: settled.burnsWaiting,
            loadBatch: readBatchFile,
            sleepFn,
            logger: log,
        });
        for (const token of stateManager.getState().tokenBuys) {
            if (!hasBurn(sharesOf(stateManager.getState(), token.mint))) {
                continue;
            }
            try {
                const supply = await connection.getTokenSupply(new PublicKey(token.mint));
                stateManager.updateTokenBuy(token.mint, { supplyAtEnd: supply.value.amount });
            } catch {
                // Shown as unknown on the verification page.
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
        // What the round really cost, read off the chain. The plan knows the
        // amounts it meant to swap; only the chain knows the fees, the priority
        // and the rent of the accounts that had to be created — and every one
        // of those was reserved for out of the same money, so counting the
        // spend from the plan refunded the reserve whether it had been used or
        // not.
        const state = stateManager.getState();
        const signatures = collectRoundSignatures(state, readBatchFile);
        const debits = await readKeeperDebits(signatures, keeper.publicKey, { logger: log });
        const ledger = buildRefundLedger(state, readBatchFile, debits);
        const unknown = [...ledger.values()].filter((basis) => !basis.exact).length;
        if (unknown > 0) {
            log.warn(
                { event: "lottery.refund_ledger_estimated", coins: unknown, signatures: signatures.length },
                `Refund basis estimated for ${unknown} coin(s): the chain could not be read in full`
            );
        }
        const refunded = await refundUnspent(stateManager, ledger, { keeper, logger: log });
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
