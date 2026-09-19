// Frames of the live How it works scenes: computed without a browser.
import assert from 'node:assert/strict';
import { feedFrame, clockText, priceFrame, priceAxis, priceToUnit, priceAt, priceHead, priceOrigin, priceScaleWindow, priceSeries, PRICE_POINTS, PRICE_TICK_MS, PRICE_HEAD_START, buyFrame, buyRows, buyRowAge, payoutFrame, payoutDurationMs, CANDLE_DONE_SOL, CANDLE_START_STEP, COMMIT_EVERY_MS, POOL_LOCK_PAUSE_MS, FEED_ROWS, FEED_ROWS_RENDERED, BUY_ROWS, BUY_ROWS_RENDERED, BUY_ROW_EVERY_MS, BUY_TARGET_SOL } from './scenes.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const COMMITS = 40;

t('the feed starts at 13 SOL with three rows', () => {
  const frame = feedFrame(0);
  assert.equal(frame.poolId, 128);
  assert.equal(frame.rows.length, FEED_ROWS);
  assert.ok(frame.totalSol >= 13 && frame.totalSol < 13.5, `${frame.totalSol}`);
  assert.equal(frame.locked, false);
});

t('the feed always has exactly three visible rows and a new one arrives on top', () => {
  // We hand out one row more than is visible: the bottom one travels past the
  // edge of the list while a new one unrolls on top. Three stay visible.
  assert.equal(FEED_ROWS, 3);
  assert.equal(FEED_ROWS_RENDERED, 4);
  for (let ms = COMMIT_EVERY_MS; ms <= COMMIT_EVERY_MS * 12; ms += 250) {
    assert.equal(feedFrame(ms).rows.length, FEED_ROWS_RENDERED, `at ${ms} ms`);
  }
  const before = feedFrame(COMMIT_EVERY_MS * 4 + 10).rows;
  const after = feedFrame(COMMIT_EVERY_MS * 5 + 10).rows;
  assert.notEqual(after[0].wallet, before[0].wallet, 'a new row on top');
  assert.equal(after[1].wallet, before[0].wallet, 'the previous top row moved down');
});

t('commits arrive every two seconds', () => {
  assert.equal(COMMIT_EVERY_MS, 2000);
});

t('the total grows and lands exactly on 73', () => {
  const mid = feedFrame(COMMITS * COMMIT_EVERY_MS / 2);
  assert.ok(mid.totalSol > 30 && mid.totalSol < 60, `${mid.totalSol}`);
  const end = feedFrame(COMMITS * COMMIT_EVERY_MS + 100);
  assert.equal(end.totalSol, 73);
  assert.equal(end.locked, true);
});

t('the total grows in steps, exactly by the size of a commit', () => {
  let previous = feedFrame(0).totalSol;
  const steps = [];
  for (let ms = 0; ms < COMMITS * COMMIT_EVERY_MS; ms += 100) {
    const frame = feedFrame(ms);
    assert.ok(frame.totalSol >= previous - 1e-9, `a drop at ${ms}: ${previous} -> ${frame.totalSol}`);
    if (frame.totalSol > previous + 1e-9) {
      steps.push(Number((frame.totalSol - previous).toFixed(2)));
    }
    previous = frame.totalSol;
  }
  assert.equal(steps.length, COMMITS - 1, 'one step per commit');
  // Every step is somebody's commit, not a fraction of one.
  const amounts = new Set(steps);
  for (const step of amounts) {
    assert.ok(step >= 0.2 && step <= 5, `a suspicious step ${step}`);
  }
  // Between commits the total stands still.
  assert.equal(feedFrame(COMMIT_EVERY_MS * 3 + 200).totalSol, feedFrame(COMMIT_EVERY_MS * 3 + 1500).totalSol);
});

t('after the pause the next pool opens at 13 SOL', () => {
  const cycle = COMMITS * COMMIT_EVERY_MS + POOL_LOCK_PAUSE_MS;
  const next = feedFrame(cycle + 10);
  assert.equal(next.poolId, 129);
  assert.ok(next.totalSol >= 13 && next.totalSol < 13.5, `${next.totalSol}`);
  assert.equal(next.locked, false);
  // between 73 and the new pool there is a "locked" pause, not an instant jump
  const locked = feedFrame(cycle - 200);
  assert.equal(locked.locked, true);
  assert.equal(locked.totalSol, 73);
});



t('the timer runs from two hours down to zero', () => {
  assert.equal(clockText(feedFrame(0).secondsLeft), '02:00:00');
  assert.ok(feedFrame(COMMITS * COMMIT_EVERY_MS / 2).secondsLeft < 3700);
  assert.equal(clockText(feedFrame(COMMITS * COMMIT_EVERY_MS + 5).secondsLeft), '00:00:00');
});

t('the price grows multiplicatively, with pullbacks and no periodicity', () => {
  const values = priceSeries(20260918, 600);
  assert.equal(values.length, 600);
  assert.ok(values.every((v) => v > 0), 'the price is always positive');
  assert.ok(values[599] / values[0] > 2, `the growth is too weak: ${(values[599] / values[0]).toFixed(2)}`);

  // The steps are relative and there are no teleports: a sharp jolt happens,
  // but even that does not move the price by more than a tenth.
  const steps = values.slice(1).map((v, i) => v / values[i] - 1);
  assert.ok(Math.max(...steps.map(Math.abs)) < 0.12, `the step is too large: ${Math.max(...steps.map(Math.abs)).toFixed(3)}`);

  // Sharp moves exist, and in both directions: without them the curve looks drawn.
  // There are slightly fewer falls than rises: the upward drift eats part of the sell-off.
  assert.ok(steps.filter((step) => step > 0.025).length > 60, `too few sharp rises: ${steps.filter((step) => step > 0.025).length}`);
  assert.ok(steps.filter((step) => step < -0.025).length > 35, `too few sharp falls: ${steps.filter((step) => step < -0.025).length}`);

  // Few shelves: a stretch of six ticks where the price barely moved has to be
  // an exception, or there is nothing to watch.
  let flat = 0;
  for (let i = 0; i + 6 < values.length; i++) {
    if (Math.abs(values[i + 6] / values[i] - 1) < 0.015) flat++;
  }
  assert.ok(flat / values.length < 0.2, `it stands still too often: ${(flat / values.length * 100).toFixed(0)}%`);

  // Pullbacks exist, and not only microscopic ones: we count drawdowns from a
  // local maximum. Without visible pullbacks the chart reads as drawn.
  assert.ok(steps.filter((step) => step < 0).length > 120, 'too few pullbacks');
  const dips = [];
  let peak = values[0];
  let dip = 0;
  for (const value of values) {
    if (value > peak) {
      if (dip > 0.03) dips.push(dip);
      peak = value;
      dip = 0;
    }
    dip = Math.max(dip, (peak - value) / peak);
  }
  assert.ok(dips.length >= 4, `too few visible drawdowns: ${dips.length}`);
  assert.ok(Math.max(...dips) > 0.06, `the largest drawdown is only ${(Math.max(...dips) * 100).toFixed(1)}%`);

  // The average step is unchanged: the swings grew, the rate of growth did not.
  const meanStep = steps.reduce((a, b) => a + b, 0) / steps.length;
  assert.ok(meanStep > 0.004 && meanStep < 0.011, `the average step drifted: ${(meanStep * 100).toFixed(2)}%`);

  // No periodicity: a wave's autocorrelation of increments at its own period is
  // close to one, a walk's is not.
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const centred = steps.map((v) => v - mean);
  const variance = centred.reduce((a, b) => a + b * b, 0);
  for (const lag of [8, 12, 16, 20, 24, 32]) {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += centred[i] * centred[i + lag];
    assert.ok(sum / variance < 0.5, `this looks like periodicity at lag ${lag}`);
  }
});

t('different seeds give different charts', () => {
  const a = priceSeries(1, 60);
  const b = priceSeries(2, 60);
  assert.notDeepEqual(a, b);
  assert.deepEqual(priceSeries(1, 60), a, 'the same seed repeats');
});

t('the scale leaves air and does not invert the order', () => {
  const { min, max } = priceAxis([1, 1.2, 1.1, 1.4]);
  assert.ok(min < 1 && max > 1.4, 'the line does not stick to the frame');
  const units = [1, 1.2, 1.1, 1.4].map((v) => priceToUnit(v, min, max));
  assert.ok(units.every((u) => u > 0 && u < 1), 'everything is inside the frame');
  assert.ok(units[3] > units[0], 'a higher price means a higher point');

  // A flat price does not collapse the scale to zero.
  const flat = priceAxis([2, 2, 2]);
  assert.ok(flat.max > flat.min && Number.isFinite(priceToUnit(2, flat.min, flat.max)));
});

t('while the line is still being drawn the scale stands still', () => {
  const series = priceSeries(20260918, 200);
  const early = priceAxis(priceScaleWindow(series, priceHead(0)));
  const mid = priceAxis(priceScaleWindow(series, priceHead(PRICE_TICK_MS * 10)));
  assert.deepEqual(mid, early, 'the scale moved too early');

  // As soon as the line hits the right edge the window starts moving.
  // After the run-up the window travels with the price, so the scale has to
  // change. Up or down depends on where the price goes: it now has visible
  // pullbacks too.
  const later = priceAxis(priceScaleWindow(series, priceHead(PRICE_TICK_MS * (PRICE_POINTS + 10))));
  assert.ok(later.max !== early.max || later.min !== early.min, 'the window did not move after the run-up');
  const muchLater = priceAxis(priceScaleWindow(series, priceHead(PRICE_TICK_MS * (PRICE_POINTS + 120))));
  assert.ok(muchLater.max > early.max, 'in two minutes the price never went higher');
  assert.equal(priceOrigin(priceHead(0)), 0);
});

t('the frame: the line comes from behind the left edge and ends at the "now" point', () => {
  const series = priceSeries(20260918, 200);
  const width = 320;
  const height = 56;
  for (const seconds of [0.4, 3, 8, 14, 30]) {
    const head = priceHead(seconds * 1000);
    const { min, max } = priceAxis(priceScaleWindow(series, head));
    const frame = priceFrame(series, head, min, max, width, height);
    const nums = frame.line.match(/-?\d+\.\d+/g).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    assert.ok(!frame.line.includes('NaN'), 'NaN in the path');
    assert.ok(Math.min(...xs) <= 0.01, `the line starts inside the frame at ${seconds}s`);
    assert.ok(Math.max(...xs) <= width + 0.01, `the line ran past the right edge at ${seconds}s`);
    assert.ok(Math.min(...ys) >= -0.01 && Math.max(...ys) <= height + 0.01, 'the line left the frame vertically');
    assert.ok(Math.abs(frame.dotX - Math.max(...xs)) < 0.01, 'the dot is not at the end of the line');
    assert.ok(frame.area.endsWith('Z'), 'the fill is not closed');
  }
});

t('during the run-up the line reaches the right edge exactly once', () => {
  const series = priceSeries(20260918, 200);
  const at = (ms) => priceFrame(series, priceHead(ms), 0, 2, 320, 56).dotX;
  const full = PRICE_TICK_MS * (PRICE_POINTS - PRICE_HEAD_START);
  assert.ok(at(0) < 30, 'on entry the line already fills the frame');
  assert.ok(Math.abs(at(full) - 320) < 0.5, `at the end of the run-up the tip is at ${at(full)}`);
  assert.ok(Math.abs(at(full * 3) - 320) < 0.5, 'after the run-up the tip has to stay at the right edge');
});

t('the growth is visible: during the run-up the price rises across the whole frame', () => {
  // We repeat exactly what the component does and look at the height of the
  // "now" point. That is what was missing: with the scale fitted to the visible
  // window the point stayed at one height and the growth disappeared.
  const series = priceSeries(20260918, 400);
  const height = 56;
  let min = priceAxis(priceScaleWindow(series, priceHead(0))).min;
  let max = priceAxis(priceScaleWindow(series, priceHead(0))).max;
  const tops = [];
  const dots = [];
  for (let frame = 0; frame < 60 * 30; frame++) {
    const elapsed = frame * (1000 / 60);
    const head = priceHead(elapsed);
    const axis = priceAxis(priceScaleWindow(series, head));
    const rate = 1 - Math.pow(0.02, (1000 / 60) / 1000);
    min += (axis.min - min) * rate;
    max += (axis.max - max) * rate;
    const f = priceFrame(series, head, min, max, 320, height);
    assert.ok(!f.line.includes('NaN') && f.dotY >= 0 && f.dotY <= height, `the frame is outside the box at ${elapsed}ms`);
    tops.push(height - f.dotY);
    dots.push({ x: f.dotX, y: f.dotY });
  }

  const rampFrames = Math.round((PRICE_TICK_MS * (PRICE_POINTS - PRICE_HEAD_START)) / (1000 / 60));
  assert.ok(tops[0] < height * 0.3, `on entry the price is already at the top: ${tops[0].toFixed(1)}`);
  assert.ok(tops[rampFrames] > height * 0.7, `it did not rise by the end of the run-up: ${tops[rampFrames].toFixed(1)}`);

  // The rise has pullbacks but goes up overall: more than two thirds of the
  // frames do not lower the line. A flat 100% would be a drawn curve.
  let rising = 0;
  for (let i = 1; i <= rampFrames; i++) if (tops[i] >= tops[i - 1] - 0.02) rising++;
  assert.ok(rising / rampFrames > 0.6, `the rise is ragged: ${(rising / rampFrames * 100).toFixed(0)}%`);
  assert.ok(rising / rampFrames < 0.95, `too smooth, no pullbacks visible: ${(rising / rampFrames * 100).toFixed(0)}%`);

  // After the run-up the line lives in the upper part of the frame and does not
  // lie on the ceiling: hitting the edge it flattens into a shelf and the growth
  // disappears again.
  const after = tops.slice(rampFrames + 60);
  assert.ok(Math.max(...after) < height * 0.97, `the line hits the ceiling: ${Math.max(...after).toFixed(1)} of ${height}`);
  assert.ok(Math.min(...after) > height * 0.12, `the line falls to the floor of the frame: ${Math.min(...after).toFixed(1)}`);

  // And the frame is alive with it: the tip of the line moves up and down
  // rather than staying at one height. A flat shelf is a sign the scale has
  // eaten every swing.
  const mean = after.reduce((a, b) => a + b, 0) / after.length;
  const spread = Math.sqrt(after.reduce((a, b) => a + (b - mean) ** 2, 0) / after.length);
  assert.ok(spread > height * 0.05, `no swings visible, the spread is ${spread.toFixed(1)} of ${height}`);

  // Smoothness: the dot does not jump between frames on either axis.
  const jump = dots.slice(1).map((d, i) => Math.hypot(d.x - dots[i].x, d.y - dots[i].y));
  assert.ok(Math.max(...jump) < 1.5, `a jerk of ${Math.max(...jump).toFixed(2)} px`);
});

t('the "now" price moves between points of the series rather than in jumps', () => {
  const series = priceSeries(3, 40);
  assert.equal(priceAt(series, 5), series[5]);
  const half = priceAt(series, 5.5);
  assert.ok(half > series[5] && half < series[6]);
});

t('the buying grows in steps, one per purchase', () => {
  const start = buyFrame(0, 10);
  assert.equal(start.boughtSol, 26);

  const steps = [];
  let previous = start.boughtSol;
  for (let ms = 0; ms < BUY_ROW_EVERY_MS * 21; ms += 100) {
    const frame = buyFrame(ms, 10);
    assert.ok(frame.boughtSol >= previous - 1e-9, `a drop at ${ms}`);
    if (frame.boughtSol > previous + 1e-9) {
      steps.push(Number((frame.boughtSol - previous).toFixed(2)));
    }
    previous = frame.boughtSol;
  }
  // Every step is the amount of a particular purchase from the feed.
  const known = new Set([4.2, 3.1, 2.8, 5, 2.4, 4.6, 3.3, 3.9, 2.7, 3.5]);
  for (const step of steps) {
    assert.ok(known.has(step) || step < 5, `the step ${step} does not look like a purchase`);
  }
  assert.ok(previous <= BUY_TARGET_SOL, 'we do not overshoot the budget');
  assert.ok(previous >= BUY_TARGET_SOL - 1, `we reached ${previous} of ${BUY_TARGET_SOL}`);
});

t('the candles start on the second purchase and end at 83.6 SOL', () => {
  const at = (done) => buyFrame(done * BUY_ROW_EVERY_MS + 5, 10);
  assert.equal(at(0).candles, 2, 'the hour starts with two candles');
  assert.equal(at(CANDLE_START_STEP - 1).candles, 2, 'nothing is added before the second purchase');
  assert.equal(at(CANDLE_START_STEP).candles, 3, 'the third candle arrives with the second purchase');

  // The last candle lands exactly at 83.6 SOL, a few purchases before the end.
  let last = null;
  for (let done = 0; done <= 24; done++) {
    if (at(done).candles === 10 && last === null) last = done;
  }
  assert.equal(at(last).boughtSol, CANDLE_DONE_SOL, `the last candle is at ${at(last).boughtSol} SOL`);
  assert.ok(at(last).boughtSol < BUY_TARGET_SOL - 10, 'it has to land noticeably before the end of the buying');

  // The series grows with no dips and never jumps by more than a candle per purchase.
  let prev = at(0).candles;
  for (let done = 1; done <= 20; done++) {
    const now = at(done).candles;
    assert.ok(now >= prev && now - prev <= 1, `a jump at purchase ${done}: ${prev} → ${now}`);
    prev = now;
  }
});

t('the purchases cover three coins, not one', () => {
  const tickers = new Set();
  for (let ms = 0; ms < BUY_ROW_EVERY_MS * 12; ms += BUY_ROW_EVERY_MS) {
    for (const row of buyRows(ms)) {
      tickers.add(row.coin.ticker);
    }
  }
  assert.deepEqual([...tickers].sort(), ['$MOCHI', '$TOAD', '$ZAPZ']);
});

t('a purchase time is computed from its place in the feed', () => {
  assert.equal(buyRowAge(0), 'now');
  assert.equal(buyRowAge(1), '2 min ago');
  assert.equal(buyRowAge(2), '4 min ago');
});

t('the purchases run as a feed: three rows, the new one on top', () => {
  const first = buyRows(0);
  assert.equal(first.length, BUY_ROWS_RENDERED, 'three visible plus the one leaving');
  const next = buyRows(BUY_ROW_EVERY_MS + 10);
  assert.notEqual(next[0].tx, first[0].tx, 'a new purchase on top');
  assert.equal(next[1].tx, first[0].tx, 'the previous one moved down');
  // The feed loops: the scene can stay up as long as it likes.
  assert.equal(buyRows(BUY_ROW_EVERY_MS * 10).length, BUY_ROWS_RENDERED);
});

t('the top row and the total move together, with no race', () => {
  // The total grew by exactly what the arriving row says. If those two numbers
  // drift apart, the viewer sees the counter lagging behind the feed.
  let prevBuy = buyFrame(0, 10).boughtSol;
  let prevTop = buyRows(0)[0];
  for (let tick = 1; tick <= 40; tick++) {
    const at = tick * BUY_ROW_EVERY_MS + 5;
    const frame = buyFrame(at, 10);
    const top = buyRows(at)[0];
    const grew = Math.round((frame.boughtSol - prevBuy) * 100) / 100;
    if (top !== prevTop && grew > 0) {
      assert.equal(grew, top.sol, `at tick ${tick} the total grew by ${grew} while the row says ${top.sol}`);
    }
    prevBuy = frame.boughtSol;
    prevTop = top;
  }

  // The same in the commit feed: a row arrived and the pool grew by exactly it.
  let prevPool = feedFrame(0).totalSol;
  let prevRow = feedFrame(0).rows[0];
  for (let tick = 1; tick <= 40; tick++) {
    const at = tick * COMMIT_EVERY_MS + 5;
    const frame = feedFrame(at);
    const grew = Math.round((frame.totalSol - prevPool) * 100) / 100;
    if (frame.rows[0] !== prevRow && grew > 0) {
      assert.equal(grew, frame.rows[0].sol, `at tick ${tick} the pool grew by ${grew} while the row says ${frame.rows[0].sol}`);
    }
    prevPool = frame.totalSol;
    prevRow = frame.rows[0];
  }
});

t('delivery plays once and stays filled', () => {
  const early = payoutFrame(100, 3);
  assert.ok(early.fill[0] > 0 && early.fill[2] === 0, JSON.stringify(early.fill));
  const later = payoutFrame(3 * 900 + 100, 3);
  assert.deepEqual(later.sent, [true, true, true]);
  // Nothing resets after that: the scene freezes in its final state.
  const muchLater = payoutFrame(60_000, 3);
  assert.deepEqual(muchLater.fill.map((v) => Math.round(v)), [1, 1, 1]);
  assert.ok(payoutDurationMs(3) < 3200, `${payoutDurationMs(3)}`);
});

console.log(`\n${n} tests passed`);
