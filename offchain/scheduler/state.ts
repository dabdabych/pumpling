// scheduler/state.ts
// JSON persistence for the batch state

import * as fs from "fs";
import * as path from "path";
import { BatchState, BatchMetrics, PurchaseRecord, PurchaseStatus } from "./types";

// =============================================================================
// STATE MANAGER
// =============================================================================

/**
 * The state manager for batch purchases.
 * Writes the state to a JSON file after every change.
 */
export class BatchStateManager {
    private state: BatchState;
    private filePath: string;

    constructor(state: BatchState, filePath: string) {
        this.state = state;
        this.filePath = filePath;
    }

    /**
     * Creates a new state manager with an initial state.
     */
    static create(
        runId: string,
        mint: string,
        totalSolAmount: number,
        purchases: PurchaseRecord[],
        config: BatchState["config"],
        filePath: string
    ): BatchStateManager {
        const state: BatchState = {
            runId,
            mint,
            totalSolAmount,
            purchaseCount: purchases.length,
            config,
            purchases,
            summary: {
                completedPurchases: 0,
                abandonedPurchases: 0,
                totalSolSpent: 0,
                startedAt: Date.now(),
            },
            metrics: createEmptyBatchMetrics(),
        };

        const manager = new BatchStateManager(state, filePath);
        manager.save();
        return manager;
    }

    /**
     * Loads an existing state from a file.
     */
    static load(filePath: string): BatchStateManager {
        const content = fs.readFileSync(filePath, "utf-8");
        const state = JSON.parse(content) as BatchState;
        return new BatchStateManager(state, filePath);
    }

    /**
     * Checks whether the state file exists.
     */
    static exists(filePath: string): boolean {
        return fs.existsSync(filePath);
    }

    /**
     * Writes the current state to the file.
     */
    save(): void {
        // Create the directory if it does not exist
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tmpPath = `${this.filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmpPath, this.filePath);
    }

    /**
     * Returns the current state.
     */
    getState(): BatchState {
        return this.state;
    }

    /**
     * Returns the file path.
     */
    getFilePath(): string {
        return this.filePath;
    }

    /**
     * Returns a purchase by index.
     */
    getPurchase(index: number): PurchaseRecord | undefined {
        return this.state.purchases.find((p) => p.index === index);
    }

    /**
     * Returns every pending purchase.
     */
    getPendingPurchases(): PurchaseRecord[] {
        return this.state.purchases.filter((p) => p.status === "pending");
    }

    /**
     * Returns every failed purchase.
     */
    getFailedPurchases(): PurchaseRecord[] {
        return this.state.purchases.filter((p) => p.status === "failed");
    }

    /**
     * Updates a purchase's status.
     */
    updatePurchase(
        index: number,
        update: Partial<
            Pick<
                PurchaseRecord,
                | "status"
                | "signature"
                | "pendingSignature"
                | "venue"
                | "attempts"
                | "lastSlippageBps"
                | "errorMessage"
                | "solAmount"
                | "plannedSolAmount"
            >
        >
    ): void {
        const purchase = this.state.purchases.find((p) => p.index === index);
        if (!purchase) {
            throw new Error(`Purchase ${index} not found`);
        }

        Object.assign(purchase, update, { updatedAt: Date.now() });
        this.updateSummary();
        this.save();
    }

    /**
     * Marks a purchase as started.
     */
    markInProgress(index: number, slippageBps: number): void {
        this.updatePurchase(index, {
            status: "in_progress",
            lastSlippageBps: slippageBps,
        });
    }

    /**
     * Marks a purchase as completed.
     */
    markCompleted(
        index: number,
        signature: string,
        venue: PurchaseRecord["venue"]
    ): void {
        const purchase = this.getPurchase(index);
        if (!purchase) return;

        this.updatePurchase(index, {
            status: "completed",
            signature,
            venue,
            attempts: purchase.attempts + 1,
        });
    }

    /**
     * Marks a purchase as failed.
     */
    markFailed(index: number, errorMessage: string): void {
        const purchase = this.getPurchase(index);
        if (!purchase) return;

        this.updatePurchase(index, {
            status: "failed",
            errorMessage,
            attempts: purchase.attempts + 1,
        });
    }

    /**
     * Marks a purchase as abandoned (retries exhausted).
     */
    markAbandoned(index: number, errorMessage: string): void {
        this.updatePurchase(index, {
            status: "abandoned",
            errorMessage,
        });
    }

    /**
     * Resets a failed purchase back to pending for a retry.
     */
    resetForRetry(index: number): void {
        this.updatePurchase(index, {
            status: "pending",
            errorMessage: undefined,
        });
    }

    /**
     * Updates the summary from the current purchases.
     */
    private updateSummary(): void {
        const completed = this.state.purchases.filter(
            (p) => p.status === "completed"
        );
        const abandoned = this.state.purchases.filter(
            (p) => p.status === "abandoned"
        );

        this.state.summary.completedPurchases = completed.length;
        this.state.summary.abandonedPurchases = abandoned.length;
        this.state.summary.totalSolSpent = completed.reduce(
            (sum, p) => sum + p.solAmount,
            0
        );
    }

    /**
     * Increments a metric by dot-path.
     * Example: incrementMetric("venueRouting.fallbackToDex")
     */
    incrementMetric(dotPath: string, amount: number = 1): void {
        if (!this.state.metrics) {
            this.state.metrics = createEmptyBatchMetrics();
        }
        incrementNestedCounter(this.state.metrics, dotPath, amount);
        this.save();
    }

    /**
     * Increments the error counter for a pattern.
     */
    incrementErrorPattern(pattern: string): void {
        if (!this.state.metrics) {
            this.state.metrics = createEmptyBatchMetrics();
        }
        this.state.metrics.errors.byPattern[pattern] =
            (this.state.metrics.errors.byPattern[pattern] || 0) + 1;
        this.save();
    }

    /**
     * Finishes the batch and records the final time.
     */
    finalize(): void {
        this.state.summary.finishedAt = Date.now();
        this.save();
    }
}

// =============================================================================
// METRICS HELPERS
// =============================================================================

/**
 * Creates an empty BatchMetrics object with every counter at 0.
 */
export function createEmptyBatchMetrics(): BatchMetrics {
    return {
        venueRouting: {
            pumpfunDirect: 0,
            dexDirect: 0,
            fallbackToDex: 0,
            fallbackToPumpswap: 0,
            postSendErrorBlocked: 0,
        },
        pumpfun: {
            graduationDetected: 0,
            simulationFailed: 0,
            sendFailed: 0,
            onChainFailure: 0,
            token2022Used: 0,
        },
        dex: {
            quoteFailed: 0,
            noRoute: 0,
            swapBuildFailed: 0,
            timeout: 0,
            onChainFailure: 0,
        },
        balance: {
            shrunkToFit: 0,
            abandonedEmpty: 0,
            shrunkAfterFailure: 0,
        },
        retry: {
            slippageInstantRetry: 0,
            slippageInstantRetrySuccess: 0,
            slippageInstantRetryFail: 0,
            pendingTxConfirmed: 0,
            nonRetryableAbandon: 0,
            retryableDeferred: 0,
            unknownDeferred: 0,
            retrySuccess: 0,
            maxAttemptsAbandon: 0,
            windowExpiredAbandon: 0,
        },
        errors: {
            retryable: 0,
            nonRetryable: 0,
            unknown: 0,
            byPattern: {},
        },
    };
}

/**
 * Increments a nested counter by dot-path.
 * "retry.pendingTxConfirmed" → obj.retry.pendingTxConfirmed += amount
 */
function incrementNestedCounter(
    obj: Record<string, any>,
    dotPath: string,
    amount: number
): void {
    const parts = dotPath.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        // A missing section is created on the fly. Otherwise a new metric takes
        // down a whole batch working from a state file written by an earlier
        // version of the code, where no section by that name exists.
        if (typeof current[parts[i]] !== "object" || current[parts[i]] === null) {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    const key = parts[parts.length - 1];
    current[key] = (current[key] || 0) + amount;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Generates a unique id for a batch run.
 *
 * @example
 * generateRunId() // "batch_2026-02-08T12-30-00_abc123"
 */
export function generateRunId(): string {
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
    const random = Math.random().toString(36).slice(2, 8);
    return `batch_${timestamp}_${random}`;
}

/**
 * Generates a purchase id.
 *
 * @example
 * generatePurchaseId(1, "batch_2026...") // "purchase_1_abc123"
 */
export function generatePurchaseId(index: number, runId: string): string {
    const suffix = runId.split("_").pop() || Math.random().toString(36).slice(2, 8);
    return `purchase_${index}_${suffix}`;
}

/**
 * Generates the default state file path.
 *
 * @example
 * getDefaultStatePath("batch_2026...") // "./logs/batch_2026....json"
 */
export function getDefaultStatePath(runId: string): string {
    return `./logs/${runId}.json`;
}
