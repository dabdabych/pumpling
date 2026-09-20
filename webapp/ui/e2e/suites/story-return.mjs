// Coming back to the main page from somewhere else.
//
// The first screen is pinned: ScrollTrigger holds it still while the story
// plays underneath, and it decides whether to pin when it measures. Measuring
// happens a frame after the page appears, and on a return from the pool page
// that frame lands while the pool page is still in the document — a thousand
// pixels of it, pushing the first screen down. The story was then pinned to a
// place the page had already left, so nothing pinned at all: the first screen
// scrolled away with the mascot and the cards on it, and the story stopped
// advancing halfway through "How it works".
//
// Reported from a real browser as "the mascot and the coins disappear and it
// will not scroll to quick start". A window resize cured it, which is what
// pointed at the measurement rather than at the pinning.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const ctx = await b.newContext({ viewport: { width: 1512, height: 860 } });
await mockCurrent(ctx, () => SCENARIOS.open());
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));

/** Whether the first screen is held still, and where the story thinks it starts. */
const pinned = () => p.evaluate(() => {
  const hero = document.getElementById('qres-hero');
  const spacer = document.querySelector('.pin-spacer');
  return {
    position: hero ? getComputedStyle(hero).position : null,
    spacers: document.querySelectorAll('.pin-spacer').length,
    spacerTop: spacer ? Math.round(spacer.getBoundingClientRect().top + window.scrollY) : null,
  };
});

for (let attempt = 0; attempt < 3; attempt++) {
  try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
  catch (e) { if (attempt === 2) throw e; }
}
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p.waitForTimeout(3000);

const fresh = await pinned();
ok(fresh.position === 'fixed', `on a fresh load the first screen is pinned (${fresh.position})`);

// Out to the pool page and back, the way somebody looking at a pool does it.
await p.locator('a[routerlink="/pool"], a[href="/pool"]').first().click();
await p.waitForTimeout(3500);
ok(new URL(p.url()).pathname === '/pool', `the Commit SOL card opens the pool (${new URL(p.url()).pathname})`);

await p.goBack();
// Long enough for the measurements to settle; the page allows itself four
// seconds before giving up on them.
await p.waitForTimeout(6000);

const back = await pinned();
ok(back.position === 'fixed', `and it is still pinned after coming back (${back.position})`);
ok(back.spacers === 1, `with one spacer, not a leftover from the page before (${back.spacers})`);

// The visible half of the same bug: an unpinned first screen scrolls away, so
// the mascot and the card animations go with it.
await p.click('[data-nav-label="how"]').catch(() => {});
await p.waitForTimeout(2500);

let y = await p.evaluate(() => Math.round(window.scrollY));
let reached = false;
let stuck = false;
for (let swipe = 0; swipe < 8; swipe++) {
  await p.mouse.wheel(0, 900);
  await p.waitForTimeout(1100);
  const now = await p.evaluate(() => Math.round(window.scrollY));
  reached = await p.evaluate(() => {
    const quick = document.querySelector('[aria-label="quick start"]');
    return !!quick && Number(getComputedStyle(quick).opacity) > 0.15;
  });
  if (now === y) { stuck = true; break; }
  y = now;
  if (reached) break;
}
ok(!stuck, `the story keeps moving after the round trip (stopped at ${y})`);
ok(reached, `and gets from How it works to Quick start (y ${y})`);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'STORY RETURN ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
