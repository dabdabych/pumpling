// The "How it works" link from the pool page has to open the section straight away.
//
// It is checked on a desktop window and on a phone, because the two reach the
// section by different code. On a desktop the story is pinned and the jump is a
// ScrollTrigger one. On a phone the story is an ordinary page and the jump is a
// plain `scrollIntoView` — and that one asked for `behavior: 'auto'`, which does
// not mean "instant": it means "take the value from CSS", and Tailwind's
// preflight sets `scroll-behavior: smooth` on :root. So the link scrolled the
// whole page past every screen for about a second. Reported from a phone.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const SCREENS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
];

for (const screen of SCREENS) {
  const { name, ...contextOptions } = screen;
  const ctx = await b.newContext(contextOptions);
  await mockCurrent(ctx, () => SCENARIOS.open());
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1200);

  // Sampling starts before the click and runs from inside the page: an in-app
  // navigation keeps the document, so the samples survive it and we see the
  // whole move, not only what is left when it is over.
  await p.evaluate(() => {
    window.__jumpSamples = [];
    const id = setInterval(() => window.__jumpSamples.push(Math.round(window.scrollY)), 30);
    setTimeout(() => clearInterval(id), 9000);
  });
  await p.locator('.pool-link', { hasText: 'How it works' }).first().click();
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForTimeout(6000);

  const samples = await p.evaluate(() => window.__jumpSamples);
  const positions = [...new Set(samples)];
  // A jump shows up as two positions: where we stood and where we arrived. A
  // ride shows up as dozens. Three allows for one intermediate frame.
  ok(positions.length <= 3, `${name}: no scroll ride through the story (${positions.length} positions: ${positions.slice(0, 8).join(', ')})`);

  const hash = await p.evaluate(() => location.hash);
  ok(new URL(p.url()).pathname === '/' && hash === '#how', `${name}: lands on the main page at ${hash}`);

  const how = await p.evaluate(() => {
    const node = document.querySelector('[aria-label="how it works"]');
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { opacity: Number(getComputedStyle(node).opacity).toFixed(2), top: Math.round(box.top), height: Math.round(box.height) };
  });
  ok(how && Number(how.opacity) > 0.9, `${name}: the How section is on screen right away ${JSON.stringify(how)}`);
  // It has to be the section we are standing on, not one further down the page.
  ok(how && how.top < screen.viewport.height * 0.5, `${name}: and the page stands on it (top ${how?.top})`);

  if (name === 'desktop') {
    // Pinned, so the sections share a screen and the wrong one would show through.
    const seen = await p.evaluate(() => ['what', 'quick'].filter((key) => {
      const node = document.querySelector(key === 'what' ? '[aria-label="what is it?"]' : '[aria-label="quick start"]');
      return node && Number(getComputedStyle(node).opacity) > 0.15;
    }));
    ok(seen.length === 0, `${name}: no other section shows through (${seen.join(', ') || 'none'})`);
  }

  ok(errors.length === 0, `${name}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'HOW JUMP ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
