// scheduler/types.ts
// Types for the batch purchase scheduler

import { Keypair, PublicKey } from "@solana/web3.js";
import { BuyVenue } from "../buy";
import { Logger } from "../logger";

// =============================================================================
// INPUT PARAMETERS
// =============================================================================

export interface BatchBuyParams {
    /** The address of the token to buy */
    mint: PublicKey;
    /** The total amount of SOL to spend */
    totalSolAmount: number;
    /** The wallet keypair */
    keeper: Keypair;
    /** The main buying window, in minutes (default: 50) */
    windowMinutes?: number;
    /** The retry buffer, in minutes (default: 10) */
    retryBufferMinutes?: number;
    /** Path to the state file (default: ./logs/batch_{runId}.json) */
    stateFilePath?: string;
    /** Starting slippage in basis points (default: 300) */
    startSlippageBps?: number;
    /** Maximum slippage in basis points (default: 1000) */
    maxSlippageBps?: number;
    /** Structured logger (pino). Falls back to the root logger. */
    logger?: Logger;
}

// =============================================================================
// PURCHASE STATE
// =============================================================================

export type PurchaseStatus =
    | "pending"
    | "in_progress"
    | "completed"
    | "failed"
    | "abandoned";

export interface PurchaseRecord {
    /** A unique purchase id */
    id: string;
    /** The purchase index (1-based) */
    index: number;
    /** The scheduled moment (unix timestamp ms) */
    scheduledAt: number;
    /** SOL for this purchase. May be shrunk to fit what is left on the keeper. */
    solAmount: number;
    /** The originally planned amount, filled in only when the purchase was shrunk. */
    plannedSolAmount?: number;
    /** The current status */
    status: PurchaseStatus;
    /** The transaction signature (on success) */
    signature?: string;
    /** The signature of a sent but unconfirmed tx (checked before a retry) */
    pendingSignature?: string;
    /** Where it was bought */
    venue?: BuyVenue;
    /** How many attempts were made */
    attempts: number;
    /** The last slippage used (bps) */
    lastSlippageBps?: number;
    /** The error message (when failed) */
    errorMessage?: string;
    /** When it was last updated */
    updatedAt: number;
}

// =============================================================================
// BATCH STATE
// =============================================================================

export interface BatchSummary {
    /** How many purchases succeeded */
    completedPurchases: number;
    /** How many purchases were abandoned */
    abandonedPurchases: number;
    /** Total SOL spent */
    totalSolSpent: number;
    /** When it started */
    startedAt: number;
    /** When it finished (if it did) */
    finishedAt?: number;
}

export interface BatchState {
    /** A unique run id */
    runId: string;
    /** The token address */
    mint: string;
    /** The total amount of SOL */
    totalSolAmount: number;
    /** The number of purchases N */
    purchaseCount: number;
    /** The configuration */
    config: {
        windowMinutes: number;
        retryBufferMinutes: number;
        startSlippageBps: number;
        maxSlippageBps: number;
    };
    /** The purchases */
    purchases: PurchaseRecord[];
    /** The summary */
    summary: BatchSummary;
    /** Event metrics (the ones not derivable from statuses) */
    metrics?: BatchMetrics;
}

// =============================================================================
// METRICS (explicit counters for events not derivable from purchase statuses)
// =============================================================================

export interface BatchMetrics {
    venueRouting: {
        pumpfunDirect: number;        // #1
        dexDirect: number;            // #2
        fallbackToDex: number;        // #3
        fallbackToPumpswap: number;
        postSendErrorBlocked: number; // #4
    };
    pumpfun: {
        graduationDetected: number; // #5
        simulationFailed: number;   // #6
        sendFailed: number;         // #7
        onChainFailure: number;     // #8
        token2022Used: number;      // #9
    };
    dex: {
        quoteFailed: number;     // #10
        noRoute: number;         // #11
        swapBuildFailed: number; // #12
        timeout: number;         // #13
        onChainFailure: number;  // #14
    };
    retry: {
        slippageInstantRetry: number;        // #16
        slippageInstantRetrySuccess: number; // #17
        slippageInstantRetryFail: number;    // #18
        pendingTxConfirmed: number;          // #19, #23, #28
        nonRetryableAbandon: number;         // #20, #25
        retryableDeferred: number;           // #21
        unknownDeferred: number;             // #22
        retrySuccess: number;                // #24
        maxAttemptsAbandon: number;          // #26
        windowExpiredAbandon: number;        // #27
    };
    /** What happened to the keeper balance: purchases shrunk or hit zero. */
    balance: {
        shrunkToFit: number;
        abandonedEmpty: number;
        /** Shrunk AFTER a rejection for insufficient funds (the race for the shared balance). */
        shrunkAfterFailure: number;
    };
    errors: {
        retryable: number;                  // #31
        nonRetryable: number;               // #31
        unknown: number;                    // #31
        byPattern: Record<string, number>;  // #32
    };
}

// =============================================================================
// RESULT
// =============================================================================

export interface BatchBuyResult {
    /** The run id */
    runId: string;
    /** Path to the state file */
    stateFilePath: string;
    /** The result summary */
    summary: BatchSummary;
}
