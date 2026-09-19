// orchestrator/state.ts
// JSON persistence for lottery orchestrator state

import * as fs from "fs";
import * as path from "path";
import {
    LotteryState,
    LotteryMetrics,
    LotterySummary,
    RefundRecord,
    TokenBuyRecord,
    SendRecord,
    SendStatus,
} from "./types";

// =============================================================================
// STATE MANAGER
// =============================================================================

export class OrchestratorStateManager {
    private state: LotteryState;
    private filePath: string;

    constructor(state: LotteryState, filePath: string) {
        this.state = state;
        this.filePath = filePath;
    }

    static create(state: LotteryState, filePath: string): OrchestratorStateManager {
        const manager = new OrchestratorStateManager(state, filePath);
        manager.save();
        return manager;
    }

    static load(filePath: string): OrchestratorStateManager {
        const content = fs.readFileSync(filePath, "utf-8");
        const state = JSON.parse(content) as LotteryState;
        return new OrchestratorStateManager(state, filePath);
    }

    save(): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tmpPath = `${this.filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmpPath, this.filePath);
    }

    getState(): LotteryState {
        return this.state;
    }

    getFilePath(): string {
        return this.filePath;
    }

    // =========================================================================
    // TOKEN BUY UPDATES
    // =========================================================================

    updateTokenBuy(
        mint: string,
        update: Partial<Omit<TokenBuyRecord, "mint" | "adjustedSolAmount">>
    ): void {
        const record = this.state.tokenBuys.find((t) => t.mint === mint);
        if (!record) throw new Error(`Token buy not found: ${mint}`);

        Object.assign(record, update, { updatedAt: Date.now() });
        this.updateSummary();
        this.save();
    }

    markTokenBuyCompleted(
        mint: string,
        batchRunId: string,
        batchStateFile: string
    ): void {
        this.updateTokenBuy(mint, {
            status: "completed",
            batchRunId,
            batchStateFile,
        });
    }

    /** The purchase record for a coin, if there is one. */
    getTokenBuy(mint: string): TokenBuyRecord | undefined {
        return this.state.tokenBuys.find((t) => t.mint === mint);
    }

    /**
     * Marks that a coin has been taken on: its batch file name is known in advance.
     *
     * In advance, because otherwise after the process dies there is no way to
     * tell which batch belonged to this coin, and what was already bought would
     * have to be hunted for across the whole log folder.
     */
    startTokenBuy(mint: string, batchStateFile: string): void {
        const record = this.state.tokenBuys.find((t) => t.mint === mint);
        if (!record) throw new Error(`Token buy not found: ${mint}`);

        const files = record.batchStateFiles ?? [];
        if (!files.includes(batchStateFile)) {
            files.push(batchStateFile);
        }
        this.updateTokenBuy(mint, {
            status: "in_progress",
            batchStateFile,
            batchStateFiles: files,
            attempts: (record.attempts ?? 0) + 1,
        });
    }

    /** Adds to what was spent on a coin: there can be several passes. */
    addTokenBuySpent(mint: string, solSpent: number): void {
        const record = this.state.tokenBuys.find((t) => t.mint === mint);
        if (!record) throw new Error(`Token buy not found: ${mint}`);

        this.updateTokenBuy(mint, {
            spentSol: Math.round(((record.spentSol ?? 0) + solSpent) * 1e9) / 1e9,
        });
    }

    markTokenBuyFailed(mint: string, errorMessage: string): void {
        this.updateTokenBuy(mint, {
            status: "failed",
            errorMessage,
        });
    }

    // =========================================================================
    // REFUND UPDATES
    // =========================================================================

    /** Records the refund plan. Calling it again overwrites nothing. */
    setRefunds(refunds: RefundRecord[]): void {
        if (this.state.refunds && this.state.refunds.length > 0) {
            return;
        }
        this.state.refunds = refunds;
        this.save();
    }

    updateRefund(id: string, update: Partial<Omit<RefundRecord, "id" | "mint" | "recipient">>): void {
        const record = (this.state.refunds ?? []).find((refund) => refund.id === id);
        if (!record) throw new Error(`Refund not found: ${id}`);

        Object.assign(record, update, { updatedAt: Date.now() });
        this.save();
    }

    // =========================================================================
    // SEND UPDATES
    // =========================================================================

    updateSend(
        id: string,
        update: Partial<Omit<SendRecord, "id" | "mint" | "recipient" | "recipientBetSol" | "share" | "sendN" | "round">>
    ): void {
        const record = this.state.sends.find((s) => s.id === id);
        if (!record) throw new Error(`Send not found: ${id}`);

        Object.assign(record, update, { updatedAt: Date.now() });
        this.updateSummary();
        this.save();
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================

    private updateSummary(): void {
        const buys = this.state.tokenBuys;
        this.state.summary.tokensBought = buys.filter(
            (b) => b.status === "completed"
        ).length;
        this.state.summary.tokensFailed = buys.filter(
            (b) => b.status === "failed"
        ).length;

        const sends = this.state.sends;
        this.state.summary.sendsTotal = sends.length;
        this.state.summary.sendsCompleted = sends.filter(
            (s) => s.status === "completed"
        ).length;
        this.state.summary.sendsSatisfied = sends.filter(
            (s) => s.status === "satisfied"
        ).length;
        this.state.summary.sendsAbandoned = sends.filter(
            (s) => s.status === "abandoned"
        ).length;
        this.state.summary.sendsAtaMismatch = sends.filter(
            (s) => s.status === "ata_mismatch"
        ).length;
    }

    /**
     * Increments a metric by dot-path.
     * Example: incrementMetric("send.carryForward")
     */
    incrementMetric(dotPath: string, amount: number = 1): void {
        if (!this.state.metrics) {
            this.state.metrics = createEmptyLotteryMetrics();
        }
        const parts = dotPath.split(".");
        let current: Record<string, any> = this.state.metrics;
        for (let i = 0; i < parts.length - 1; i++) {
            current = current[parts[i]];
        }
        const key = parts[parts.length - 1];
        current[key] = (current[key] || 0) + amount;
        this.save();
    }

    finalize(): void {
        this.state.summary.finishedAt = Date.now();
        this.save();
    }
}

// =============================================================================
// METRICS HELPERS
// =============================================================================

export function createEmptyLotteryMetrics(): LotteryMetrics {
    return {
        tokenSkippedZeroBudget: 0,
        send: {
            carryForward: 0,
            retryableToPending: 0,
            nonRetryableAbandon: 0,
            maxAttemptsAbandon: 0,
            lastRoundRetry: 0,
            lastRoundRetrySuccess: 0,
            lastRoundRetryFail: 0,
            ataMismatchBlocked: 0,
            ataForgiven: 0,
            ataDeferred: 0,
            ataDeferredSent: 0,
            computeLimitSplit: 0,
            pendingTxConfirmed: 0,
            pendingCheckFailed: 0,
        },
        sweep: {
            resetToPending: 0,
            sendCompleted: 0,
            sendFailed: 0,
        },
    };
}

// =============================================================================
// HELPERS
// =============================================================================

export function getDefaultLotteryStatePath(lotteryId: string): string {
    return `./logs/lottery_${lotteryId}.json`;
}

/**
 * The purchase batch file for one coin.
 *
 * The name is fixed in advance and unambiguous: round, coin, pass number. After
 * the process dies it immediately shows what has been bought, and earlier
 * passes stay where they are — they hold the signatures the purchase feed shows.
 */
export function batchStatePath(lotteryId: string, mint: string, attempt: number): string {
    return `./logs/batch_${lotteryId}_${mint.slice(0, 8)}_${attempt}.json`;
}
