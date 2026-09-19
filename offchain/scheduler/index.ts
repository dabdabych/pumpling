// scheduler/index.ts
// The scheduler module's exports

// Main function
export { batchBuy } from "./batch";

// Types
export type {
    BatchBuyParams,
    BatchBuyResult,
    BatchState,
    BatchSummary,
    BatchMetrics,
    PurchaseRecord,
    PurchaseStatus,
} from "./types";

// Fees
export {
    calculateN,
    calculateFees,
    splitAmount,
    ATA_FEE_SOL,
    TX_FEE_SOL,
} from "./fees";
export type { FeeBreakdown } from "./fees";

// Timing
export {
    generateScheduleOffsets,
    createSchedule,
    sleepUntil,
    sleep,
    formatDuration,
} from "./timing";

// Slippage
export {
    getSlippageForAttempt,
    canRetry,
    formatSlippage,
    SLIPPAGE_SCHEDULE_BPS,
    MAX_RETRIES,
} from "./slippage";

// State
export {
    BatchStateManager,
    generateRunId,
    generatePurchaseId,
    getDefaultStatePath,
} from "./state";

// Errors
export {
    classifyError,
    isRetryableError,
    RETRYABLE_PATTERNS,
    NON_RETRYABLE_PATTERNS,
} from "./errors";
export type { ErrorClass, ErrorClassification } from "./errors";
