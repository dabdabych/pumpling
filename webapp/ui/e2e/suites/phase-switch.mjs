// Phase transitions on a live page: the pool closed, the draw ran, the buying ended.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, summary, entries, five, MINTS } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const chip = (p) => p.locator('.pool-card__head .chip').first().evaluate((el) => el.textContent.trim());
const waitChip = async (p, text, timeout = 25000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if ((await chip(p)) === text) return true;
    await p.waitForTimeout(250);
  }
  return false;
};

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
let scenario = SCENARIOS.open();
await mockCurrent(ctx, () => scenario);
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
ok(await chip(p) === 'Open', 'starts in the open pool');
const heightOpen = await p.evaluate(() => document.querySelector('.pool-card').getBoundingClientRect().height);

// open -> locked, the draw is running
scenario = SCENARIOS.lockedRunning();
ok(await waitChip(p, 'Locked'), 'picks up the locked pool from the server');
const animating = await p.evaluate(() => {
  const el = document.querySelector('.pool-card__state');
  return el ? el.getAnimations({ subtree: true }).length : -1;
});
ok(animating > 0, `the status card fades in instead of snapping (${animating} running animations)`);
ok(await p.locator('.pool-cta').count() === 0, 'the commit button is gone while the pool is locked');
// The draw takes minutes and a person needs to know how many: with no counter
// they only saw the words "In progress" and could not tell whether to wait.
{
  const card = (await p.locator('.pool-card__state').innerText()).replace(/\s+/g, ' ');
  ok(/Draw ends in/i.test(card) && /~\d+:\d\d/.test(card), `the draw shows how long it has left (${card.slice(0, 90)})`);
}
ok(await p.locator('.pool-track__step.is-current .pool-track__label').innerText() !== '', 'the track moved to the current step');

// locked -> buying, the draw shares appear
scenario = SCENARIOS.buying();
ok(await waitChip(p, 'Buying'), 'picks up the buying phase');
await p.waitForTimeout(600);
ok(await p.locator('.coin-row__drawn').count() > 0, 'the draw result shows up on the coin rows');

// buying -> done
scenario = SCENARIOS.done();
ok(await waitChip(p, 'Done', 30000), 'picks up the finished pool');
{
  const card = (await p.locator('.pool-card__state').innerText()).replace(/\s+/g, ' ');
  ok(/Next pool in/i.test(card) && /\d+:\d\d/.test(card), `done counts down to the next pool (${card.slice(0, 90)})`);
}
const heightDone = await p.evaluate(() => document.querySelector('.pool-card').getBoundingClientRect().height);
ok(Math.abs(heightDone - heightOpen) < 400, `the card does not jump wildly between phases (${Math.round(heightOpen)} -> ${Math.round(heightDone)}px)`);
ok(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, 'no horizontal scroll after all the switching');
// The card's departing rows must not pile up in the markup: the transition hides
// them and hands them over for removal, and several phase changes in a row leave
// no tails.
await p.waitForTimeout(900);
ok(await p.locator('.pool-card__clock').count() <= 1, `no leftover rows after the phase changes (${await p.locator('.pool-card__clock').count()})`);

// the timer reached zero while the server still says "created"
{
  const ctx2 = await b.newContext({ viewport: { width: 1440, height: 900 } });
  // The countdown to closing starts from the page's first request rather than
  // from the scenario being created: under load building the page takes seconds
  // and the pool managed to close before anyone saw it.
  let closesAt = null;
  const closing = () => {
    closesAt = closesAt ?? Date.now() + 9000;
    return { entries: entries(five), has_active_lottery: true, active_lotteries: [summary({ end_date: new Date(closesAt).toISOString() })], latest_lotteries: [], hype_countdowns: [] };
  };
  let scenario2 = closing;
  await mockCurrent(ctx2, () => (typeof scenario2 === 'function' ? scenario2() : scenario2));
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  // The same retry as on the first transition: under load the dev server does
  // not answer at once, and a single attempt used to fail the whole suite.
  for (let a = 0; a < 3; a++) { try { await p2.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
  await p2.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  ok(await chip(p2) === 'Open', 'a pool with seconds left is still open');
  const zero = await waitChip(p2, 'Locked', 20000);
  ok(zero, 'when the clock runs out the page locks the pool itself, without waiting for the server');
  // We wait for the transition to finish: while it runs both rows live in the
  // card, the departing and the arriving one.
  await p2.waitForFunction(() => document.querySelectorAll('.pool-card__clock').length === 1, null, { timeout: 5000 });
  const lockedClock = await p2.locator('.pool-card__clock').innerText();
  ok(lockedClock !== '00:00:00', `the clock does not sit at zero (${lockedClock})`);
  await ctx2.close();
}

// the card on the main page follows the phase
{
  const ctx3 = await b.newContext({ viewport: { width: 1440, height: 900 } });
  let scenario3 = SCENARIOS.open();
  await mockCurrent(ctx3, () => scenario3);
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) { try { await p3.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
  await p3.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  const line = () => p3.locator('.qres-hero-card span', { hasText: /Pool|Buys|opens/ }).first().innerText();
  ok(/POOL OPEN/i.test(await line()), `home card shows the open pool (${await line()})`);
  scenario3 = SCENARIOS.buying();
  const started = Date.now();
  let changed = false;
  while (Date.now() - started < 25000) {
    if (/BUYS RUNNING/i.test(await line())) { changed = true; break; }
    await p3.waitForTimeout(300);
  }
  ok(changed, `home card follows the phase (${await line()})`);
  await ctx3.close();
}

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'PHASE SWITCH ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
