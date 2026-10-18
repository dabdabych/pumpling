// What the main page's Commit SOL card says, phase by phase.
//
// The card is Gleb's drawing with two lines over it, as he drew it: what
// pressing it does, and where the round is. Written for a site with few
// participants: it must never show a zero (an empty pool reads as "nobody does
// this"). "Promote your coin" only while a pool takes SOL (it said "Commit
// SOL" until 2026-10-16): the rest of the time the card says what pressing it
// does instead. It leads to the pool page and never opens the commit dialog. The card is `pool-cta.ts`; these
// run it without a browser.
import assert from 'node:assert/strict';
import { poolCta } from './pool-cta.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const snapshot = (over = {}) => ({
  market: 'dex', phase: 'open', draw: null, poolId: 7, closesAtMs: NOW + 4 * MIN + 46_000,
  buysStartedAtMs: null, buysEndAtMs: null, nextPoolAtMs: null, drawStartedAtMs: null, drawEndsAtMs: null,
  launchAtMs: null, totalSol: 0, capSol: 77, remainingSol: 77, buyBudgetSol: 0, coins: [], accounts: null, ...over
});
const coin = (ticker, sol) => ({ mint: `${ticker}mint`, name: ticker, ticker, logoUrl: null, sol, commits: 1, poolShare: 0, drawnSol: null, burnBps: 0, screening: null });
const input = (snap, over = {}) => ({ snapshot: snap, nowMs: NOW, lastPool: null, ...over });

t('an open pool: Promote your coin and the clock, to the pool page', () => {
  const view = poolCta(input(snapshot()));
  assert.equal(view.title, 'Promote your coin');
  assert.equal(view.status, 'Pool open · closes in 00:04:46');
  assert.equal(view.live, true);
  assert.deepEqual(view.link, { to: 'pool' });
});

t('no line of the card is ever a zero count', () => {
  for (const phase of ['open', 'opening', 'locked', 'buying', 'done', 'waiting', 'launch']) {
    const view = poolCta(input(snapshot({ phase, launchAtMs: NOW + MIN, nextPoolAtMs: NOW + MIN, buysEndAtMs: NOW + MIN })));
    const text = [view.title, view.status].join(' | ');
    assert.doesNotMatch(text, /\b0 (coins?|SOL|buys?)\b/, `${phase}: ${text}`);
  }
});

t('with coins in or not, the same two lines: nothing to count can be a zero', () => {
  const empty = poolCta(input(snapshot()));
  const full = poolCta(input(snapshot({ coins: [coin('A', 1), coin('B', 0.4)], totalSol: 1.4 })));
  assert.deepEqual([full.title, full.status], [empty.title, empty.status]);
});

t('"Promote your coin" only while a pool takes SOL, and never the commit dialog', () => {
  for (const phase of ['open', 'opening']) {
    const view = poolCta(input(snapshot({ phase })));
    assert.equal(view.title, 'Promote your coin', phase);
    assert.deepEqual(view.link, { to: 'pool' }, phase);
  }
  for (const phase of ['locked', 'buying', 'done', 'waiting', 'launch']) {
    const view = poolCta(input(snapshot({ phase, launchAtMs: NOW + MIN, nextPoolAtMs: NOW + MIN, buysEndAtMs: NOW + MIN })));
    assert.notEqual(view.title, 'Promote your coin', phase);
  }
  for (const phase of ['loading', 'launch', 'opening', 'open', 'locked', 'buying', 'done', 'waiting']) {
    const view = poolCta(input(snapshot({ phase, launchAtMs: NOW + MIN, nextPoolAtMs: NOW + MIN, buysEndAtMs: NOW + MIN })));
    assert.ok(view.link.to === 'pool' || view.link.to === 'archive', `${phase}: ${JSON.stringify(view.link)}`);
  }
});

t('the draw: watch it', () => {
  const view = poolCta(input(snapshot({ phase: 'locked', draw: 'running' })));
  assert.equal(view.title, 'Watch the draw');
  assert.equal(view.status, 'Pool locked · draw in progress');
  assert.equal(poolCta(input(snapshot({ phase: 'locked', draw: 'pending' }))).status, 'Pool locked · draw starting');
  assert.deepEqual(view.link, { to: 'pool' });
});

t('while it buys: watch the buys, and the time left', () => {
  const view = poolCta(input(snapshot({ phase: 'buying', buysEndAtMs: NOW + 32 * MIN })));
  assert.equal(view.title, 'Watch the buys');
  assert.equal(view.status, 'Buying now · 00:32:00 left');
  assert.equal(view.live, true);
  const late = poolCta(input(snapshot({ phase: 'buying', buysEndAtMs: NOW - MIN })));
  assert.equal(late.status, 'Buying now', 'a clock that ran out is dropped, the second pass has its own');
});

t('between pools, how the pool that has just ended went, linked to it in the archive', () => {
  const view = poolCta(input(snapshot({ phase: 'done', poolId: 7, nextPoolAtMs: NOW + 4 * MIN + 12_000 }), { lastPool: { id: 7, totalSol: 21, buys: 52 } }));
  assert.equal(view.title, 'See how it ended');
  assert.equal(view.status, 'Next pool in 00:04:12');
  assert.deepEqual(view.link, { to: 'archive', pool: 7 });
  assert.equal(view.live, false);
});

t('after an empty pool, an older one is not passed off as the last', () => {
  const view = poolCta(input(snapshot({ phase: 'done', poolId: 8, nextPoolAtMs: NOW + MIN }), { lastPool: { id: 7, totalSol: 21, buys: 52 } }));
  assert.equal(view.title, 'See the pool');
  assert.deepEqual(view.link, { to: 'pool' });
});

t('before the first pool, the time left to it', () => {
  const view = poolCta(input(snapshot({ phase: 'launch', launchAtMs: NOW + 28 * 60 * MIN + 15 * MIN })));
  assert.equal(view.status, 'First pool opens in 1d 04h 15m');
  assert.equal(view.title, 'See the pool');
});

t('while the round is not known yet, the card is still the way in', () => {
  const view = poolCta(input(snapshot({ phase: 'loading' })));
  assert.equal(view.title, 'Promote your coin');
  assert.equal(view.status, '');
});

console.log(`\n${n} card tests passed`);
