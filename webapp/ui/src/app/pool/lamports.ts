/**
 * SOL and lamports without floating point. `Math.floor(sol * 1e9)` lost a
 * lamport on some amounts (0.07 × 1e9 = 69999999.99…), while the backend checks
 * the commit amount against the transaction to the lamport and rejected it.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "1.5", "0,05", ".5" → lamports. null means not a number, more than 9 decimals, or not above zero. */
export function parseSolToLamports(input: string): bigint | null {
  const text = String(input ?? '').trim().replace(',', '.');
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || text === '' || text === '.') {
    return null;
  }
  const whole = match[1] || '0';
  const fraction = match[2] ?? '';
  if (fraction.length > 9) {
    return null;
  }
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, '0') || '0');
  return lamports > 0n ? lamports : null;
}

/** Lamports → SOL as a number. The shortest form of the number is what the backend reads. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/** Lamports → a SOL string with no trailing zeros: 50000000 → "0.05". */
export function formatLamports(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** SOL as a number → lamports, rounded down, for limits from the API (what is left of the cap). */
export function solToLamportsFloor(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) {
    return 0n;
  }
  // Through a fixed-precision string: that way 46.5 does not become 46.499999999.
  const parsed = parseSolToLamports(sol.toFixed(9));
  return parsed ?? 0n;
}
