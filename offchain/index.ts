// src/index.ts
// The module's main exports

export { buy, buyPumpfun, buyDex, isBondingCurveActive } from "./buy";
export type { BuyResult, BuyVenue } from "./buy";

export { logger } from "./logger";
export type { Logger } from "./logger";

export { send, buildSendTransaction } from "./send";
export type { SendResult } from "./send";

export {
    buildPumpfunBuyTransaction,
    fetchBondingCurveInfo,
    calculateBuyParams,
} from "./pumpfun/buy";
export type { BondingCurveInfo, BuyParams } from "./pumpfun/buy";

export { getTokenPrice, estimateTokensOut } from "./pumpfun/price";
export type { TokenPriceInfo } from "./pumpfun/price";

export { getBondingCurveState, checkGraduation } from "./pumpfun/graduation";
export type { BondingCurveState } from "./pumpfun/graduation";

export { connection, createProvider } from "./solana/connection";

export { sendTransaction } from "./solana/transaction";

export {
    PUMP_PROGRAM_ID,
    PUMPSWAP_PROGRAM_ID,
    RPC_ENDPOINT,
    // PDA derivations
    getGlobalAddress,
    getBondingCurveAddress,
    getEventAuthorityAddress,
    // Jupiter config
    JUPITER_BASE_URL,
    JUPITER_QUOTE_URL,
    JUPITER_SWAP_URL,
    SLIPPAGE_BPS,
    PRIORITIZATION_FEE_LAMPORTS,
} from "./solana/config";

// Scheduler (batch purchases)
export { batchBuy } from "./scheduler";
export type {
    BatchBuyParams,
    BatchBuyResult,
    BatchState,
    BatchSummary,
    BatchMetrics,
    PurchaseRecord,
    PurchaseStatus,
} from "./scheduler";
export { calculateN, calculateFees, splitAmount } from "./scheduler";
export type { FeeBreakdown } from "./scheduler";

// Orchestrator (lottery lifecycle)
export { executeLottery } from "./orchestrator";
export type {
    ExecuteLotteryParams,
    TokenEntry,
    RecipientEntry,
    LotteryResult,
    LotteryState,
    LotteryMetrics,
    LotterySummary,
    SendRecord,
    SendStatus,
    TokenBuyRecord,
} from "./orchestrator";
