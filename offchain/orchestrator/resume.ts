// orchestrator/resume.ts
// Resuming a round after the process died.

/**
 * Why.
 *
 * The buyer holds for an hour: it buys coins in batches and delivers what it
 * bought in parallel. If the process dies in the middle (OOM, a host reboot, a
 * bad deploy), the SOL is already on the keeper, some purchases are done, some
 * deliveries are sent — and nobody finds out. The round would hang forever and
 * have to be untangled by hand from the logs and the chain.
 *
 * How it works. The state of a round and of every batch lives in `./logs` and
 * survives a container restart (the folder is a mounted volume). On startup the
 * buyer looks for rounds that were never finished and continues them with the
 * same code as a normal run.
 *
 * Two rules, without which recovery is more dangerous than the crash:
 *
 * 1. **Do not buy twice.** How much was already spent is visible in the batch
 *    files, from the completed purchases. We buy only the remainder, and only
 *    if it is meaningful.
 * 2. **Do not send twice.** Deliveries stuck in `in_progress` go back into the
 *    queue: before a repeat their signature is checked on the network (see
 *    `sendRounds`), so one that arrived does not go out a second time.
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";

import { logger as rootLogger, Logger } from "../logger";
import { BatchState } from "../scheduler/types";
import { BuyPlanItem, runBuyAndSend } from "./orchestrator";
import { OrchestratorStateManager } from "./state";
import { LotteryResult, LotteryState } from "./types";

/** The state folder: the same one a normal run writes to. */
export const STATE_DIR = "./logs";

/**
 * We do not go back to buy a remainder smaller than this: the amount is
 * comparable to network fees, and buying with it would burn SOL rather than
 * achieve anything.
 */
export const MIN_RESUME_SOL = 0.01;

/** How many minutes we allow for the remaining purchases when the original window has passed. */
export const MIN_RESUME_WINDOW_MINUTES = 2;

export interface ResumeDeps {
    keeper: Keypair;
    logger?: Logger;
    sleepFn?: (ms: number) => Promise<void>;
    /** Overrides reading a batch file, for tests. */
    readBatch?: (filePath: string) => BatchState | null;
    now?: () => number;
}

// =============================================================================
// FINDING UNFINISHED ROUNDS
// =============================================================================

/** A round is open if its summary has no finish time. */
export function isUnfinished(state: LotteryState | null): boolean {
    return !!state && !state.summary?.finishedAt;
}

export function readLotteryState(filePath: string): LotteryState | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as LotteryState;
    } catch {
        // The file may have been left half-written at the moment of the crash:
        // that is no reason to fail the buyer's startup, but there is nothing
        // to continue from either.
        return null;
    }
}

/** The files of rounds that were left unfinished. */
export function findUnfinishedStates(dir: string = STATE_DIR): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("lottery_") && name.endsWith(".json"))
        .map((name) => path.join(dir, name))
        .filter((filePath) => isUnfinished(readLotteryState(filePath)))
        .sort();
}

// =============================================================================
// THE PLAN FOR WHAT IS LEFT TO BUY
// =============================================================================

export function defaultReadBatch(filePath: string): BatchState | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as BatchState;
    } catch {
        return null;
    }
}

/** How much SOL actually went out on this batch: counted from completed purchases. */
export function spentInBatch(batch: BatchState | null): number {
    if (!batch) {
        return 0;
    }
    return (batch.purchases ?? [])
        .filter((purchase) => purchase.status === "completed")
        .reduce((sum, purchase) => sum + (purchase.solAmount ?? 0), 0);
}

export interface ResumePlan {
    /** What we are buying on this pass. */
    buys: BuyPlanItem[];
    /** Coins declared bought: the remainder is too small. */
    settled: string[];
    /** Deliveries put back in the queue. */
    revivedSends: number;
}

/**
 * What to do with every coin and delivery after a crash.
 *
 * The function mutates state (putting stuck deliveries back in the queue) and
 * returns the buying plan. Kept apart from `resumeLottery` so it can be tested
 * without the network and without files.
 */
export function planResume(
    stateManager: OrchestratorStateManager,
    readBatch: (filePath: string) => BatchState | null = defaultReadBatch
): ResumePlan {
    const state = stateManager.getState();
    const buys: BuyPlanItem[] = [];
    const settled: string[] = [];

    for (const token of state.tokenBuys ?? []) {
        if (token.status === "completed" || token.status === "failed") {
            continue;
        }

        const files = token.batchStateFiles ?? (token.batchStateFile ? [token.batchStateFile] : []);
        const spent = files.reduce((sum, file) => sum + spentInBatch(readBatch(file)), 0);
        const remaining = Math.round((token.adjustedSolAmount - spent) * 1e9) / 1e9;

        if (spent > 0) {
            // We write what was spent into the state: the remainder is computed
            // from it afterwards, even if someone takes the batch files away.
            stateManager.updateTokenBuy(token.mint, { spentSol: spent });
        }

        if (remaining < MIN_RESUME_SOL) {
            // Nothing left to buy. If anything was bought this is a completed
            // purchase; if not, it is an honest failure rather than silence.
            if (spent > 0) {
                stateManager.markTokenBuyCompleted(
                    token.mint,
                    token.batchRunId ?? "resumed",
                    token.batchStateFile ?? ""
                );
                settled.push(token.mint);
            } else {
                stateManager.markTokenBuyFailed(token.mint, "Nothing bought before the restart");
            }
            continue;
        }

        buys.push({ mint: new PublicKey(token.mint), solAmount: remaining });
    }

    // Deliveries stuck "in progress": their signature is checked before a repeat.
    let revivedSends = 0;
    for (const send of state.sends ?? []) {
        if (send.status === "in_progress") {
            stateManager.updateSend(send.id, { status: "pending" });
            revivedSends++;
        }
    }

    return { buys, settled, revivedSends };
}

/** How many minutes are left of the original buying window. */
export function remainingWindowMinutes(state: LotteryState, now: number): number {
    const windowMinutes = state.config?.buyWindowMinutes ?? 50;
    const startedAt = state.summary?.startedAt ?? now;
    const left = (startedAt + windowMinutes * 60_000 - now) / 60_000;
    return Math.max(MIN_RESUME_WINDOW_MINUTES, Math.round(left));
}

// =============================================================================
// RESUMING
// =============================================================================

export async function resumeLottery(
    stateFilePath: string,
    deps: ResumeDeps
): Promise<LotteryResult | null> {
    const log = (deps.logger ?? rootLogger).child({ stateFilePath });
    const now = deps.now ?? (() => Date.now());

    const raw = readLotteryState(stateFilePath);
    if (!isUnfinished(raw)) {
        return null;
    }

    const stateManager = OrchestratorStateManager.load(stateFilePath);
    const state = stateManager.getState();
    const plan = planResume(stateManager, deps.readBatch ?? defaultReadBatch);
    const windowMinutes = remainingWindowMinutes(state, now());

    log.warn(
        {
            event: "lottery.resume",
            lotteryId: state.lotteryId,
            tokensToBuy: plan.buys.length,
            tokensSettled: plan.settled.length,
            revivedSends: plan.revivedSends,
            windowMinutes,
        },
        `Resuming lottery ${state.lotteryId}: ${plan.buys.length} buys left, ${plan.revivedSends} sends back in the queue`
    );

    return runBuyAndSend({
        stateManager,
        plan: plan.buys,
        keeper: deps.keeper,
        buyConcurrency: state.config?.buyConcurrency ?? 50,
        sendConcurrency: state.config?.sendConcurrency ?? 20,
        buyWindowMinutes: windowMinutes,
        sendRounds: state.config?.sendRounds ?? 10,
        sleepFn: deps.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
        stateFilePath,
        log,
        tokensTotal: (state.tokenBuys ?? []).length,
    });
}

/**
 * Continues every unfinished round. Returns the ones it picked up.
 *
 * Rounds go one at a time: they would queue on the same keeper wallet and the
 * same transaction send limit anyway, and starting them in parallel would only
 * make the logs unreadable.
 */
export async function resumeAll(deps: ResumeDeps, dir: string = STATE_DIR): Promise<string[]> {
    const log = deps.logger ?? rootLogger;
    const files = findUnfinishedStates(dir);
    if (files.length === 0) {
        return [];
    }

    log.warn({ event: "lottery.resume_found", count: files.length, files }, `Found ${files.length} unfinished lotteries`);

    const resumed: string[] = [];
    for (const filePath of files) {
        try {
            const result = await resumeLottery(filePath, deps);
            if (result) {
                resumed.push(filePath);
            }
        } catch (error) {
            log.error(
                {
                    event: "lottery.resume_failed",
                    stateFilePath: filePath,
                    error: error instanceof Error ? error.message : String(error),
                },
                `Failed to resume ${filePath}`
            );
        }
    }
    return resumed;
}
