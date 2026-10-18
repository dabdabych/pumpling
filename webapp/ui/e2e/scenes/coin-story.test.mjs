// The coin window from a bubble (coin-story.ts): tiny prices written the way
// trading sites write them, the pool's buys and the coin's way in marked on
// the candles they fall in, the window said in words, and the server's answer
// made safe before it reaches a link or a chart.
import assert from 'node:assert/strict';
import { boughtText, chartCandles, formatCap, formatTinyPrice, storyMarks, toStory, updatedText, windowText } from './coin-story.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('a tiny price counts its zeros in a subscript', () => {
  assert.equal(formatTinyPrice(1.55e-7), '0.0₆155');
  assert.equal(formatTinyPrice(3.011e-8), '0.0₇301');
  assert.equal(formatTinyPrice(1.2e-7), '0.0₆12', 'no trailing zeros');
  assert.equal(formatTinyPrice(9.996e-8), '0.0₆1', 'rounding up to the next decade');
  assert.equal(formatTinyPrice(0.00123), '0.00123', 'three zeros or fewer are written out');
  assert.equal(formatTinyPrice(0.3207), '0.321');
  assert.equal(formatTinyPrice(12.5), '12.5');
  assert.equal(formatTinyPrice(0), '0');
  assert.equal(formatTinyPrice(NaN), '0');
  assert.equal(formatTinyPrice(6.62e-24), '0', 'the axis zero, give or take floating point');
  assert.equal(formatTinyPrice(-3e-9), '0');
});

const minute = (m) => 1_791_000_000 + m * 60;   // a minute-aligned unix time
const candles = [0, 1, 2, 3, 5].map((m) => ({ t: minute(m), o: 1, h: 1, l: 1, c: 1, v: 1 }));
const at = (m, s = 0) => (minute(m) + s) * 1000;

t('one arrow per candle the pool bought in, the count of buys in it', () => {
  const marks = storyMarks({ candles, candleMinutes: 1, enteredAtMs: at(0, 50), buys: [
    { atMs: at(2, 5), sol: 0.4, signature: 'a' }, { atMs: at(2, 40), sol: 0.4, signature: 'b' }, { atMs: at(3, 1), sol: 0.4, signature: 'c' }
  ] });
  assert.deepEqual(marks, [
    { t: minute(0), kind: 'in', count: 0 },
    { t: minute(2), kind: 'buy', count: 2 },
    { t: minute(3), kind: 'buy', count: 1 }
  ]);
});

t('a buy with no candle under it is left off the chart', () => {
  const marks = storyMarks({ candles, candleMinutes: 1, enteredAtMs: at(0), buys: [{ atMs: at(4, 10), sol: 0.4, signature: 'gap' }] });
  assert.deepEqual(marks.map((m) => m.kind), ['in']);
});

t('a coin made in the minute it came in sits on its first candle', () => {
  const late = [{ t: minute(1), o: 1, h: 1, l: 1, c: 1, v: 1 }];
  assert.deepEqual(storyMarks({ candles: late, candleMinutes: 1, enteredAtMs: at(0, 50), buys: [] }), [{ t: minute(1), kind: 'in', count: 0 }]);
});

t('five-minute candles take the buys of their five minutes', () => {
  const five = [{ t: minute(0), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: minute(5), o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const marks = storyMarks({ candles: five, candleMinutes: 5, enteredAtMs: at(0), buys: [{ atMs: at(6), sol: 1, signature: 'x' }, { atMs: at(9, 59), sol: 1, signature: 'y' }] });
  assert.deepEqual(marks.find((m) => m.kind === 'buy'), { t: minute(5), kind: 'buy', count: 2 });
});

t('the window in words', () => {
  const from = Date.UTC(2026, 9, 4, 19, 1);
  assert.equal(windowText(from, Date.UTC(2026, 9, 4, 20, 35), false), 'Oct 4, 19:01 → 20:35 UTC');
  assert.equal(windowText(from, Date.UTC(2026, 9, 5, 1, 10), false), 'Oct 4, 19:01 → Oct 5, 01:10 UTC');
  assert.equal(windowText(from, Date.now(), true), 'Oct 4, 19:01 → now');
});

const raw = {
  mint: '8QSGZb2hc8zTM4GxsEUBfPhPUwZZDWWxUPdZPHvbpump', name: 'pumpling', symbol: '$PUMPLING', logo_url: 'javascript:alert(1)',
  trade_url: 'https://pump.fun/coin/8QSGZb2hc8zTM4GxsEUBfPhPUwZZDWWxUPdZPHvbpump', venue: 'pump.fun', lottery_id: 1791138900542,
  committed_sol: 20.05, entered_at: '2026-10-04T19:01:50Z', left_at: '2026-10-04T20:34:12Z', finished: true, window_start: '2026-10-04T18:56:50Z', window_end: '2026-10-04T20:39:12Z',
  buys: [{ at: '2026-10-04T19:46:00Z', sol: 0.39, signature: '5uvZ71Vute2nTR2UM1fCQTBV7bt5xuYGbK9gWdg3NkKY' }, { at: 'junk', sol: 1, signature: 'x' }],
  candles: [[1790000000, 1e-7, 2e-7, 1e-7, 2e-7, 5], [1790000060, 'x', 1, 1, 1, 1], [1790000120, 1, 0, 1, 1, 1]],
  candle_minutes: 1, chart_url: 'https://www.geckoterminal.com/solana/pools/ARxe', chart_state: 'ready'
};

t('the answer made safe: https only, real numbers, the ticker without its own dollar', () => {
  const story = toStory(raw);
  assert.equal(story.symbol, 'PUMPLING');
  assert.equal(story.logoUrl, null, 'a javascript: picture is dropped');
  assert.equal(story.buys.length, 1, 'a buy with no time or a bad signature is dropped');
  assert.equal(story.candles.length, 1, 'a candle with junk or a zero high is dropped');
  assert.equal(story.chartState, 'ready');
  assert.equal(story.enteredAtMs, Date.UTC(2026, 9, 4, 19, 1, 50));
  assert.equal(story.leftAtMs, Date.UTC(2026, 9, 4, 20, 34, 12));
  assert.equal(toStory({ ...raw, left_at: null }).leftAtMs, null, 'a pool still running has not let it go');
  assert.equal(toStory({ ...raw, trade_url: 'http://pump.fun/x' }), null, 'no https link to trade, no window');
  assert.equal(toStory({ ...raw, chart_state: 'weird' }).chartState, 'none');
});

t('what the pool bought, and "no share" only when the share was zero', () => {
  const sol = (v) => v.toFixed(2);
  const buy = (s) => ({ atMs: 1, sol: s, signature: 'x' });
  const base = { finished: true, buysKnown: true, buys: [], shareSol: 0, refundedSol: 0 };
  assert.equal(boughtText({ ...base, finished: false }, sol), 'The buys start when the pool closes');
  assert.equal(boughtText({ ...base, buysKnown: false }, sol), 'Not known right now');
  assert.equal(boughtText({ ...base, buys: [buy(0.39), buy(0.4)], shareSol: 0.8 }, sol), '2 public buys · 0.79 SOL');
  assert.equal(boughtText({ ...base, buys: [buy(0.5)], shareSol: 0.8, refundedSol: 0.3 }, sol), '1 public buy · 0.50 SOL · 0.30 SOL went back');
  assert.equal(boughtText({ ...base, shareSol: 15.02, refundedSol: 15.02 }, sol), 'None. Its 15.02 SOL share went back to its backers', 'LETTER on the stand');
  assert.equal(boughtText({ ...base, shareSol: 4.95 }, sol), 'None. Its 4.95 SOL share was not bought');
  assert.equal(boughtText({ ...base, shareSol: null }, sol), 'None', 'the buyer has no coins for the pool: not "no share"');
  assert.equal(boughtText(base, sol), 'Nothing: the draw gave it no share');
  assert.equal(toStory({ ...raw, share_sol: null }).shareSol, null);
  assert.equal(toStory({ ...raw, share_sol: 15.02, refunded_sol: 'x' }).refundedSol, 0);
});

t('market cap in SOL, three figures at most', () => {
  assert.equal(formatCap(96.4123), '96.4');
  assert.equal(formatCap(162.2), '162');
  assert.equal(formatCap(30.06), '30.1');
  assert.equal(formatCap(1234.5), '1.23K');
  assert.equal(formatCap(999.7), '1K', 'rounded first, never "1.00e+3"');
  assert.equal(formatCap(4_500_000), '4.5M');
  assert.equal(formatCap(2.5e9), '2.5B');
  assert.equal(formatCap(0), '0');
});

t('the chart is the market cap when the supply is known, the price otherwise', () => {
  const candles = [{ t: 1, o: 1e-7, h: 2e-7, l: 0.5e-7, c: 1.5e-7, v: 3 }];
  const cap = chartCandles({ candles, supply: 1e9 });
  assert.equal(cap.marketCap, true);
  assert.deepEqual([cap.candles[0].o, cap.candles[0].h, cap.candles[0].l, cap.candles[0].c].map((x) => Math.round(x * 100) / 100), [100, 200, 50, 150]);
  assert.equal(cap.candles[0].v, 3, 'the volume is left as it is');
  assert.equal(chartCandles({ candles, supply: null }).marketCap, false);
  assert.equal(chartCandles({ candles, supply: null }).candles, candles);
  assert.equal(toStory({ ...raw, supply: 919617853.13 }).supply, 919617853.13);
  assert.equal(toStory({ ...raw, supply: 0 }).supply, null);
  assert.equal(toStory({ ...raw, supply: null }).supply, null);
});

t('a chart still being refreshed says how old it is; on its way is a state of its own', () => {
  const now = Date.UTC(2026, 9, 18, 12, 0);
  assert.equal(updatedText(now - 20_000, now), 'updated just now');
  assert.equal(updatedText(now - 4 * 60_000 - 5_000, now), 'updated 4 min ago');
  assert.equal(updatedText(now + 5_000, now), 'updated just now', 'a server clock a little ahead is not "in -0 min"');
  const story = toStory({ ...raw, chart_state: 'pending', chart_final: false, chart_updated_at: '2026-10-18T11:56:00Z' });
  assert.equal(story.chartState, 'pending');
  assert.equal(story.chartFinal, false);
  assert.equal(story.chartUpdatedAtMs, Date.UTC(2026, 9, 18, 11, 56));
  assert.equal(toStory({ ...raw, chart_final: 'yes' }).chartFinal, false, 'only true is final');
});

console.log(`\n${n} coin window checks passed`);
