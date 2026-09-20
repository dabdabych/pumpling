// Leaving a pool by the mark in the header.
//
// The main page pins its first screen, and it decides whether to pin by
// measuring one frame after it appears. Arriving from an inner page, that frame
// can land while the old page is still in the document, and then the story pins
// to a place the page has already left: the mascot and the cards scroll away
// with the first screen and the story stops halfway through "How it works".
//
// Reported twice from a real Chrome, and settled once by making the
// measurements wait until they stop moving. The mark is how most people leave a
// pool, so that path takes the fix that cannot be got wrong: the browser loads
// the main page afresh and there is no previous page to measure against.
//
// What this suite pins down is that the mark is a real document navigation and
// not a router swap. With `routerLink` the page never reloads, the JavaScript
// context survives, and the measurement race is back.
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

const settle = async () => {
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(3000);
};

for (let attempt = 0; attempt < 3; attempt++) {
  try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
  catch (e) { if (attempt === 2) throw e; }
}
await settle();

const brand = p.locator('.site-header__brand').first();
ok(await brand.count() > 0, 'the pool page has the mark in its header');

// A real link rather than a click handler, so a middle click still opens a tab.
const href = await brand.getAttribute('href');
ok(href === '/', `the mark is a link to the main page (href ${href})`);

// A token that only survives if the document does. The router keeps the same
// document, so under the old behaviour this comes back intact.
await p.evaluate(() => { window.__documentToken = 'before-the-click'; });
ok(
  await p.evaluate(() => window.__documentToken) === 'before-the-click',
  'the token is set before leaving'
);

await Promise.all([
  p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
  brand.click()
]);
await settle();

ok(new URL(p.url()).pathname === '/', `the mark lands on the main page (${new URL(p.url()).pathname})`);
ok(
  await p.evaluate(() => window.__documentToken) === undefined,
  'the page was loaded afresh, not swapped in by the router'
);

// And the thing the reload is for: the first screen is held still and whole.
const shape = await p.evaluate(() => {
  const hero = document.getElementById('qres-hero');
  const opacity = (el) => (el ? +(+getComputedStyle(el).opacity).toFixed(2) : null);
  return {
    position: hero ? getComputedStyle(hero).position : null,
    spacers: document.querySelectorAll('.pin-spacer').length,
    mascot: opacity(hero?.querySelector('.qres-hero-mascot')),
    cards: opacity(hero?.querySelector('.qres-hero-cards'))
  };
});
ok(shape.position === 'fixed', `the first screen is pinned after the reload (${shape.position})`);
ok(shape.spacers === 1, `with one spacer, not a leftover (${shape.spacers})`);
ok(shape.mascot !== null && shape.mascot > 0.9, `the mascot is there (opacity ${shape.mascot})`);
ok(shape.cards !== null && shape.cards > 0.9, `and the cards are there (opacity ${shape.cards})`);

// The story still advances all the way, which is the half of the bug a person
// actually reports.
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
ok(!stuck, `the story keeps moving (stopped at ${y})`);
ok(reached, `and gets from How it works to Quick start (y ${y})`);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'BRAND RELOAD ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
