import { ActiveLotterySummaryResponse } from '../api-client/models/active-lottery-summary-response';
import { HypeCountdownResponse } from '../api-client/models/hype-countdown-response';
import { LotteryListResponse } from '../api-client/models/lottery-list-response';
import { LotteryWinnerResultResponse } from '../api-client/models/lottery-winner-result-response';
import { LotteryEntryResponse } from '../api-client/models/lottery-entry-response';

/**
 * The pool state for the interface, from the `/lottery/current` answer and the
 * current time. A pure function with no Angular: the card on the main page, the
 * pool page and the commit dialog all see the same phase, and it can be checked
 * without a browser.
 *
 * The phases are named as in How it works on the main page:
 *
 *   launch   a countdown to the launch runs before the first pool;
 *   waiting  there is no pool, the next one opens by itself;
 *   opening  the pool is being created on chain and does not take SOL yet;
 *   open     it takes SOL;
 *   locked   it takes no more SOL: the time ran out or the cap was reached.
 *            First it waits for the draw (draw = pending), then the draw runs
 *            (draw = running);
 *   buying   the draw is done and the hour of buying is running;
 *   done     the buying window ended, the next pool opens by itself.
 *
 * The backend hands out program statuses (created, phase2started, vrf_binded,
 * vrf_fulfilled, proceeding_purchases, closed). The gap between those and the
 * interface phases is closed here rather than in the templates.
 */

export type PoolMarket = 'dex' | 'pumpfun';

export type PoolPhase = 'loading' | 'launch' | 'waiting' | 'opening' | 'open' | 'locked' | 'buying' | 'done';

export type DrawStatus = 'pending' | 'running' | 'ready';

export interface PoolCoin {
  mint: string;
  name: string;
  ticker: string;
  logoUrl: string | null;
  /** The SOL committed behind this coin. */
  sol: number;
  commits: number;
  /** The coin's share of the pool before the draw, 0..1. */
  poolShare: number;
  /** SOL for buying this coin after the draw and the fee; 0 means the share went to zero; null means the draw has not happened. */
  drawnSol: number | null;
}

export interface PoolAccounts {
  lotteryPda: string | null;
  vaultPda: string | null;
  adminPubkey: string | null;
}

export interface PoolSnapshot {
  market: PoolMarket;
  phase: PoolPhase;
  draw: DrawStatus | null;
  poolId: number | null;
  /** When the pool stops taking SOL. */
  closesAtMs: number | null;
  buysStartedAtMs: number | null;
  /** When the buying window ends. */
  buysEndAtMs: number | null;
  /** When the next pool opens: the end of the buying window plus the "done" pause. */
  nextPoolAtMs: number | null;
  /** When the draw started and roughly when it ends. */
  drawStartedAtMs: number | null;
  drawEndsAtMs: number | null;
  launchAtMs: number | null;
  totalSol: number;
  capSol: number;
  /** How much more can be committed, in SOL. */
  remainingSol: number;
  /** The amount that goes into buying after the fee. */
  buyBudgetSol: number;
  coins: PoolCoin[];
  accounts: PoolAccounts | null;
}

/** The platform fee, 3%. The same as `fee_bps` in the program and in the draw. */
export const POOL_FEE_BPS = 300;
/** The program's minimum commit (MIN_AMOUNT_LAMPORTS_DEFAULT). */
export const MIN_COMMIT_SOL = 0.05;
/** A fallback cap until the first API answer; the real one arrives in max_total. */
export const DEFAULT_CAP_SOL = 111;
/** A fallback buying window length; the real one arrives in execution_countdown_seconds. */
export const DEFAULT_BUY_WINDOW_SECONDS = 65 * 60;
/** A fallback draw length; the real one arrives in draw_seconds. */
// The fallback when the server does not say. Under ORAO the draw is the
// request landing, an answer a second later and the pause before buying; the
// old 115 came from Switchboard's mandatory reveal pause and its retries.
export const DEFAULT_DRAW_SECONDS = 12;

const OPENING_STATUSES = new Set(['id_generated']);
const OPEN_STATUSES = new Set(['created']);
const DRAW_STATUSES = new Set(['phase2started', 'phase2_started', 'phase_2_started', 'vrf_binded', 'vrfbinded']);
const BUYING_STATUSES = new Set(['vrf_fulfilled', 'vrffulfilled', 'proceeding_purchases']);
const FINISHED_STATUSES = new Set(['closed', 'completed']);

export function emptyPoolSnapshot(market: PoolMarket, phase: PoolPhase = 'loading'): PoolSnapshot {
  return {
    market,
    phase,
    draw: null,
    poolId: null,
    closesAtMs: null,
    buysStartedAtMs: null,
    buysEndAtMs: null,
    nextPoolAtMs: null,
    drawStartedAtMs: null,
    drawEndsAtMs: null,
    launchAtMs: null,
    totalSol: 0,
    capSol: DEFAULT_CAP_SOL,
    remainingSol: DEFAULT_CAP_SOL,
    buyBudgetSol: 0,
    coins: [],
    accounts: null
  };
}

export function buildPoolSnapshot(body: LotteryListResponse | null | undefined, market: PoolMarket, nowMs: number): PoolSnapshot {
  const summary = pickSummary(body, market);
  if (!summary) {
    const launch = pickLaunch(body, market);
    const launchAtMs = parseTime(launch?.launch_at);
    if (launchAtMs !== null) {
      return { ...emptyPoolSnapshot(market, 'launch'), launchAtMs };
    }
    return emptyPoolSnapshot(market, 'waiting');
  }

  const status = normalizeStatus(summary.status);
  const poolId = toFiniteNumber(summary.id);
  const capSol = positiveOr(toFiniteNumber(summary.max_total), DEFAULT_CAP_SOL);
  const totalSol = Math.max(0, toFiniteNumber(summary.total_pool_sol) ?? 0);
  const closesAtMs = parseTime(summary.end_date);
  const buysStartedAtMs = parseTime(summary.proceeding_purchases_started_at);
  const buyWindowSeconds = positiveOr(toFiniteNumber(summary.execution_countdown_seconds), DEFAULT_BUY_WINDOW_SECONDS);
  const buysEndAtMs = buysStartedAtMs !== null ? buysStartedAtMs + buyWindowSeconds * 1000 : null;
  // The next pool: the server knows about the "done" pause and works the moment
  // out itself. Without it, the end of the buying window, as before.
  const nextPoolAtMs = parseTime(summary.next_pool_at) ?? buysEndAtMs;
  const drawStartedAtMs = parseTime(summary.second_phase_started_at) ?? closesAtMs;
  const drawSeconds = positiveOr(toFiniteNumber(summary.draw_seconds), DEFAULT_DRAW_SECONDS);
  const drawEndsAtMs = drawStartedAtMs !== null ? drawStartedAtMs + drawSeconds * 1000 : null;
  const capReached = totalSol > capSol - MIN_COMMIT_SOL;

  let phase: PoolPhase;
  let draw: DrawStatus | null = null;
  if (OPENING_STATUSES.has(status)) {
    phase = 'opening';
  } else if (OPEN_STATUSES.has(status)) {
    const timeUp = closesAtMs !== null && nowMs >= closesAtMs;
    phase = timeUp || capReached ? 'locked' : 'open';
    draw = phase === 'locked' ? 'pending' : null;
  } else if (DRAW_STATUSES.has(status)) {
    phase = 'locked';
    draw = 'running';
  } else if (BUYING_STATUSES.has(status)) {
    phase = 'buying';
    draw = 'ready';
  } else if (FINISHED_STATUSES.has(status)) {
    const windowOpen = buysEndAtMs !== null && nowMs < buysEndAtMs;
    phase = windowOpen ? 'buying' : 'done';
    draw = 'ready';
  } else {
    phase = 'waiting';
  }

  const drawn = draw === 'ready' ? drawnSolByMint(summary.winner_results) : null;
  const coins = buildCoins(body?.entries, market, poolId, totalSol, drawn);

  return {
    market,
    phase,
    draw,
    poolId,
    closesAtMs,
    buysStartedAtMs,
    buysEndAtMs,
    nextPoolAtMs,
    drawStartedAtMs,
    drawEndsAtMs,
    launchAtMs: null,
    totalSol,
    capSol,
    remainingSol: Math.max(0, roundSol(capSol - totalSol)),
    buyBudgetSol: roundSol(totalSol * (1 - POOL_FEE_BPS / 10_000)),
    coins,
    accounts: {
      lotteryPda: cleanString(summary.lottery_pda),
      vaultPda: cleanString(summary.vault_pda),
      adminPubkey: cleanString(summary.admin_pubkey)
    }
  };
}

/** Milliseconds until a moment, never below zero; null means there is no moment. */
export function msUntil(targetMs: number | null, nowMs: number): number | null {
  return targetMs === null ? null : Math.max(0, targetMs - nowMs);
}

/** 01:12:40 — hours, minutes, seconds. */
export function formatClock(ms: number | null): string {
  if (ms === null) {
    return '';
  }
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/** 1:35 — a short countdown in minutes, where hours would be zeros for nothing. */
export function formatShortClock(ms: number | null): string {
  if (ms === null) {
    return '';
  }
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 2d 04h 10m — for the countdown to launch, which can be longer than a day. */
export function formatLongCountdown(ms: number | null): string {
  if (ms === null) {
    return '';
  }
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
  }
  return formatClock(ms);
}

/**
 * SOL for people: lamports are not needed to 9 decimals, but 0.05 must not
 * become 0.1. Two decimals if the number is large, otherwise up to four.
 */
/**
 * An amount in SOL to show a person: two decimals, with no trailing zeros.
 * "0.4929" becomes "0.49".
 *
 * Amounts below one SOL used to be shown with four decimals, and next to their
 * rounded neighbours that looked like a mess: "0 of 0.4929 SOL bought". Nobody
 * needs the precision here: it is on chain, and the page needs the size.
 *
 * The one caveat is amounts below a cent. Rounding them to "0" would be a lie
 * that there is no money at all, so for those we write "<0.01".
 */
export function formatSol(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.005) {
    return value < 0 ? '>-0.01' : '<0.01';
  }
  return Number(value.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function pickSummary(body: LotteryListResponse | null | undefined, market: PoolMarket): ActiveLotterySummaryResponse | null {
  const active = Array.isArray(body?.active_lotteries) ? body!.active_lotteries! : [];
  const latest = Array.isArray(body?.latest_lotteries) ? body!.latest_lotteries! : [];
  // A running pool matters more than the latest one overall: the latest may be a
  // closed previous one while a new one is already being created.
  return active.find((item) => marketOf(item.lottery_type) === market)
    ?? latest.find((item) => marketOf(item.lottery_type) === market)
    ?? null;
}

function pickLaunch(body: LotteryListResponse | null | undefined, market: PoolMarket): HypeCountdownResponse | null {
  const launches = Array.isArray(body?.hype_countdowns) ? body!.hype_countdowns! : [];
  return launches.find((item) => marketOf(item.lottery_type) === market) ?? null;
}

function buildCoins(
  entries: LotteryEntryResponse[] | undefined,
  market: PoolMarket,
  poolId: number | null,
  totalSol: number,
  drawn: Map<string, number> | null
): PoolCoin[] {
  const list = Array.isArray(entries) ? entries : [];
  const coins = list
    .filter((entry) => marketOf(entry?.lottery_type) === market && (poolId === null || toFiniteNumber(entry?.lottery_id) === poolId))
    .map((entry): PoolCoin => {
      const mint = String(entry?.coin?.address ?? '').trim();
      const sol = Math.max(0, toFiniteNumber(entry?.total_solana_bet) ?? 0);
      const ticker = cleanTicker(entry?.coin?.symbol, mint);
      return {
        mint,
        name: cleanName(entry?.coin?.name, mint, ticker),
        ticker,
        logoUrl: cleanUrl(entry?.coin?.logo_url),
        sol,
        commits: Math.max(0, Math.floor(toFiniteNumber(entry?.bet_count) ?? 0)),
        poolShare: totalSol > 0 ? sol / totalSol : 0,
        drawnSol: drawn ? (drawn.get(mint) ?? 0) : null
      };
    })
    .filter((coin) => coin.mint.length > 0);
  // The backend's order is by amount; we repeat it explicitly in case it changes.
  return coins.sort((left, right) => right.sol - left.sol || left.mint.localeCompare(right.mint));
}

function drawnSolByMint(results: LotteryWinnerResultResponse[] | undefined): Map<string, number> | null {
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }
  const map = new Map<string, number>();
  for (const result of results) {
    const mint = String(result?.mint ?? '').trim();
    const lamports = toFiniteNumber(result?.target_lamports);
    const sol = lamports !== null ? lamports / 1_000_000_000 : toFiniteNumber(result?.target_sol);
    if (mint && sol !== null && sol > 0) {
      map.set(mint, sol);
    }
  }
  return map.size > 0 ? map : null;
}

function marketOf(rawType: unknown): PoolMarket | null {
  const value = String(rawType ?? '').trim().toLowerCase();
  return value === 'dex' || value === 'pumpfun' ? value : null;
}

function normalizeStatus(rawStatus: unknown): string {
  return String(rawStatus ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  // The backend sometimes returns a time with no zone — that is UTC.
  const text = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function toFiniteNumber(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(number) ? number : null;
}

function positiveOr(value: number | null, fallback: number): number {
  return value !== null && value > 0 ? value : fallback;
}

function roundSol(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanUrl(value: unknown): string | null {
  const text = cleanString(value);
  return text && /^https?:\/\//i.test(text) ? text : null;
}

function cleanTicker(rawTicker: unknown, mint: string): string {
  const ticker = String(rawTicker ?? '').trim().replace(/^\$/, '');
  if (ticker && ticker !== mint && ticker.length <= 16) {
    return ticker.toUpperCase();
  }
  return mint.slice(0, 4).toUpperCase();
}

function cleanName(rawName: unknown, mint: string, ticker: string): string {
  const name = String(rawName ?? '').trim();
  return name && name !== mint ? name : ticker;
}
