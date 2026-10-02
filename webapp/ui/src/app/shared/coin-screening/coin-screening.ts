/**
 * The red-flag check on a coin, as the site shows it.
 *
 * The backend checks each coin once, at the first commit to it in a pool, and
 * answers `clean` or `flagged`, with the level it read for each holder rule
 * (`webapp/backend/shared/coin_screening.py`). The card shows those readings as
 * ranges, the way pump.fun shows its numbers, and the red ones are the flags. It
 * never sums a coin up in words: the first version put "No red flags" over a
 * sentence about the coin, which read as if we vouched for it, and on a coin
 * still on its curve it said its liquidity was in place, which nobody can pull
 * from a curve anyway.
 *
 * The mark on the row is the same for every coin checked, a black tick on a
 * white square: it says the coin was checked. A red mark, or a count of red
 * flags in the card, scared people off a coin its launcher paid to promote.
 * Whoever wants the readings opens the card, where the flags are the red lines.
 *
 * A coin with no answer has nothing here and the site shows nothing, exactly as
 * before the check existed. The words never say "safe", "scam" or "verified":
 * tracced's terms forbid the first and the last, and "verified" is taken on this
 * site by the program's verified build.
 *
 * Pure: the badge component and the backend's test both read this file.
 */
import type { CoinScreeningResponse } from '../../api-client/models/coin-screening-response';

export type ScreeningStatus = 'clean' | 'flagged';
export type ScreeningSource = 'tracced' | 'solana_tracker' | 'chain';
export type Level = 'low' | 'medium' | 'high' | 'unknown';
type HolderRule = 'dev' | 'bundle' | 'bundled_launch' | 'top10' | 'insiders';

export interface CoinScreening {
  status: ScreeningStatus;
  /** Reason codes, in the backend's order. */
  reasons: string[];
  /** The level read for each holder rule; empty for a check made before levels were kept. */
  levels: Partial<Record<HolderRule, Level>>;
  source: ScreeningSource | null;
  checkedAtMs: number;
}

/** One line of the card. */
export interface ScreeningRow {
  label: string;
  value: string;
  flagged: boolean;
  /** The source had no data for it. */
  unknown: boolean;
}

/** The holder rules in the card's order, with the shares behind each level (the backend's `CUTS`). */
const HOLDER_ROWS: ReadonlyArray<{ rule: HolderRule; label: string; reason: string; low: string; medium: string; high: string }> = [
  { rule: 'dev', label: 'Dev', reason: 'creator_over_20', low: 'under 5%', medium: '5–20%', high: 'over 20%' },
  { rule: 'bundle', label: 'Bundlers', reason: 'bundles_over_20', low: 'under 5%', medium: '5–20%', high: 'over 20%' },
  { rule: 'bundled_launch', label: 'Bundled at launch', reason: 'bundled_launch', low: 'under 20%', medium: '20–50%', high: 'over 50%' },
  { rule: 'top10', label: 'Top 10', reason: 'top10_over_40_on_curve', low: 'under 20%', medium: '20–40%', high: 'over 40%' },
  { rule: 'insiders', label: 'Insiders', reason: 'insiders_over_15', low: 'under 5%', medium: '5–15%', high: 'over 15%' }
];

/**
 * Every reason code the backend can send (`shared/coin_screening.REASONS`) and
 * the row it reddens. The holder rules redden their own row; the mint's powers
 * have a row each, in the words traders use for them.
 */
export const REASON_ROW: Record<string, { label: string; value: string }> = {
  creator_over_20: { label: 'Dev', value: 'over 20%' },
  bundles_over_20: { label: 'Bundlers', value: 'over 20%' },
  bundled_launch: { label: 'Bundled at launch', value: 'over 50%' },
  top10_over_40_on_curve: { label: 'Top 10', value: 'over 40%' },
  insiders_over_15: { label: 'Insiders', value: 'over 15%' },
  liquidity_pulled: { label: 'Liquidity', value: 'pulled' },
  freeze_authority: { label: 'Freeze authority', value: 'active' },
  mint_authority: { label: 'Mint authority', value: 'active' },
  permanent_delegate: { label: 'Permanent delegate', value: 'set' },
  non_transferable: { label: 'Transfers', value: 'disabled' },
  frozen_by_default: { label: 'New accounts', value: 'frozen' },
  pausable: { label: 'Transfers', value: 'can be paused' }
};

const HOLDER_REASONS = new Set(HOLDER_ROWS.map((row) => row.reason));

const SOURCES: Record<ScreeningSource, { label: string; href: string | null }> = {
  tracced: { label: 'Checked by tracced', href: 'https://tracced.xyz' },
  solana_tracker: { label: 'Checked by Solana Tracker', href: 'https://www.solanatracker.io' },
  chain: { label: 'Read from the coin’s own account', href: null }
};

const LEVELS: readonly string[] = ['low', 'medium', 'high', 'unknown'];

function isSource(value: unknown): value is ScreeningSource {
  return value === 'tracced' || value === 'solana_tracker' || value === 'chain';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function levelsOf(value: unknown): Partial<Record<HolderRule, Level>> {
  const out: Partial<Record<HolderRule, Level>> = {};
  if (!value || typeof value !== 'object') {
    return out;
  }
  for (const { rule } of HOLDER_ROWS) {
    const level = (value as Record<string, unknown>)[rule];
    if (typeof level === 'string' && LEVELS.includes(level)) {
      out[rule] = level as Level;
    }
  }
  return out;
}

/** The API's answer, or null when there is nothing the site should show. */
export function toCoinScreening(raw: CoinScreeningResponse | null | undefined): CoinScreening | null {
  if (!raw || (raw.status !== 'clean' && raw.status !== 'flagged')) {
    return null;
  }
  const checkedAtMs = Date.parse(raw.checked_at);
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  const reasons = strings(raw.reasons);
  // A flag with no reason the site knows would be a count with no line under it: show nothing instead.
  if (raw.status === 'flagged' && !reasons.some((code) => code in REASON_ROW)) {
    return null;
  }
  return {
    status: raw.status,
    reasons,
    levels: levelsOf(raw.levels),
    source: isSource(raw.source) ? raw.source : null,
    checkedAtMs
  };
}

/**
 * The card's lines: each holder rule with the range it was read in, then the
 * mint's powers. A rule with no reading is left out unless it was the flag
 * (a check from before the levels were kept). Liquidity has a line only when
 * it was pulled: a coin on its curve has none to pull, and a line saying it is
 * in place would be a promise about tomorrow.
 */
export function screeningRows(screening: CoinScreening): ScreeningRow[] {
  const reasons = new Set(screening.reasons.filter((code) => code in REASON_ROW));
  const rows: ScreeningRow[] = [];
  for (const spec of HOLDER_ROWS) {
    const level = screening.levels[spec.rule];
    const flagged = reasons.has(spec.reason);
    if (level === undefined) {
      if (flagged) {
        rows.push({ label: spec.label, value: spec.high, flagged: true, unknown: false });
      }
      continue;
    }
    const unknown = level === 'unknown';
    rows.push({ label: spec.label, value: unknown ? 'no data' : spec[level], flagged, unknown });
  }
  const powers = screening.reasons.filter((code) => reasons.has(code) && !HOLDER_REASONS.has(code));
  for (const code of powers) {
    rows.push({ ...REASON_ROW[code], flagged: true, unknown: false });
  }
  // Clean needs the mint read: a clean coin's mint gives its issuer none of those powers.
  if (screening.status === 'clean') {
    rows.push({ label: 'Mint & freeze', value: 'revoked', flagged: false, unknown: false });
  }
  return rows;
}

export const SCREENING_TITLE = 'Coin check';

function coinName(ticker: string): string {
  return ticker ? `$${ticker}` : 'this coin';
}

/** The mark's accessible name. The same for every coin, as the mark is. */
export function badgeLabel(ticker: string): string {
  return `${SCREENING_TITLE} on ${coinName(ticker)}. Show the check`;
}

/** The card's accessible name. */
export function cardLabel(ticker: string): string {
  return `${SCREENING_TITLE} on ${coinName(ticker)}`;
}

export function sourceOf(screening: CoinScreening): { label: string; href: string | null } {
  return SOURCES[screening.source ?? 'chain'];
}

/** How long ago the check ran, in the words a person uses. */
export function checkedAgo(checkedAtMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - checkedAtMs) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** When the check ran: once, at the first commit to the coin in this pool. */
export function checkedLine(screening: CoinScreening, nowMs: number): string {
  return `At the first commit in this pool, ${checkedAgo(screening.checkedAtMs, nowMs)}`;
}
