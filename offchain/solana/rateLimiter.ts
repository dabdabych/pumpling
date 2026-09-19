// offchain/solana/rateLimiter.ts
// The rate limiter for sending transactions to the network.

/**
 * Why it exists.
 *
 * The RPC provider has its own ceiling on `sendTransaction`: five calls a
 * second on the Helius Developer plan. The buyer buys several coins in parallel
 * and delivers tokens at the same time, so at peak it easily hits that ceiling.
 * The provider answers 429, the retry goes into the buffer, and with bad luck
 * the purchase falls into abandoned — which means somebody else's money stays
 * unspent because of our own haste.
 *
 * How it works: slots are handed out in turn, exactly once every `1/rate`
 * seconds. Idle time can build up credit for at most `burst` slots, otherwise
 * after a pause the buyer would fire a volley and hit the limit again.
 *
 * An important subtlety: the slot is taken BEFORE the transaction is signed. A
 * blockhash lives about a minute, and signing first and then queueing would let
 * the signature go stale and the transaction fail with "blockhash not found".
 */
export class RateLimiter {
    private readonly intervalMs: number;
    private readonly burstSlots: number;
    /** The time before which the next slot is not handed out. */
    private nextSlotAt = 0;
    private granted = 0;
    private waited = 0;
    private totalWaitMs = 0;

    constructor(ratePerSecond: number, burst?: number) {
        const rate = Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? ratePerSecond : 1;
        this.intervalMs = 1000 / rate;
        this.burstSlots = Math.max(1, Math.floor(burst ?? rate));
    }

    /**
     * Waits for its turn and returns how long it had to wait, in milliseconds.
     *
     * Call order is preserved: the slot is reserved at the moment of the call,
     * not after the wait.
     */
    async acquire(): Promise<number> {
        const now = Date.now();
        // Idle time builds credit, but no more than `burstSlots` slots.
        const earliest = now - (this.burstSlots - 1) * this.intervalMs;
        const slotAt = Math.max(this.nextSlotAt, earliest);
        this.nextSlotAt = slotAt + this.intervalMs;

        const waitMs = Math.max(0, slotAt - now);
        this.granted += 1;
        if (waitMs > 0) {
            this.waited += 1;
            this.totalWaitMs += waitMs;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        return waitMs;
    }

    /** How many slots were handed out, how many of them waited, and the total wait. */
    stats(): { granted: number; waited: number; totalWaitMs: number; intervalMs: number } {
        return {
            granted: this.granted,
            waited: this.waited,
            totalWaitMs: this.totalWaitMs,
            intervalMs: this.intervalMs,
        };
    }

    /** For tests only: forget the queue and the counters. */
    reset(): void {
        this.nextSlotAt = 0;
        this.granted = 0;
        this.waited = 0;
        this.totalWaitMs = 0;
    }
}
