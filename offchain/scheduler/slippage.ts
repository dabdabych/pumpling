// scheduler/slippage.ts
// Slippage escalation strategy

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The slippage escalation ladder for retries.
 *
 * The top step was lowered from 2000 to 1300 bps: 20% of overpayment means
 * buying tokens for the round's participants far worse than the market, at
 * exactly the moment the coin is being pushed. Better to fall short on part of
 * it than to hand people something we overpaid a fifth for.
 */
export const SLIPPAGE_SCHEDULE_BPS = [300, 500, 900, 1300];

/** The maximum number of retries */
export const MAX_RETRIES = SLIPPAGE_SCHEDULE_BPS.length - 1;

// =============================================================================
// SLIPPAGE CALCULATION
// =============================================================================

/**
 * Works out the slippage for a particular attempt.
 *
 * Attempt 1 uses startSlippageBps. Retries escalate through the
 * SLIPPAGE_SCHEDULE_BPS steps that are above startSlippageBps.
 *
 * Examples at startSlippageBps=300 (the default):
 *
 * Examples at startSlippageBps=100:
 *
 * @param attempt - the attempt number (1-based)
 * @param startSlippageBps - the starting slippage
 * @param maxSlippageBps - the maximum slippage
 */
export function getSlippageForAttempt(
    attempt: number,
    startSlippageBps: number,
    maxSlippageBps: number
): number {
    if (attempt <= 1) {
        return Math.min(startSlippageBps, maxSlippageBps);
    }

    // Retries: the ladder steps above startSlippageBps
    const escalation = SLIPPAGE_SCHEDULE_BPS.filter((s) => s > startSlippageBps);
    if (escalation.length === 0) {
        // startSlippageBps is already >= every step
        return Math.min(startSlippageBps, maxSlippageBps);
    }

    const idx = Math.min(attempt - 2, escalation.length - 1);
    return Math.min(escalation[idx], maxSlippageBps);
}

/**
 * Whether another attempt is allowed.
 *
 * @param currentAttempts - how many attempts have been made
 * @returns true if a retry is allowed
 *
 * @example
 * canRetry(0) // true (the first attempt is allowed)
 * canRetry(1) // true (retry #1 is allowed)
 * canRetry(2) // true (retry #2 is allowed)
 * canRetry(3) // false (exhausted)
 */
export function canRetry(currentAttempts: number): boolean {
    return currentAttempts <= MAX_RETRIES;
}

/**
 * Returns a human readable description of a slippage, for logging.
 *
 * @param bps - slippage in basis points
 * @returns a string like "1.5%"
 *
 * @example
 * formatSlippage(150) // "1.5%"
 * formatSlippage(1000) // "10%"
 */
export function formatSlippage(bps: number): string {
    return `${(bps / 100).toFixed(1)}%`;
}
