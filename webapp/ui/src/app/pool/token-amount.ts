/**
 * Token amounts as the chain has them: raw integer units and the mint's
 * decimals. They arrive as decimal strings because a raw amount of a memecoin
 * does not fit a double exactly.
 *
 * Pure, so the rounding is checked without a browser (e2e/scenes).
 */

/** The whole-token value, or null when it cannot be known (no decimals, junk). */
export function tokenValue(raw: string | null | undefined, decimals: number | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return null;
  }
  const units = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = units % scale;
  return Number(whole) + (decimals > 0 ? Number(fraction) / Number(scale) : 0);
}

/**
 * 5.2M, 41.3K, 1.24B, 812 — for a feed row. One decimal from a thousand up, two
 * from a billion, whole below a thousand unless it is under one.
 */
export function compactTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return '';
  }
  const trim = (text: string) => text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  if (value >= 1e9) {
    return `${trim((value / 1e9).toFixed(2))}B`;
  }
  if (value >= 1e6) {
    return `${trim((value / 1e6).toFixed(1))}M`;
  }
  if (value >= 1e3) {
    return `${trim((value / 1e3).toFixed(1))}K`;
  }
  if (value >= 1) {
    return String(Math.floor(value));
  }
  return value > 0 ? trim(value.toPrecision(2)) : '0';
}

/**
 * 52,313,440 — the exact whole tokens, grouped, for the verification window.
 * Exact because it is done on the raw integer, never on a double. Fractions
 * are dropped: a verifier compares with an explorer, which shows the same.
 */
export function exactTokens(raw: string | null | undefined, decimals: number | null | undefined): string {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return '';
  }
  const whole = (BigInt(raw) / 10n ** BigInt(decimals)).toString();
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
