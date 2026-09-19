// orchestrator/types.ts
// Types for the round orchestrator (Layer 3)

import { Keypair, PublicKey } from "@solana/web3.js";
import { Logger } from "../logger";

// =============================================================================
// INPUT PARAMETERS
// =============================================================================

export interface ExecuteLotteryParams {
    lotteryId: string;
    tokens: TokenEntry[];
    keeper: Keypair;
    /** The pause between sweep passes. Overridden to instant in tests. */
    sleepFn?: (ms: number) => Promise<void>;
    buyConcurrency?: number;   // default 50
    sendConcurrency?: number;  // default 20
    buyWindowMinutes?: number; // default 50
    sendRounds?: number;       // default 10
    stateFilePath?: string;
    /** Structured logger (pino). Falls back to the root logger. */
    logger?: Logger;
}

export interface TokenEntry {
    mint: PublicKey;
    totalSol: number;          // SOL (not lamports)
    recipients: RecipientEntry[];
}

export interface RecipientEntry {
    publickey: PublicKey;
    amount: number; // SOL bet
}

// =============================================================================
// STATE RECORDS
// =============================================================================

export interface TokenBuyRecord {
    mint: string;
    adjustedSolAmount: number; // SOL (not lamports)
    status: "pending" | "in_progress" | "completed" | "failed";
    batchRunId?: string;
    /** The batch file: the latest one, if there were several. */
    batchStateFile?: string;
    /**
     * Every batch file for this coin. After a recovery there is more than one:
     * the earlier batch stays as it is (with what was bought and the
     * signatures) and a new one buys the remainder. The purchase feed reads
     * them all.
     */
    batchStateFiles?: string[];
    /** How much SOL has already gone into completed purchases for this coin. */
    spentSol?: number;
    /** How many times this coin was taken on: the first pass plus recoveries. */
    attempts?: number;
    errorMessage?: string;
    updatedAt: number;
}

export type SendStatus =
    | "pending"
    | "in_progress"
    | "completed"
    | "satisfied"
    | "failed"
    | "abandoned"
    | "ata_mismatch";

export interface SendRecord {
    id: string;
    mint: string;
    recipient: string;
    recipientBetSol: number;  // SOL (not lamports)
    share: number;    // recipient.amount / sum(amounts)
    sendN: number;    // calculateSendN(recipientBetSol)
    round: number;    // 1-based
    amount?: string;  // raw token units (bigint as string)
    status: SendStatus;
    signature?: string;
    /**
     * The signature of a transaction that went out but whose confirmation we
     * never saw. It is checked before a repeat: if the delivery arrived it must
     * not be sent a second time, or the recipient would get a double share
     * while the others came up short out of the same remainder.
     */
    pendingSignature?: string;
    attempts: number;
    errorMessage?: string;
    hadAtaAtStart?: boolean;
    ataMismatch?: boolean;
    updatedAt: number;
}

// =============================================================================
// LOTTERY STATE
// =============================================================================

export interface LotteryConfig {
    buyConcurrency: number;
    sendConcurrency: number;
    buyWindowMinutes: number;
    sendRounds: number;
}

export interface LotterySummary {
    tokensBought: number;
    tokensFailed: number;
    sendsTotal: number;
    sendsCompleted: number;
    sendsSatisfied: number;
    sendsAbandoned: number;
    sendsAtaMismatch: number;
    startedAt: number;
    finishedAt?: number;
}

/**
 * A refund of unspent SOL to a participant.
 *
 * Appears when part of the buying did not go through: the promise about that
 * money was not kept, so it goes back to whoever put it in.
 */
export interface RefundRecord {
    /** `mint:recipient` — one refund per pair. */
    id: string;
    mint: string;
    recipient: string;
    /** The share of the remainder before the fee. */
    grossSol: number;
    /** The network fee subtracted from the refund. */
    feeSol: number;
    /** What actually goes to the recipient. */
    amountSol: number;
    status: "pending" | "in_progress" | "completed" | "skipped" | "failed";
    signature?: string;
    /** Went out but we never saw the confirmation: checked before a repeat. */
    pendingSignature?: string;
    attempts: number;
    errorMessage?: string;
    updatedAt: number;
}

export interface LotteryState {
    lotteryId: string;
    totalSol: number;      // SOL (not lamports)
    sendReserve: number;   // SOL (not lamports)
    buyBudget: number;     // SOL (not lamports)
    config: LotteryConfig;
    tokenBuys: TokenBuyRecord[];
    sends: SendRecord[];
    /** Refunds of unspent SOL; empty until the buying is over. */
    refunds?: RefundRecord[];
    summary: LotterySummary;
    /** Event metrics (the ones not derivable from statuses) */
    metrics?: LotteryMetrics;
}

// =============================================================================
// METRICS (explicit counters for events not derivable from send/buy statuses)
// =============================================================================

export interface LotteryMetrics {
    tokenSkippedZeroBudget: number; // #40
    send: {
        carryForward: number;          // #42
        retryableToPending: number;    // #43
        nonRetryableAbandon: number;   // #44
        maxAttemptsAbandon: number;    // #45
        lastRoundRetry: number;        // #46
        lastRoundRetrySuccess: number; // #47
        lastRoundRetryFail: number;    // #48
        ataMismatchBlocked: number;    // #49
        ataForgiven: number;           // #50
        ataDeferred: number;           // #51
        ataDeferredSent: number;       // #52
        computeLimitSplit: number;     // #53
        /** The delivery was closed on a signature that arrived from an earlier attempt. */
        pendingTxConfirmed: number;
        /** The fate of the signature could not be established, so the delivery was skipped. */
        pendingCheckFailed: number;
    };
    sweep: {
        resetToPending: number; // #54
        sendCompleted: number;  // #55
        sendFailed: number;     // #56
    };
}

// =============================================================================
// RESULT
// =============================================================================

export interface LotteryResult {
    lotteryId: string;
    stateFilePath: string;
    summary: LotterySummary;
}
