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
    /** The same commit in lamports, exact, when the backend sends it. */
    amountLamports?: string;
    /**
     * How much of what is bought for this wallet it asked to have burned, in
     * basis points (10000 = all of it). Absent means none.
     *
     * The choice is made in the commit transaction itself, as a memo the wallet
     * signed, and the backend reads it from there; see `shared/burn_memo.py`.
     * The buyer takes it as given.
     */
    burnBps?: number;
    /**
     * The exact form of the same choice: Σ(lamports × bps) over this wallet's
     * commits to the coin, as a decimal string. A wallet can commit twice with
     * different choices, and a single averaged `burnBps` would have to be
     * rounded; this does not. When present it wins over `burnBps`.
     */
    burnWeight?: string;
}

/** Who stood behind a coin, as the round was handed to the buyer. */
export interface RecipientStake {
    wallet: string;
    /** The commit, in lamports, as a decimal string: bigint arithmetic throughout. */
    stakeLamports: string;
    /** 0..10000, commit-weighted, for display. The arithmetic uses `burnWeight`. */
    burnBps: number;
    /** Σ(lamports × bps), decimal string. Absent in a state written before it existed. */
    burnWeight?: string;
}

/**
 * One burn transaction: a share of what was bought for a coin, destroyed.
 *
 * The lifecycle is the delivery's, for the same reason and more so. A delivery
 * sent twice overpays one person; a burn sent twice destroys tokens that belong
 * to somebody else. So a burn that went out without a confirmation keeps its
 * signature, and nothing is burned again until that signature has been looked
 * up on chain.
 */
export interface BurnRecord {
    id: string;
    mint: string;
    /** Raw units, decimal string. */
    rawAmount: string;
    status: "in_progress" | "completed" | "failed";
    signature?: string;
    pendingSignature?: string;
    /** The last block height at which `pendingSignature` can still land. */
    pendingLastValidBlockHeight?: number;
    attempts: number;
    errorMessage?: string;
    createdAt: number;
    updatedAt: number;
}

// =============================================================================
// STATE RECORDS
// =============================================================================

export interface TokenBuyRecord {
    mint: string;
    /**
     * The coin's whole share of the pool, as the draw set it, before the
     * delivery reserve was taken out of it.
     *
     * A record rather than a working figure: the refund is worked out from
     * `adjustedSolAmount` plus a share of what delivery did not spend (see
     * `refundLedger`). It is here because without it the round's file cannot
     * answer "what did the draw give this coin", and that is the first
     * question anybody asks of it afterwards.
     */
    targetSolAmount?: number;
    /** What the buying may spend: the share above, less the delivery reserve. */
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
    /**
     * Who committed to this coin and what each asked to have burned.
     *
     * Kept apart from the deliveries on purpose. Somebody who burns everything
     * has no deliveries at all, and anything that looked for them there — the
     * refund of unspent SOL, the verification page — would not find them.
     */
    recipients?: RecipientStake[];
    /** Raw units burned for this coin so far, confirmed on chain. Decimal string. */
    burnedRaw?: string;
    /** Set when the coin cannot be burned any more; its tokens are kept, not delivered. */
    burnBlocked?: { reason: string; at: number };
    /** The mint's supply before the first purchase and after the round, raw units. */
    supplyAtStart?: string;
    supplyAtEnd?: string;
    /** The mint's decimals, read with the supply: every raw figure of this coin is in them. */
    decimals?: number;
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
    /**
     * What left the keeper for this delivery, raw units. The same as `amount`
     * except on a mint with a transfer fee, where `amount` is what arrived.
     * A coin with burners is delivered against this figure: a wallet's share
     * is an allocation of the keeper's tokens, so the fee on its own transfers
     * comes out of its own share and never out of anybody else's, or the fire's.
     */
    grossAmount?: string;
    status: SendStatus;
    /**
     * A top-up added after the buying ended, for a recipient whose share grew
     * after their last delivery. See `settle.ts`.
     */
    topUp?: boolean;
    signature?: string;
    /**
     * The signature of a transaction that went out but whose confirmation we
     * never saw. It is checked before a repeat: if the delivery arrived it must
     * not be sent a second time, or the recipient would get a double share
     * while the others came up short out of the same remainder.
     */
    pendingSignature?: string;
    /** The last block height at which `pendingSignature` can still land. */
    pendingLastValidBlockHeight?: number;
    /**
     * Earlier attempts that reached the chain and failed there. Nothing was
     * delivered by them, but each paid its fee, and the refund accounting reads
     * what the round was charged from every signature it ever sent.
     */
    failedSignatures?: string[];
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
    /** Burn transactions, every coin together. */
    burns?: BurnRecord[];
    /**
     * Tokens each completed purchase brought, raw units as a decimal string,
     * keyed by the purchase signature. Read from the confirmed transaction
     * itself rather than from the keeper's balance: a balance read straight
     * after our own transaction can come back from a node that has not caught
     * up yet (seen on 2026-09-28), and a burn worked out from a stale balance
     * destroys tokens that belong to somebody else.
     */
    purchaseTokens?: Record<string, string>;
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
