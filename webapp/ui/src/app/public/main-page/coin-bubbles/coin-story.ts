/**
 * What the coin window from a bubble shows, worked out without a browser:
 * the scene tests check it.
 *
 * The window is the coin's stay in pumpling (`/lottery/coins/<mint>/story`):
 * the pool where the most SOL stood behind it, from its first commit there to
 * that pool's last buy of it, with GeckoTerminal's candles in SOL and the
 * pool's own buys marked on them. The server keeps the candles and refreshes
 * them on a schedule while the pool runs; a quarter of an hour after the
 * pool's last buy of the coin they are final.
 */

export interface StoryCandle {
  /** Unix seconds, the candle's start. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface StoryBuy {
  atMs: number;
  sol: number;
  signature: string;
}

export interface CoinStory {
  mint: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  tradeUrl: string;
  venue: string;
  poolId: number;
  committedSol: number;
  enteredAtMs: number;
  /** When its stay ended: the pool's last buy of it, or the pool's close; null while the pool runs. */
  leftAtMs: number | null;
  finished: boolean;
  windowStartMs: number;
  windowEndMs: number;
  buys: StoryBuy[];
  /** False when the buyer did not answer: then no buys is not known, not none. */
  buysKnown: boolean;
  /** The SOL the draw gave the coin; null when not known. */
  shareSol: number | null;
  /** The SOL of its share that went back to its backers. */
  refundedSol: number;
  candles: StoryCandle[];
  candleMinutes: number;
  chartUrl: string | null;
  /** pending: the server has not fetched this coin's chart yet (a coin just in). */
  chartState: 'ready' | 'none' | 'pending' | 'busy' | 'failed';
  /** Fetched for the last time: it will not change. */
  chartFinal: boolean;
  /** When the server fetched it; a running pool's is a few minutes old at most. */
  chartUpdatedAtMs: number | null;
}

/** Where to mark on the chart: a buy, or the coin coming into the pool. */
export interface StoryMark {
  /** The candle's time it sits on (a marker must sit on a candle). */
  t: number;
  kind: 'in' | 'buy';
  /** Buys in that candle. */
  count: number;
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

/**
 * A tiny price the way trading sites write it: 0.0₆155 for 0.000000155, the
 * zeros after the point counted in a subscript. A pump.fun coin trades at a
 * millionth of a SOL and less, and 0.000000155 cannot be read at a glance.
 */
export function formatTinyPrice(value: number): string {
  // Under a quadrillionth it is the axis's zero, give or take floating point
  // (it was drawn as 0.0₂₃662).
  if (!Number.isFinite(value) || value < 1e-15) {
    return '0';
  }
  if (value >= 1) {
    return trimZeros(value.toPrecision(4));
  }
  let exponent = Math.floor(Math.log10(value));
  let digits = Math.round(value / 10 ** (exponent - 2));
  if (digits >= 1000) {
    // 0.000000999 rounds up to the next decade.
    digits = Math.round(digits / 10);
    exponent += 1;
  }
  const zeros = -exponent - 1;
  if (zeros < 4) {
    return trimZeros(value.toFixed(zeros + 3));
  }
  const tail = String(digits).replace(/0+$/, '') || '0';
  return `0.0${String(zeros).split('').map((d) => SUBSCRIPT[Number(d)]).join('')}${tail}`;
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * The marks for the chart: one arrow under each candle the pool bought in, and
 * a dot over the candle the coin came in on. A buy outside the candles (the
 * provider lagging behind) has nowhere to sit and is left off the chart; it is
 * still in the list of buys.
 */
export function storyMarks(story: Pick<CoinStory, 'buys' | 'candles' | 'candleMinutes' | 'enteredAtMs'>): StoryMark[] {
  const step = Math.max(1, story.candleMinutes) * 60;
  const times = new Set(story.candles.map((candle) => candle.t));
  const marks = new Map<number, StoryMark>();
  const bucket = (ms: number) => Math.floor(ms / 1000 / step) * step;

  const entered = bucket(story.enteredAtMs);
  const firstCandle = story.candles[0]?.t;
  // A coin made in the minute it came in: its first candle is that minute or the next.
  const inAt = times.has(entered) ? entered : firstCandle !== undefined && firstCandle >= entered && firstCandle - entered <= step ? firstCandle : null;
  if (inAt !== null) {
    marks.set(inAt, { t: inAt, kind: 'in', count: 0 });
  }
  for (const buy of story.buys) {
    const at = bucket(buy.atMs);
    if (!times.has(at)) {
      continue;
    }
    const mark = marks.get(at);
    if (mark && mark.kind === 'buy') {
      mark.count += 1;
    } else if (!mark) {
      marks.set(at, { t: at, kind: 'buy', count: 1 });
    } else {
      // The coin came in and was bought in the same minute: the buy is the news.
      marks.set(at, { t: at, kind: 'buy', count: 1 });
    }
  }
  return [...marks.values()].sort((a, b) => a.t - b.t);
}

/**
 * What the pool bought of the coin, in words. "The draw gave it no share" is
 * said only when the buyer says its share was zero: on the stand, the buyer,
 * on devnet, could not buy mainnet coins, LETTER's 15 SOL share went back to
 * its backers, and the window said the draw had given it nothing.
 */
export function boughtText(
  story: Pick<CoinStory, 'buys' | 'buysKnown' | 'finished' | 'shareSol' | 'refundedSol'>,
  sol: (value: number) => string
): string {
  if (!story.finished) {
    return 'The buys start when the pool closes';
  }
  if (!story.buysKnown) {
    return 'Not known right now';
  }
  const refunded = story.refundedSol > 0 ? ` · ${sol(story.refundedSol)} SOL went back` : '';
  if (story.buys.length > 0) {
    const spent = story.buys.reduce((sum, buy) => sum + buy.sol, 0);
    return `${story.buys.length} public ${story.buys.length === 1 ? 'buy' : 'buys'} · ${sol(spent)} SOL${refunded}`;
  }
  if (story.shareSol === null) {
    return 'None';
  }
  if (story.shareSol > 0) {
    return story.refundedSol > 0
      ? `None. Its ${sol(story.shareSol)} SOL share went back to its backers`
      : `None. Its ${sol(story.shareSol)} SOL share was not bought`;
  }
  return 'Nothing: the draw gave it no share';
}

/** "updated just now", "updated 4 min ago": how old a running pool's chart is. */
export function updatedText(updatedAtMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - updatedAtMs) / 60_000);
  return minutes < 1 ? 'updated just now' : `updated ${minutes} min ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 4, 19:01 → 20:35 UTC"; the date again when it ends on another day; "→ now" while it runs. */
export function windowText(fromMs: number, toMs: number, running: boolean): string {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const day = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const clock = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (running) {
    return `${day(from)}, ${clock(from)} → now`;
  }
  const sameDay = day(from) === day(to) && from.getUTCFullYear() === to.getUTCFullYear();
  return `${day(from)}, ${clock(from)} → ${sameDay ? '' : day(to) + ', '}${clock(to)} UTC`;
}

/** The answer of `/lottery/coins/<mint>/story`, made safe: only https links, numbers that are numbers. */
export function toStory(raw: unknown): CoinStory | null {
  const item = (raw ?? {}) as Record<string, unknown>;
  const mint = String(item['mint'] ?? '').trim();
  const tradeUrl = https(item['trade_url']);
  const poolId = Number(item['lottery_id']);
  if (!mint || !tradeUrl || !Number.isFinite(poolId)) {
    return null;
  }
  const time = (value: unknown) => Date.parse(String(value ?? '')) || 0;
  const candles = (Array.isArray(item['candles']) ? item['candles'] : [])
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 6)
    .map((row) => row.map(Number))
    .filter((row) => row.every(Number.isFinite) && row[2] > 0)
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const states = ['ready', 'none', 'pending', 'busy', 'failed'];
  const state = String(item['chart_state'] ?? 'none');
  return {
    mint,
    name: String(item['name'] ?? '').trim() || mint.slice(0, 6),
    symbol: String(item['symbol'] ?? '').trim().replace(/^\$+/, '') || mint.slice(0, 4).toUpperCase(),
    logoUrl: https(item['logo_url']),
    tradeUrl,
    venue: String(item['venue'] ?? '').trim() || 'DexScreener',
    poolId,
    committedSol: Number(item['committed_sol']) || 0,
    enteredAtMs: time(item['entered_at']),
    leftAtMs: time(item['left_at']) || null,
    finished: item['finished'] === true,
    windowStartMs: time(item['window_start']),
    windowEndMs: time(item['window_end']),
    buys: (Array.isArray(item['buys']) ? item['buys'] : [])
      .map((buy) => buy as Record<string, unknown>)
      .map((buy) => ({ atMs: time(buy['at']), sol: Number(buy['sol']) || 0, signature: String(buy['signature'] ?? '') }))
      .filter((buy) => buy.atMs > 0 && buy.sol > 0 && /^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(buy.signature)),
    buysKnown: item['buys_known'] !== false,
    shareSol: Number.isFinite(Number(item['share_sol'])) && item['share_sol'] !== null ? Math.max(0, Number(item['share_sol'])) : null,
    refundedSol: Math.max(0, Number(item['refunded_sol']) || 0),
    candles,
    candleMinutes: Number(item['candle_minutes']) || 1,
    chartUrl: https(item['chart_url']),
    chartState: (states.includes(state) ? state : 'none') as CoinStory['chartState'],
    chartFinal: item['chart_final'] === true,
    chartUpdatedAtMs: time(item['chart_updated_at']) || null
  };
}

function https(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
