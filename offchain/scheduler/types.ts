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

/** One transaction a purchase sent. */
export interface SentAttemptRecord {
    signature: string;
    lastValidBlockHeight: number;
    /** When it was signed, unix ms. */
    at: number;
}

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
    /** The blockhash limit of `pendingSignature`: until the chain is past it, it may still land. */
    pendingLastValidBlockHeight?: number;
    /**
     * Every transaction this purchase put on the wire, written down before it
     * went out. Whatever became of each, the chain has the answer: the round's
     * accounting asks about all of them, so a purchase that landed is counted
     * however the process that sent it ended.
     */
    sentAttempts?: SentAttemptRecord[];
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
    /**
     * When the second pass began, and when it runs out.
     *
     * Set only if the main window left something unbought. The site shows the
     * difference: a round in its second pass is still buying, and its own
     * countdown ends at `retryEndsAt` rather than at the end of the main
     * window. A batch that needed no second pass never has these.
     */
    retryStartedAt?: number;
    retryEndsAt?: number;
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
        /**
         * Whether the keeper already held a token account for this coin.
         *
         * False means the first purchase also paid its rent — about 0.0015 SOL,
         * measured 2026-09-25 — and the refund accounting has to know when it
         * cannot read that purchase from the chain.
         */
        hadAtaAtStart?: boolean;
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
        /** The retry ladder stopped: its last attempt might still land. */
        inFlightStopped?: number;
        /** Main loop: signed again after the blockhash provably expired. */
        expiredResigned?: number;
        expiredResignSuccess?: number;
        /** Main loop: expired, but the chain would not confirm it dead in time; left to the retry phase. */
        expiryStillInFlight?: number;
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
