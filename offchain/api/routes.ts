// api/routes.ts
// POST /execute — start lottery, GET /execute/:lotteryId — check status

import { Router, Request, Response } from "express";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import { executeLottery } from "../orchestrator";
import { findUnfinishedStates, resumeLottery } from "../orchestrator/resume";
import { OrchestratorStateManager, getDefaultLotteryStatePath } from "../orchestrator/state";
import { BatchState } from "../scheduler/types";
import { buildPurchaseFeed } from "./purchaseFeed";
import { validateAndConvert, ValidationError } from "./validation";
import { logger } from "../logger";

// =============================================================================
// TYPES
// =============================================================================

interface RunningLottery {
    lotteryId: string;
    stateFilePath: string;
    startedAt: number;
    promise: Promise<unknown>;
}



/**
 * The state of one purchase batch. The file may not exist at all (buying that
 * coin has not started yet) and it may be caught half-written — neither is a
 * reason to fail the response.
 */
function readBatchState(filePath?: string): BatchState | null {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as BatchState;
    } catch {
        return null;
    }
}

// =============================================================================
// ROUTER
// =============================================================================

export interface RouterHandle {
    router: Router;
    /** Continue rounds that were cut off along with the previous process. */
    resumeUnfinished: () => Promise<string[]>;
    waitForRunning: () => Promise<void>;
}

export function createRouter(keeper: Keypair): RouterHandle {
    const router = Router();
    const running = new Map<string, RunningLottery>();

    // POST /execute — fire-and-forget lottery execution
    router.post("/execute", (req: Request, res: Response) => {
        try {
            const params = validateAndConvert(req.body, keeper);
            const { lotteryId } = params;

            // Check for duplicate — already running
            if (running.has(lotteryId)) {
                res.status(409).json({
                    error: "Lottery already running",
                    lotteryId,
                });
                return;
            }

            // Check for duplicate — state file exists from previous run
            const stateFilePath = getDefaultLotteryStatePath(lotteryId);
            if (fs.existsSync(stateFilePath)) {
                res.status(409).json({
                    error: "Lottery state file already exists",
                    lotteryId,
                    stateFile: stateFilePath,
                });
                return;
            }

            // Fire and forget
            const promise = executeLottery({ ...params, logger: logger.child({ lotteryId }) })
                .then((result) => {
                    logger.info({ event: "api.lottery_completed", lotteryId, summary: result.summary },
                        `Lottery ${lotteryId} completed`);
                })
                .catch((err) => {
                    logger.error({ event: "api.lottery_failed", lotteryId, error: err instanceof Error ? err.message : String(err) },
                        `Lottery ${lotteryId} failed`);
                })
                .finally(() => {
                    running.delete(lotteryId);
                });

            running.set(lotteryId, {
                lotteryId,
                stateFilePath,
                startedAt: Date.now(),
                promise,
            });

            res.status(202).json({
                lotteryId,
                status: "started",
                stateFile: stateFilePath,
            });
        } catch (err) {
            if (err instanceof ValidationError) {
                res.status(400).json({
                    error: err.message,
                    details: err.details,
                });
                return;
            }
            logger.error({ event: "api.execute_error", error: err instanceof Error ? err.message : String(err) },
                "Unexpected error in POST /execute");
            res.status(500).json({ error: "Internal server error" });
        }
    });

    // GET /execute/:lotteryId — check lottery status
    router.get("/execute/:lotteryId", (req: Request, res: Response) => {
        const lotteryId = req.params.lotteryId as string;
        const stateFilePath = getDefaultLotteryStatePath(lotteryId);

        // Check if running but state file not yet created
        if (running.has(lotteryId) && !fs.existsSync(stateFilePath)) {
            res.json({ lotteryId, status: "initializing" });
            return;
        }

        if (!fs.existsSync(stateFilePath)) {
            res.status(404).json({
                error: "Lottery not found",
                lotteryId,
            });
            return;
        }

        try {
            const manager = OrchestratorStateManager.load(stateFilePath);
            res.json(manager.getState());
        } catch (err) {
            logger.error({ event: "api.state_read_error", lotteryId, error: err instanceof Error ? err.message : String(err) },
                `Error reading state for ${lotteryId}`);
            res.status(500).json({ error: "Failed to read lottery state" });
        }
    });

    // GET /execute/:lotteryId/purchases — what has been bought and in which
    // transactions. The site shows this feed while the buying runs: a promise
    // you can see on chain is the whole product. We return only completed
    // purchases with a signature — unfinished ones prove nothing.
    router.get("/execute/:lotteryId/purchases", (req: Request, res: Response) => {
        const lotteryId = req.params.lotteryId as string;
        const stateFilePath = getDefaultLotteryStatePath(lotteryId);

        if (!fs.existsSync(stateFilePath)) {
            res.status(404).json({ error: "Lottery not found", lotteryId });
            return;
        }

        try {
            const state = OrchestratorStateManager.load(stateFilePath).getState();
            res.json(buildPurchaseFeed(state, readBatchState));
        } catch (err) {
            logger.error(
                { event: "api.purchases_read_error", lotteryId, error: err instanceof Error ? err.message : String(err) },
                `Error reading purchases for ${lotteryId}`
            );
            res.status(500).json({ error: "Failed to read lottery purchases" });
        }
    });

    /**
     * Continues rounds that were cut off along with the previous process.
     *
     * They go one at a time and land in the same `running` registry as ordinary
     * starts: so the status endpoint sees them, a graceful stop waits for them,
     * and a repeat POST for the same round gets an honest refusal.
     */
    const resumeUnfinished = async (): Promise<string[]> => {
        const files = findUnfinishedStates();
        if (files.length === 0) {
            return [];
        }
        logger.warn(
            { event: "api.resume_found", count: files.length, files },
            `Found ${files.length} unfinished lotteries after restart`
        );

        const taken: string[] = [];
        for (const stateFilePath of files) {
            const lotteryId = lotteryIdFromStatePath(stateFilePath);
            if (!lotteryId || running.has(lotteryId)) {
                continue;
            }
            const promise = resumeLottery(stateFilePath, { keeper, logger: logger.child({ lotteryId }) })
                .then((result) => {
                    logger.info(
                        { event: "api.lottery_resumed", lotteryId, summary: result?.summary },
                        `Lottery ${lotteryId} finished after resume`
                    );
                })
                .catch((err) => {
                    logger.error(
                        { event: "api.resume_failed", lotteryId, error: err instanceof Error ? err.message : String(err) },
                        `Resume of lottery ${lotteryId} failed`
                    );
                })
                .finally(() => {
                    running.delete(lotteryId);
                });

            running.set(lotteryId, { lotteryId, stateFilePath, startedAt: Date.now(), promise });
            taken.push(lotteryId);
            // One at a time: the rounds would queue on the same keeper wallet
            // and the same transaction send limit anyway.
            await promise;
        }
        return taken;
    };

    return {
        router,
        resumeUnfinished,
        waitForRunning: () =>
            Promise.allSettled([...running.values()].map((r) => r.promise)).then(() => {}),
    };
}

/** `./logs/lottery_128.json` → `128`. */
export function lotteryIdFromStatePath(stateFilePath: string): string | null {
    const match = /lottery_(.+)\.json$/.exec(stateFilePath.replace(/\\/g, "/").split("/").pop() ?? "");
    return match ? match[1] : null;
}
