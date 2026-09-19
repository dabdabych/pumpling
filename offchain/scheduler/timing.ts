// scheduler/timing.ts
// Working out times and slots for purchases

// =============================================================================
// GENERATE SCHEDULE
// =============================================================================

/**
 * Generates randomised time offsets for N purchases.
 *
 * The logic:
 * 1. Splits the window into N equal slots
 * 2. Picks a random moment inside each slot
 * 3. Guarantees a minimum interval between purchases
 *
 * @param n - the number of purchases
 * @param windowMs - the window length in milliseconds
 * @param minGapMs - the minimum interval between purchases (default: 5000)
 * @returns offsets from the start, in milliseconds
 *
 * @example
 * generateScheduleOffsets(5, 50 * 60 * 1000)
 * // [123456, 678901, 1234567, 1890123, 2456789]
 * // (random moments within 50 minutes)
 */
export function generateScheduleOffsets(
    n: number,
    windowMs: number,
    minGapMs: number = 5000
): number[] {
    if (n <= 0 || windowMs <= 0) {
        return [];
    }

    if (n === 1) {
        // A single purchase goes at a random moment in the first half of the window
        return [Math.floor(Math.random() * (windowMs / 2))];
    }

    const slotSize = windowMs / n;
    const offsets: number[] = [];

    for (let i = 0; i < n; i++) {
        const slotStart = i * slotSize;
        const slotEnd = (i + 1) * slotSize;

        // Headroom for the minimum interval
        const adjustedStart = i === 0 ? slotStart : slotStart + minGapMs / 2;
        const adjustedEnd = i === n - 1 ? slotEnd : slotEnd - minGapMs / 2;

        // A random moment inside the slot
        const offset =
            adjustedStart + Math.random() * (adjustedEnd - adjustedStart);
        offsets.push(Math.floor(offset));
    }

    return offsets;
}

/**
 * Builds the full schedule with absolute times.
 *
 * @param n - the number of purchases
 * @param startTime - the start (unix timestamp ms)
 * @param windowMinutes - the window length in minutes
 * @returns the absolute timestamps
 *
 * @example
 * createSchedule(5, Date.now(), 50)
 * // [1707394200500, 1707394800123, ...]
 */
export function createSchedule(
    n: number,
    startTime: number,
    windowMinutes: number
): number[] {
    const windowMs = windowMinutes * 60 * 1000;
    const offsets = generateScheduleOffsets(n, windowMs);
    return offsets.map((offset) => startTime + offset);
}

// =============================================================================
// SLEEP UTILITIES
// =============================================================================

/**
 * Waits until a given moment.
 *
 * @param targetTime - the target moment (unix timestamp ms)
 * @returns a Promise that resolves when it arrives
 *
 * @example
 * await sleepUntil(Date.now() + 5000) // wait 5 seconds
 */
export function sleepUntil(targetTime: number): Promise<void> {
    const now = Date.now();
    const delay = Math.max(0, targetTime - now);

    if (delay === 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Waits for a number of milliseconds.
 *
 * @param ms - the number of milliseconds
 *
 * @example
 * await sleep(1000) // wait 1 second
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// TIME FORMATTING
// =============================================================================

/**
 * Formats milliseconds into something human readable.
 *
 * @param ms - milliseconds
 * @returns a string like "5m 30s" or "1h 23m"
 *
 * @example
 * formatDuration(330000) // "5m 30s"
 * formatDuration(5000000) // "1h 23m"
 */
export function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}
