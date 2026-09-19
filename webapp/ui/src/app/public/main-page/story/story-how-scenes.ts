/**
 * Frame arithmetic for the live "How it works" scenes.
 *
 * Only arithmetic here: how much SOL is in the pool on this frame, where the
 * price line runs, what shares the coins get during the draw. No DOM and no
 * Angular, which is why the scenes are checked by a test rather than by eye
 * with a stopwatch.
 */

import {
  BUY_BUDGET_SOL,
  BUY_START_SOL,
  POOL_START_SOL,
  STORY_BUYS,
  STORY_COMMITS,
  STORY_SEED_COMMITS,
  StoryBuy,
  StoryCommit
} from './story-how-data';

/** How long to wait between commits in the feed, ms. */
export const COMMIT_EVERY_MS = 2000;
/** The pause on "pool locked" before the next one starts, ms. */
export const POOL_LOCK_PAUSE_MS = 2600;
/**
 * How many feed rows we keep on screen. Exactly three and always three: one
 * arrives at the top, one leaves at the bottom. A list that is sometimes empty
 * and sometimes grows to four reads as loading, not as a stream of events.
 */
export const FEED_ROWS = 3;
/**
 * This many rows go to rendering: three visible plus one leaving. The bottom
 * one sits past the edge of the list and visibly travels down when a new one
 * arrives at the top. Without it the bottom row would simply vanish and the
 * feed would jerk.
 */
export const FEED_ROWS_RENDERED = FEED_ROWS + 1;

export interface FeedFrame {
  /** The pool number: every turn of the feed is the next pool. */
  poolId: number;
  /** How much SOL is in the pool on this frame: interpolated between commits. */
  totalSol: number;
  /** The latest commits, newest first. */
  rows: StoryCommit[];
  /** The pool is already locked: the feed has ended and the pause before the next pool is running. */
  locked: boolean;
  /** How long until it closes, in seconds. */
  secondsLeft: number;
}

/**
 * The state of the feed at `elapsedMs` from the start of the cycle.
 *
 * One cycle is one whole feed plus the "locked" pause. After that the next pool
 * starts on the same script, so the transition comes out circular: the total
 * does not jump from 73 back to 13 but first finishes travelling, freezes
 * locked, and only then a new pool appears.
 */
export function feedFrame(elapsedMs: number, firstPoolId = 128): FeedFrame {
  const cycleMs = STORY_COMMITS.length * COMMIT_EVERY_MS + POOL_LOCK_PAUSE_MS;
  const cycles = Math.floor(elapsedMs / cycleMs);
  const inCycle = elapsedMs - cycles * cycleMs;
  const poolId = firstPoolId + cycles;

  const stepsDone = Math.min(STORY_COMMITS.length, Math.floor(inCycle / COMMIT_EVERY_MS));
  const locked = stepsDone >= STORY_COMMITS.length;

  // The total rises in steps: a 2 SOL commit arrived, so the pool has 2 SOL
  // more. Smoothness comes not from splitting the step but from a short travel
  // on screen: that way every event is visible instead of a faceless number creeping.
  let total = POOL_START_SOL;
  for (let index = 0; index < stepsDone; index++) {
    total += STORY_COMMITS[index].sol;
  }

  // Newest commits first, then the ones already in the pool. The last row in
  // the list is the one leaving, and it is not visible.
  const arrived = STORY_COMMITS.slice(Math.max(0, stepsDone - FEED_ROWS_RENDERED), stepsDone).reverse();
  const rows = [...arrived];
  for (let index = STORY_SEED_COMMITS.length - 1; index >= 0 && rows.length < FEED_ROWS_RENDERED; index--) {
    rows.push(STORY_SEED_COMMITS[index]);
  }

  // The timer runs from two hours and lands exactly when the pool is locked.
  const fullMs = STORY_COMMITS.length * COMMIT_EVERY_MS;
  const leftShare = locked ? 0 : 1 - inCycle / fullMs;
  return {
    poolId,
    totalSol: round2(total),
    rows,
    locked,
    secondsLeft: Math.max(0, Math.round(leftShare * 2 * 60 * 60))
  };
}

/** 01:12:40 from seconds. */
export function clockText(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours, minutes, seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

// ------------------------------------------------------------------ price

/**
 * The price scene is built like a coin's chart right after the commitment
 * became public: the line starts at the left edge and visibly stretches right
 * and up until it fills the frame. After that it travels left, like a live chart.
 *
 * Why not a "live chart" straight away: if the window is always the same width
 * and the scale fits it, the growth disappears. The line fills the frame the
 * same way at any price and there is nothing to watch. While the line is still
 * being drawn the scale stays put — and you can see the price rise inside the frame.
 */

/** How many points fit in the frame and how often a new one arrives. */
export const PRICE_POINTS = 34;
export const PRICE_TICK_MS = 420;
/** This many points already exist on entry: the chart does not start empty. */
export const PRICE_HEAD_START = 2;

/** The fractional index of the "now" point at this moment of the scene. */
export function priceHead(elapsedMs: number): number {
  return PRICE_HEAD_START + Math.max(0, elapsedMs) / PRICE_TICK_MS;
}

/** The index of the point at the left edge: zero while the line is still being drawn. */
export function priceOrigin(head: number): number {
  return Math.max(0, head - (PRICE_POINTS - 1));
}

/**
 * Price as a geometric walk: every step multiplies it by "one plus a percent"
 * rather than adding the same slice. That is how real prices behave, and that
 * is how growth reads as growth — the line goes up ever more steeply instead of
 * crawling along a ruler.
 *
 * The noise has three layers. A tick-to-tick jitter that decays in a couple of
 * steps. A wave with a memory of several steps, which produces runs and
 * pullbacks of a few percent; without it the chart looks drawn. And sharp jolts
 * in both directions, when somebody enters or leaves in one trade.
 *
 * The upward drift is chosen so the average step stays the same (0.7% a tick)
 * at twice the spread: the price swings harder and grows at the same rate. The
 * wave's memory is deliberately short — with a long one a pullback would take
 * the whole frame and instead of "rising with dips" you would get a crash: nine
 * frames out of every ten still have to go up.
 *
 * Returns the price itself, not a fraction of the height: where to put it in
 * the frame is the scale's job.
 */
export function priceSeries(seed: number, count: number): number[] {
  const random = mulberry32(seed);
  const values: number[] = [];
  let price = 1;
  let jitter = 0;
  let wave = 0;

  for (let index = 0; index < count; index++) {
    jitter = jitter * 0.72 + (random() - 0.5) * 0.03;
    wave = wave * 0.85 + (random() - 0.5) * 0.008;
    // A jolt: somebody enters or leaves in one trade. Almost every fifth tick,
    // otherwise long shelves appear between waves with nothing to watch.
    const roll = random();
    const shock = roll < 0.1
      ? -(0.025 + random() * 0.045)
      : (roll < 0.18 ? 0.02 + random() * 0.04 : 0);
    price *= 1 + 0.00858 + jitter + wave + shock;
    values.push(price);
  }
  return values;
}

/**
 * The window the scale is computed over: always a whole frame, even while the
 * line is still being drawn. That keeps the scale still through the whole
 * run-up, and when the line reaches the right edge it coincides with the scale
 * of the visible window — the switch to moving left goes unnoticed.
 */
export function priceScaleWindow(values: number[], head: number): number[] {
  const first = Math.floor(priceOrigin(head));
  // One point more than fits the frame: the end of the line sits between points
  // and manages to go past the last one. Without that headroom a sharp jolt
  // would land outside the scale and the line would lie along the frame edge.
  return values.slice(first, first + PRICE_POINTS + 1);
}

/**
 * The scale bounds: there is air above and below, so the line does not stick to the frame.
 *
 * There is three times as much air above as below. That is headroom for the
 * time the scale spends catching up with a price that ran up: without it the
 * line hits the ceiling of the frame and lies along it as a shelf, and the
 * growth stops reading at once.
 */
export function priceAxis(window: number[]): { min: number; max: number } {
  const min = Math.min(...window);
  const max = Math.max(...window);
  const span = Math.max(max - min, max * 0.02);
  return { min: min - span * 0.22, max: max + span * 0.3 };
}

/** The fraction of the height for a price at a given scale, with margins at the edges. */
export function priceToUnit(value: number, min: number, max: number): number {
  const span = Math.max(1e-9, max - min);
  return Math.max(0.02, Math.min(0.98, (value - min) / span));
}

/** The price at the "now" point: between two ticks it is linear. */
export function priceAt(values: number[], head: number): number {
  const index = Math.max(0, Math.min(values.length - 1, Math.floor(head)));
  const next = Math.min(values.length - 1, index + 1);
  return values[index] + (values[next] - values[index]) * (head - index);
}

/** The line, the fill under it and the "now" point at its end — one frame. */
export interface PriceFrame {
  line: string;
  area: string;
  dotX: number;
  dotY: number;
}

/**
 * A chart frame: the path from the left edge to the "now" point.
 *
 * The end of the line sits exactly where the price arrived in this
 * millisecond, not at the nearest point of the series. Otherwise the line would
 * jump a whole step on every tick.
 */
export function priceFrame(
  values: number[],
  head: number,
  min: number,
  max: number,
  width: number,
  height: number
): PriceFrame {
  const stepX = width / (PRICE_POINTS - 1);
  const origin = priceOrigin(head);
  // One point beyond the left edge: the line has to come out from behind the
  // frame rather than start on it.
  const first = Math.max(0, Math.ceil(origin) - 1);
  const last = Math.min(values.length - 1, Math.floor(head));

  const xs: number[] = [];
  const ys: number[] = [];
  const toY = (value: number) => height - priceToUnit(value, min, max) * height;
  for (let index = first; index <= last; index++) {
    xs.push((index - origin) * stepX);
    ys.push(toY(values[index]));
  }
  // The tip between points: that is "now".
  const tipX = (head - origin) * stepX;
  if (tipX - xs[xs.length - 1] > 0.25) {
    xs.push(tipX);
    ys.push(toY(priceAt(values, head)));
  }
  if (xs.length < 2) {
    return { line: '', area: '', dotX: tipX, dotY: toY(priceAt(values, head)) };
  }

  const line = hermitePath(xs, ys, monotoneTangents(xs, ys));
  const floor = (height + 4).toFixed(2);
  const area = `${line} L${xs[xs.length - 1].toFixed(2)} ${floor} L${xs[0].toFixed(2)} ${floor} Z`;
  return { line, area, dotX: xs[xs.length - 1], dotY: ys[ys.length - 1] };
}

/**
 * Derivatives at the points, limited by Fritsch–Carlson, like `curveMonotoneX`
 * in d3.
 *
 * Catmull-Rom "overshoots" local peaks and the price line looks wavy, as if
 * between two neighbouring values the price had gone above both. A monotone
 * curve does not do that: it is smooth but never leaves the range of the
 * neighbouring points, so it reads as a price chart.
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const count = xs.length;
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    slopes.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }
  const tangents: number[] = new Array(count);
  tangents[0] = slopes[0];
  tangents[count - 1] = slopes[count - 2];
  for (let i = 1; i < count - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      // The point is a peak or a trough: the tangent is zero and there will be no overshoot.
      tangents[i] = 0;
    } else {
      tangents[i] = (slopes[i - 1] + slopes[i]) / 2;
      const limit = 3 * Math.min(Math.abs(slopes[i - 1]), Math.abs(slopes[i]));
      if (Math.abs(tangents[i]) > limit) {
        tangents[i] = Math.sign(tangents[i]) * limit;
      }
    }
  }
  return tangents;
}

function hermitePath(xs: number[], ys: number[], tangents: number[]): string {
  let path = `M${xs[0].toFixed(2)} ${ys[0].toFixed(2)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    path += ` C${(xs[i] + dx).toFixed(2)} ${(ys[i] + tangents[i] * dx).toFixed(2)},`
      + ` ${(xs[i + 1] - dx).toFixed(2)} ${(ys[i + 1] - tangents[i + 1] * dx).toFixed(2)},`
      + ` ${xs[i + 1].toFixed(2)} ${ys[i + 1].toFixed(2)}`;
  }
  return path;
}

/** A seeded random number generator: mulberry32. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the draw

/** Coin shares before and after the draw: the scene's numbers, with no animation. */
export const DRAW_BEFORE = [50, 30, 20];
export const DRAW_AFTER = [47, 28, 22];

// ------------------------------------------------------------------ buying

export interface BuyFrame {
  /** How much SOL has been bought. */
  boughtSol: number;
  /** How many candles are shown. */
  candles: number;
  /** How many purchase rows are shown. */
  rows: number;
  done: boolean;
}

/** How much goes into buying in total: the same 97 SOL after the fee as in the draw scene. */
export const BUY_TARGET_SOL = BUY_BUDGET_SOL;
/** How often a new purchase arrives, ms. */
export const BUY_ROW_EVERY_MS = 2000;
/** How many purchase rows on screen: the same as commits in the pool feed. */
export const BUY_ROWS = 3;
/** Three visible purchase rows plus one leaving — as in the commit feed. */
export const BUY_ROWS_RENDERED = BUY_ROWS + 1;
/** The pause on "everything bought" before the next hour starts, ms. */
export const BUY_DONE_PAUSE_MS = 2800;

/** How many purchases it takes to get from the starting amount to the budget. */
const BUY_STEPS = Math.ceil((BUY_BUDGET_SOL - BUY_START_SOL) / (STORY_BUYS.reduce((sum, buy) => sum + buy.sol, 0) / STORY_BUYS.length));

/** How much is bought after `done` purchases: the series loops, and the ceiling is the whole budget. */
function boughtAfter(done: number): number {
  let bought = BUY_START_SOL;
  for (let index = 0; index < done; index++) {
    bought += STORY_BUYS[index % STORY_BUYS.length].sol;
  }
  return Math.min(BUY_BUDGET_SOL, bought);
}

/**
 * Candles: the first new one arrives with the second purchase, the last at 83.6 SOL.
 *
 * The series used to stretch across the whole buying, and the third candle only
 * appeared by the fifth purchase: for the first seconds of the scene the chart
 * stood dead. And the last candle arrived exactly at the end, too late to watch.
 */
export const CANDLE_START_STEP = 2;
export const CANDLE_DONE_SOL = 83.6;
const CANDLE_DONE_STEP = (() => {
  for (let done = CANDLE_START_STEP; done <= BUY_STEPS; done++) {
    // Rounded: the total accumulates by addition, and 83.6 in binary is slightly less.
    if (round2(boughtAfter(done)) >= CANDLE_DONE_SOL) {
      return done;
    }
  }
  return BUY_STEPS;
})();

export function buyFrame(elapsedMs: number, candleCount: number): BuyFrame {
  const cycleMs = BUY_STEPS * BUY_ROW_EVERY_MS + BUY_DONE_PAUSE_MS;
  const inCycle = elapsedMs % cycleMs;
  const done = Math.min(BUY_STEPS, Math.floor(inCycle / BUY_ROW_EVERY_MS));

  // In steps: a 0.6 SOL purchase arrived, so the bought amount is 0.6 higher.
  const bought = boughtAfter(done);

  return {
    boughtSol: round2(bought),
    // The hour has only just started: two candles already exist and the rest
    // accumulate as the buying goes. With one candle a chart would not read as a chart.
    candles: candlesAfter(done, candleCount),
    rows: BUY_ROWS,
    done: done >= BUY_STEPS
  };
}

/**
 * The latest purchases at `elapsedMs`: as in the commit feed, one arrives at
 * the top and the bottom one leaves. The list loops, so the scene can stay on
 * screen for as long as it likes.
 *
 * At the top sits the purchase that has just entered the bought total, not the
 * one after it. Otherwise the row and the counter disagree: the feed shows "0.6
 * SOL" while the total at that moment grows by the size of the previous purchase.
 */
/** How many candles are shown after `done` purchases. */
function candlesAfter(done: number, candleCount: number): number {
  if (done < CANDLE_START_STEP) {
    return 2;
  }
  const grown = candleCount - 3;
  const span = Math.max(1, CANDLE_DONE_STEP - CANDLE_START_STEP);
  return Math.min(candleCount, 3 + Math.floor(((done - CANDLE_START_STEP) * grown) / span));
}

export function buyRows(elapsedMs: number): StoryBuy[] {
  const cycleMs = BUY_STEPS * BUY_ROW_EVERY_MS + BUY_DONE_PAUSE_MS;
  const inCycle = elapsedMs % cycleMs;
  const done = Math.min(BUY_STEPS, Math.floor(inCycle / BUY_ROW_EVERY_MS));
  const rows: StoryBuy[] = [];
  for (let index = 0; index < BUY_ROWS_RENDERED; index++) {
    const position = ((done - 1 - index) % STORY_BUYS.length + STORY_BUYS.length) % STORY_BUYS.length;
    rows.push(STORY_BUYS[position]);
  }
  return rows;
}

/** "now", "2 min ago" — a purchase's time from its place in the feed. */
export function buyRowAge(index: number): string {
  if (index === 0) {
    return 'now';
  }
  return `${index * 2} min ago`;
}

// ------------------------------------------------------------------ delivery

export interface PayoutFrame {
  /** Each row's share, 0..1: the bar grows by it and the tokens are computed from it. */
  fill: number[];
  /** Rows that have already been sent. */
  sent: boolean[];
}

const PAYOUT_STEP_MS = 900;

/**
 * Delivery plays once per arrival on the scene and stays in its final state. A
 * looping growth of the bars would look as if tokens were being handed out over
 * and over, and it is a one-off event.
 */
export function payoutFrame(elapsedMs: number, rows: number): PayoutFrame {
  const fill: number[] = [];
  const sent: boolean[] = [];
  for (let index = 0; index < rows; index++) {
    const started = elapsedMs - index * PAYOUT_STEP_MS;
    const progress = clamp01(started / PAYOUT_STEP_MS);
    fill.push(easeOut(progress));
    sent.push(progress >= 1);
  }
  return { fill, sent };
}

/** How long the whole delivery lasts, ms: after that the scene freezes. */
export function payoutDurationMs(rows: number): number {
  return rows * PAYOUT_STEP_MS + 150;
}

// ------------------------------------------------------------------ odds and ends

function easeOut(value: number): number {
  return 1 - Math.pow(1 - clamp01(value), 3);
}

function easeInOut(value: number): number {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
