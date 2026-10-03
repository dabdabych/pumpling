// What the pool page says while the buying runs.
//
// The page used to count down one fixed window whatever the buyer was doing.
// The buyer spends fifty minutes on its main pass and then, only if something
// did not go through, up to fifteen more buying it again. Measured on round
// 1790348400190 (2026-09-25): one purchase of twenty-nine expired on the way
// and was bought in that second pass.
//
// So there were two ways to lie. A round that finished early left a countdown
// ticking with nothing behind it, and a round in its second pass showed
// 00:00:00 while purchases were still going out — the page said the buying was
// over and the chain said otherwise.
import assert from 'node:assert/strict';
import { buildPoolView, poolCardLine, poolCardNote } from './pool-view.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** A round in its buying phase: started fifty minutes' worth of window ago. */
const snapshot = (over = {}) => ({
  market: 'dex',
  phase: 'buying',
  draw: 'ready',
  poolId: 128,
  closesAtMs: NOW - 60 * MINUTE,
  buysStartedAtMs: NOW - 20 * MINUTE,
  buysEndAtMs: NOW + 30 * MINUTE,
  nextPoolAtMs: null,
  drawStartedAtMs: null,
  drawEndsAtMs: null,
  launchAtMs: null,
  totalSol: 35,
  capSol: 111,
  remainingSol: 76,
  buyBudgetSol: 34,
  coins: [],
  accounts: null,
  ...over,
});

const feed = (over = {}) => ({
  available: true,
  targetSol: 34,
  boughtSol: 20,
  completed: 18,
  planned: 29,
  finished: false,
  phase: 'buying',
  fallbackEndsAtMs: null,
  coins: [],
  purchases: [],
  ...over,
});

t('the main pass counts down to the end of its window', () => {
  const view = buildPoolView(snapshot(), NOW, feed());

  assert.equal(view.timer.label, 'Buys end in');
  assert.equal(view.timer.value, '00:30:00');
  assert.equal(view.timer.ticking, true);
  assert.equal(view.title.plate, 'running');
});

t('the second pass has a countdown of its own', () => {
  const view = buildPoolView(
    // The main window has run out: without the second pass this timer is zero.
    snapshot({ buysEndAtMs: NOW - MINUTE }),
    NOW,
    feed({ phase: 'fallback', fallbackEndsAtMs: NOW + 9 * MINUTE })
  );

  assert.equal(view.timer.label, 'Second pass ends in');
  assert.equal(view.timer.value, '00:09:00');
  assert.equal(view.timer.ticking, true);
  assert.equal(view.phase, 'buying', 'the round is still buying');
  assert.equal(view.step, 2);
  assert.equal(view.canCommit, false);
});

t('and says what it is doing, in one sentence', () => {
  const view = buildPoolView(
    snapshot({ buysEndAtMs: NOW - MINUTE }),
    NOW,
    feed({ phase: 'fallback', fallbackEndsAtMs: NOW + 9 * MINUTE })
  );

  assert.match(view.lede, /did not go through/);
  assert.match(view.lede, /bought again/);
  // Nothing about an hour: that was the main pass and it is over.
  assert.doesNotMatch(view.lede, /hour/);
});

t('a second pass with no deadline still reads as running, not as zero', () => {
  const view = buildPoolView(
    snapshot({ buysEndAtMs: NOW - MINUTE }),
    NOW,
    feed({ phase: 'fallback', fallbackEndsAtMs: null })
  );

  assert.equal(view.timer.value, 'Running');
  assert.equal(view.timer.ticking, false);
});

t('everything bought early: the countdown runs on, to the close', () => {
  const view = buildPoolView(snapshot(), NOW, feed({ phase: 'finished', completed: 29 }));

  // The pool closes at the end of its window and not before, so half an
  // hour of window left is half an hour on the clock, not "shortly".
  assert.equal(view.title.plate, 'done');
  assert.equal(view.timer.label, 'Pool wraps up in');
  assert.equal(view.timer.value, '00:30:00');
  assert.equal(view.timer.ticking, true);
  assert.equal(view.timer.note, 'nothing more to buy');
});

t('everything bought and the window over: wrapping up, not a zero clock', () => {
  const view = buildPoolView(snapshot({ buysEndAtMs: NOW - 5_000 }), NOW, feed({ phase: 'finished', completed: 29 }));

  assert.equal(view.timer.value, 'Wrapping up');
  assert.equal(view.timer.ticking, false);
});

t('the window over and the buyer still at it: finishing, not 00:00:00', () => {
  // The last purchase can be on its way for up to two minutes past the end
  // of the window, and the pool now waits for it.
  const view = buildPoolView(snapshot({ buysEndAtMs: NOW - 40_000 }), NOW, feed({ phase: 'buying' }));

  assert.equal(view.timer.value, 'Finishing');
  assert.equal(view.timer.ticking, false);
  assert.doesNotMatch(view.timer.value, /00:00:00/);
  assert.equal(view.phase, 'buying');
});

t('a second pass past its own deadline: finishing, not 00:00:00', () => {
  const view = buildPoolView(
    snapshot({ buysEndAtMs: NOW - 10 * MINUTE }),
    NOW,
    feed({ phase: 'fallback', fallbackEndsAtMs: NOW - 20_000 })
  );

  assert.equal(view.timer.value, 'Finishing');
  assert.equal(view.timer.ticking, false);
});

t('nothing bought at all: says so, and that the SOL goes back', () => {
  const view = buildPoolView(snapshot(), NOW, feed({ phase: 'finished', finished: true, completed: 0, boughtSol: 0, planned: 0 }));

  assert.equal(view.title.lead, 'Nothing could be');
  assert.equal(view.title.plate, 'bought');
  assert.match(view.lede, /None of the coins in this pool could be bought\. The SOL goes back/);
  // The SOL is on its way back now; the pool itself closes with its window.
  assert.equal(view.timer.label, 'Pool wraps up in');
  assert.equal(view.timer.value, '00:30:00');
  assert.equal(view.timer.note, 'the SOL is on its way back');
});

t('something bought: done, without claiming every planned buy was made', () => {
  const view = buildPoolView(snapshot(), NOW, feed({ phase: 'finished', finished: true, completed: 12 }));

  assert.equal(view.title.plate, 'done');
  assert.doesNotMatch(view.lede, /Every buy this pool planned/);
  assert.match(view.lede, /whatever could not be spent goes back/);
});

t('the bar keeps showing what was actually bought, in every one of them', () => {
  for (const phase of ['buying', 'fallback', 'finished']) {
    const view = buildPoolView(
      snapshot(),
      NOW,
      feed({ phase, fallbackEndsAtMs: phase === 'fallback' ? NOW + MINUTE : null })
    );
    assert.equal(view.progress.label, '20 of 34 SOL bought', phase);
  }
});

t('without the buyer the page behaves exactly as it did before', () => {
  const view = buildPoolView(snapshot(), NOW, undefined);

  assert.equal(view.timer.label, 'Buys end in');
  assert.equal(view.progress.label, 'Buy window');
});

t('the card on the main page drops a countdown that has run out', () => {
  // It does not follow the second pass — it has no feed — so a zero clock
  // there would be a lie of a different kind.
  assert.equal(poolCardLine(snapshot(), NOW), 'Buys running · 00:30:00 left');
  assert.equal(poolCardLine(snapshot({ buysEndAtMs: NOW - MINUTE }), NOW), 'Buys running');
});

t('before the first pool the card counts down to it', () => {
  // The launch date is known, so the note under the line is the time left,
  // not a pointer to X.
  const launch = snapshot({ phase: 'launch', launchAtMs: NOW + 28 * 60 * MINUTE + 15 * MINUTE });
  assert.equal(poolCardLine(launch, NOW), 'The first pool opens soon');
  assert.equal(poolCardNote(launch, NOW), 'Opens in 1d 04h 15m');
  assert.equal(poolCardNote(launch, NOW + 25 * 60 * MINUTE), 'Opens in 03:15:00', 'within a day it shows the seconds');
  assert.equal(poolCardNote(snapshot({ phase: 'done' }), NOW), 'We announce the next pool on our X');
  assert.equal(poolCardNote(snapshot(), NOW), null);
});

console.log(`\n${n} tests passed`);
