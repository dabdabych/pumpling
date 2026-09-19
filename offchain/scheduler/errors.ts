// scheduler/errors.ts
// Error classification: retryable / non-retryable / unknown

import { extractCustomErrorCode, PUMP_SLIPPAGE_CODES } from "../pumpfun/errors";
import { ErrorVenue, getErrorVenue } from "../solana/transaction";

// =============================================================================
// TYPES
// =============================================================================

export type ErrorClass = "retryable" | "non-retryable" | "unknown";

export interface ErrorClassification {
    errorClass: ErrorClass;
    pattern: string | null;
}

// =============================================================================
// PATTERNS
// =============================================================================

/**
 * Errors worth repeating.
 * Usually temporary trouble with the network, RPC or an external service.
 */
export const RETRYABLE_PATTERNS: string[] = [
    // RPC / network
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "socket hang up",
    "fetch failed",
    "429",
    "Too Many Requests",
    "503",
    "Service Unavailable",
    "502",
    "Bad Gateway",

    // Solana transactions
    "blockhash not found",
    "Blockhash not found",
    "BlockhashNotFound",
    "block height exceeded",
    "TransactionExpiredBlockheightExceededError",
    "TransactionExpiredTimeoutError",

    // Timeouts
    "Request timeout",
    "timeout",
    "Timeout",

    // Slippage
    "Slippage",
    "slippage",
    "exceeds desired slippage",
    "ExceededSlippageToleranceError",

    // Jupiter, temporary
    "swap build failed: 500",
    "swap build failed: 503",
    "quote failed: 500",
    "quote failed: 503",
    "quote failed: 429",
];

/**
 * Errors that are pointless to repeat.
 * A retry is guaranteed to give the same result.
 */
export const NON_RETRYABLE_PATTERNS: string[] = [
    // Not enough funds
    "insufficient funds",
    "Insufficient funds",
    "InsufficientFundsError",
    "insufficient lamports",
    "insufficient funds for rent",

    // Invalid data
    "Mint account not found",
    "Account not found",
    "Invalid public key",
    "invalid public key",

    // No liquidity
    "No route found",
    "no liquidity",

    // Invalid request
    "quote failed: 400",
    "swap build failed: 400",

    // pump.fun specific
    "Pump Global account not found",
    "Pump Global account too small",

    // Token-2022 extensions that make delivery impossible. A retry changes
    // nothing: it is a property of the mint, not a network glitch.
    "cannot be distributed",
];

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classifies an error as retryable, non-retryable or unknown.
 *
 * The logic:
 * 1. Check NON_RETRYABLE_PATTERNS → non-retryable (abandon at once)
 * 2. Check RETRYABLE_PATTERNS → retryable (retry normally)
 * 3. In neither list → unknown (retry + a warning log)
 *
 * Non-retryable is checked first so that "insufficient funds" does not match
 * some retryable pattern by accident.
 */
export function classifyError(error: unknown): ErrorClassification {
    const message = error instanceof Error ? error.message : String(error);

    // non-retryable first
    for (const pattern of NON_RETRYABLE_PATTERNS) {
        if (message.includes(pattern)) {
            return { errorClass: "non-retryable", pattern };
        }
    }

    // then retryable
    for (const pattern of RETRYABLE_PATTERNS) {
        if (message.includes(pattern)) {
            return { errorClass: "retryable", pattern };
        }
    }

    // Slippage recognised by the program's error number. A separate branch,
    // because two of the three message formats carry no error name and none of
    // the string patterns above fire.
    if (isSlippageError(error)) {
        return { errorClass: "retryable", pattern: "slippage error code" };
    }

    // Nothing matched
    return { errorClass: "unknown", pattern: null };
}

/**
 * Whether a purchase with this error can be repeated.
 * Unknown errors count as retryable too (the conservative choice).
 */
export function isRetryableError(error: unknown): boolean {
    const { errorClass } = classifyError(error);
    return errorClass !== "non-retryable";
}

// =============================================================================
// SLIPPAGE-SPECIFIC
// =============================================================================

/**
 * Textual signs of slippage.
 *
 * NAMES and words only, no numbers. The bare code `0x1772` was removed from
 * here: it is 6002, which on pump.fun is TooMuchSolRequired but on the
 * aggregator is InvalidCalculation, so not slippage at all. The patterns are
 * checked before the venue is parsed, so such a code would produce a false
 * positive on the DEX path — the same defect as the original one. Numbers are
 * now only read together with the venue label.
 */
const SLIPPAGE_PATTERNS: string[] = [
    "Slippage",
    "slippage",
    "exceeds desired slippage",
    "ExceededSlippageToleranceError",
    "TooMuchSolRequired",
];

/**
 * Slippage codes by venue. An error number belongs to a particular program, so
 * the tables cannot be mixed: 6001 on Jupiter is slippage, while on pump.fun it
 * is AlreadyInitialized.
 *
 * Sources are the official IDLs and documentation:
 *   pumpfun  — pump.json: 6002 TooMuchSolRequired, 6003 TooLittleSolReceived,
 *              6042 BuySlippageBelowMinTokensOut
 *   dex      — Jupiter: 6001 SlippageToleranceExceeded (also 0x1771)
 *   pumpswap — pump_amm.json: 6004 ExceededSlippage,
 *              6040 BuySlippageBelowMinBaseAmountOut
 */
const VENUE_SLIPPAGE_CODES: Record<ErrorVenue, ReadonlySet<number>> = {
    pumpfun: PUMP_SLIPPAGE_CODES,
    dex: new Set([6001]),
    pumpswap: new Set([6004, 6040]),
};

/**
 * Whether this is slippage. The main loop uses the answer to decide whether to
 * raise the tolerance immediately (300 -> 500 -> 900) or defer the purchase to
 * the retry phase.
 *
 * The venue comes from the label attached when the error was thrown rather than
 * being guessed from the text. The previous version matched the substrings "DEX
 * transaction" and "Jupiter" and so failed to recognise `DEX simulation failed:
 * …`, which is exactly the common rejection for graduated coins, while wrongly
 * applying the pump.fun table to `PumpSwap simulation failed: …`.
 */
export function isSlippageError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (SLIPPAGE_PATTERNS.some((p) => message.includes(p))) {
        return true;
    }
    // Parsing by code, for the formats where the error name never reached the text.
    const code = extractCustomErrorCode(message);
    if (code === null) {
        return false;
    }
    const venue = getErrorVenue(error);
    if (!venue) {
        // No label means the program is unknown, and a bare number means
        // nothing on its own. Every purchase error is labelled in buy.ts, so
        // only foreign ones reach here (for example, restored from the state of
        // an earlier run). Guessing from those is inventing a diagnosis.
        return false;
    }
    return VENUE_SLIPPAGE_CODES[venue].has(code);
}
