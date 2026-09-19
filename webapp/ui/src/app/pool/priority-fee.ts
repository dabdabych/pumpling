/**
 * The commit priority fee.
 *
 * Why it exists at all. A validator takes transactions into a block by their
 * price per compute unit. Without a priority fee a commit during a busy hour may
 * simply never arrive, and to a person that looks like "nothing happened" even
 * though the wallet signed everything.
 *
 * How much to pay is not decided by the site: the price comes from the network
 * itself (`getRecentPrioritizationFees` — what was paid over the last hundred and
 * fifty slots). If the network is silent or answers with zeros, we take the lower bound.
 *
 * The person is shown three levels and the price in SOL. The limits are hard at
 * both ends: below the lower bound paying is pointless, above the upper one it is
 * never needed, and the ceiling guards against an accidental extra zero.
 */

export type PriorityLevel = 'normal' | 'fast' | 'turbo';

/** A deposit fits into roughly thirty thousand units; we ask with headroom. */
export const DEPOSIT_COMPUTE_UNITS = 60_000;

/** Microlamports per compute unit. */
export const MIN_MICRO_LAMPORTS = 10_000;
/** The ceiling for the network estimate: we do not raise the "normal" level above it. */
export const MAX_ESTIMATE_MICRO_LAMPORTS = 200_000;
/** A hard ceiling for any level. A commit must never cost more than this. */
export const MAX_MICRO_LAMPORTS = 2_000_000;

export const PRIORITY_MULTIPLIERS: Record<PriorityLevel, number> = {
  normal: 1,
  fast: 3,
  turbo: 10,
};

export const PRIORITY_LEVELS: PriorityLevel[] = ['normal', 'fast', 'turbo'];
/** The recommended level: the network price with no markup. */
export const RECOMMENDED_LEVEL: PriorityLevel = 'normal';

export interface PrioritizationFeeSample {
  slot?: number;
  prioritizationFee?: number;
}

/**
 * The estimate from the network's sample.
 *
 * We take the median of the non-zero samples. Zeros are slots where nobody paid
 * extra, and counting them means understating the price where the queue is real.
 * The median rather than the maximum: one expensive block of somebody else's must
 * not push the price up for everyone.
 */
export function estimateFromSamples(samples: PrioritizationFeeSample[] | null | undefined): number | null {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }
  const fees = samples
    .map((sample) => Number(sample?.prioritizationFee))
    .filter((fee) => Number.isFinite(fee) && fee > 0)
    .sort((a, b) => a - b);
  if (fees.length === 0) {
    return null;
  }
  const middle = Math.floor(fees.length / 2);
  const median = fees.length % 2 === 0 ? (fees[middle - 1] + fees[middle]) / 2 : fees[middle];
  return Math.round(median);
}

/** The price per compute unit for a level, within both bounds. */
export function priceFor(level: PriorityLevel, estimate: number | null): number {
  const base = clamp(
    Number.isFinite(estimate as number) && (estimate as number) > 0 ? (estimate as number) : MIN_MICRO_LAMPORTS,
    MIN_MICRO_LAMPORTS,
    MAX_ESTIMATE_MICRO_LAMPORTS
  );
  const multiplier = PRIORITY_MULTIPLIERS[level] ?? 1;
  return clamp(Math.round(base * multiplier), MIN_MICRO_LAMPORTS, MAX_MICRO_LAMPORTS);
}

/** What the priority costs, in SOL. */
export function feeSol(microLamportsPerUnit: number, units = DEPOSIT_COMPUTE_UNITS): number {
  const lamports = (units * microLamportsPerUnit) / 1_000_000;
  return lamports / 1_000_000_000;
}

/** A short caption under a level button: "+0.000006 SOL". */
export function feeLabel(microLamportsPerUnit: number, units = DEPOSIT_COMPUTE_UNITS): string {
  const sol = feeSol(microLamportsPerUnit, units);
  if (sol <= 0) {
    return '+0 SOL';
  }
  // The amounts here are well below a cent, so seven decimals rather than two:
  // exponential notation like 6.0e-7 does not read at all in an interface.
  return `+${trimZeros(sol.toFixed(7))} SOL`;
}

export function isPriorityLevel(value: unknown): value is PriorityLevel {
  return value === 'normal' || value === 'fast' || value === 'turbo';
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
