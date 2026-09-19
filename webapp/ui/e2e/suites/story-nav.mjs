// Moving between story sections, including interrupted moves.
//
// On 2026-09-18 the main page could disappear entirely: somebody clicked the menu
// a second time without waiting for the first transition, it broke off on a half
// frame, and the hero block — which holds the whole story — stayed semi-transparent
// forever. Scrolling froze solid with it: nobody lowered the "transition running"
// flag any more and the engine held the page locked. Only a reload cured it.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
// The pool phase changes underfoot: the page refreshes the card every second, and
// a transition must not suffer for it.
let scenario = 'open';
await mockCurrent(ctx, () => SCENARIOS[scenario]());

const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));

for (let a = 0; a < 3; a++) {
  try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
}
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p.waitForTimeout(600);

/** Whether the story is visible: the hero block's opacity and whether the frame is alive. */
const screenState = () => p.evaluate(() => {
  const hero = document.getElementById('qres-hero');
  const style = hero ? getComputedStyle(hero) : null;
  return {
    opacity: style ? parseFloat(style.opacity) : 0,
    visibility: style ? style.visibility : 'hidden',
    scrollY: Math.round(window.scrollY)
  };
});

const labels = await p.evaluate(
  () => Array.from(document.querySelectorAll('[data-nav-label]')).map((n) => n.getAttribute('data-nav-label'))
);
ok(labels.length >= 3, `menu has the story sections (${labels.join(', ')})`);

// 1. A calm walk: every section arrives and stays visible.
for (const label of labels) {
  await p.click(`[data-nav-label="${label}"]`).catch(() => {});
  await p.waitForTimeout(1700);
  const state = await screenState();
  ok(state.opacity > 0.99 && state.visibility === 'visible', `${label}: the story is visible (opacity ${state.opacity})`);
}

// 2. Interrupted transitions: we click in a row without waiting.
scenario = 'buying';
// The moment of the interruption matters: hitting the middle of a smooth stretch
// does not happen first time, so we shift the pause between clicks each pass.
for (let round = 0; round < 4; round++) {
  for (const label of labels) {
    await p.click(`[data-nav-label="${label}"]`).catch(() => {});
    await p.waitForTimeout(160 + round * 60);
  }
  await p.waitForTimeout(2200);
  const state = await screenState();
  ok(
    state.opacity > 0.99 && state.visibility === 'visible',
    `interrupted run ${round + 1}: the page comes back whole (opacity ${state.opacity}, ${state.visibility})`
  );
}

// 3. After an interruption the scroll has to work: the "transition running" flag is down.
await p.click('[data-nav-label="hero"]').catch(() => {});
await p.waitForTimeout(220);
await p.click('[data-nav-label="how"]').catch(() => {});
await p.waitForTimeout(2400);
const before = (await screenState()).scrollY;
await p.mouse.wheel(0, 900);
await p.waitForTimeout(1100);
const after = await screenState();
ok(after.scrollY !== before, `the page still scrolls after an interrupted jump (${before} -> ${after.scrollY})`);
ok(after.opacity > 0.99, `and stays visible (opacity ${after.opacity})`);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'STORY NAV ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
