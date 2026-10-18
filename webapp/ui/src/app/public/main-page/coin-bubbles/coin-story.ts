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
  /** The coin's supply in whole tokens; the chart draws market cap (price times it) when it is known. */
  supply: number | null;
  /** Tokens of the coin the pool burned, whole units; 0 for none, null when not known. */
  burned: number | null;
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

/**
 * A market cap in SOL, three figures at most: "96.4", "162", "1.23K", "4.5M".
 * Georgiy, 2026-10-18: market cap rather than price, the number people trade
 * memecoins by; 162 SOL reads at a glance where 0.0₆162 does not.
 */
export function formatCap(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value < 1) {
    return formatTinyPrice(value);
  }
  // Rounded first, so 999.7 is 1K rather than "1.00e+3".
  const rounded = Number(value.toPrecision(3));
  for (const [size, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (rounded >= size) {
      return `${trimZeros((rounded / size).toPrecision(3))}${suffix}`;
    }
  }
  return trimZeros(rounded.toPrecision(3));
}

/**
 * What the chart draws: the market cap in SOL, each candle's price times the
 * coin's supply, when the supply is known; the price otherwise (and the
 * caption says which).
 */
export function chartCandles(story: Pick<CoinStory, 'candles' | 'supply'>): { candles: StoryCandle[]; marketCap: boolean } {
  const supply = story.supply;
  if (supply === null || !(supply > 0)) {
    return { candles: story.candles, marketCap: false };
  }
  return {
    candles: story.candles.map((candle) => ({ ...candle, o: candle.o * supply, h: candle.h * supply, l: candle.l * supply, c: candle.c * supply })),
    marketCap: true
  };
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
 * What the pool bought of the coin, in words. A share it did not buy is said
 * as such: on the stand, the buyer, on devnet, could not buy mainnet coins,
 * LETTER's 15 SOL share went back to its backers, and the window said the
 * draw had given it nothing.
 */
export function boughtText(
  story: Pick<CoinStory, 'buys' | 'buysKnown' | 'finished' | 'shareSol' | 'refundedSol' | 'burned' | 'supply'>,
  sol: (value: number) => string
): string {
  const count = story.buys.length;
  const buys = `${count} public ${count === 1 ? 'buy' : 'buys'}`;
  const spent = story.buys.reduce((sum, buy) => sum + buy.sol, 0);
  if (!story.finished) {
    // While the pool buys, what it has bought so far; it said "The buys start
    // when the pool closes" through the whole buying until 2026-10-18.
    if (count > 0) {
      return `${buys} so far · ${sol(spent)} SOL${burnText(story)}`;
    }
    return story.shareSol === null ? 'The buys start when the pool closes' : 'The buys are starting';
  }
  if (!story.buysKnown) {
    return 'Not known right now';
  }
  // What went back after buys is a few lamports of rounding and fees, and it
  // read as if the pool had held some back ("· 0.01 SOL went back", until
  // 2026-10-18). A burn is the news instead, when there was one.
  if (count > 0) {
    return `${buys} · ${sol(spent)} SOL${burnText(story)}`;
  }
  if (story.shareSol !== null && story.shareSol > 0) {
    // The share is the line above it; here, only what became of it.
    return story.refundedSol > 0 ? 'None. Its share went back to its backers' : 'None. Its share was not bought';
  }
  return 'None';
}

/**
 * What the coin won in the draw: its share of the pool, in SOL, which is
 * what the pool then buys. It replaced the SOL behind the coin on 2026-10-18
 * (Georgiy): SI had 1 SOL behind it and won one draw of thirty, 0.68 SOL, and
 * "1 SOL" beside "0.68 SOL bought" read as if the pool had bought short.
 */
export function wonText(story: Pick<CoinStory, 'finished' | 'shareSol'>, sol: (value: number) => string): string {
  if (story.shareSol === null) {
    return story.finished ? 'Not known right now' : 'Drawn when the pool closes';
  }
  return story.shareSol > 0 ? `${sol(story.shareSol)} SOL` : 'Nothing';
}

/**
 * " · 79.9M tokens burned (8% of supply)": what the pool burned of the coin,
 * against its supply before the burn; nothing at all when it burned none.
 */
export function burnText(story: Pick<CoinStory, 'burned' | 'supply'>): string {
  const burned = story.burned;
  if (burned === null || !(burned > 0)) {
    return '';
  }
  const share = story.supply !== null && story.supply > 0 ? (burned / story.supply) * 100 : null;
  const percent = share === null ? '' : ` (${share < 0.1 ? 'under 0.1' : share < 1 ? share.toFixed(1) : String(Math.round(share))}% of supply)`;
  return ` · ${formatCap(burned)} tokens burned${percent}`;
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
    chartUpdatedAtMs: time(item['chart_updated_at']) || null,
    supply: Number.isFinite(Number(item['supply'])) && Number(item['supply']) > 0 && item['supply'] !== null ? Number(item['supply']) : null,
    burned: item['burned'] !== null && Number.isFinite(Number(item['burned'])) && Number(item['burned']) >= 0 ? Number(item['burned']) : null
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
