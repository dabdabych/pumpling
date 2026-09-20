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

/**
 * What the first screen is actually made of.
 *
 * Checking the hero block alone was not enough and let a whole page through: the
 * block stayed at opacity 1 while everything inside it — mascot, title, cards —
 * sat at zero, left there by a transition that was cut short. From the outside
 * the page was the header, the section strip and nothing else.
 */
const heroContent = () => p.evaluate(() => {
  const hero = document.getElementById('qres-hero');
  const opacity = (el) => (el ? +(+getComputedStyle(el).opacity).toFixed(2) : null);
  const parts = ['.qres-hero-mascot', '.qres-hero-title', '.qres-hero-lede', '.qres-hero-cards', '.qres-hero-headline']
    .map((selector) => [selector, opacity(hero?.querySelector(selector))])
    .filter(([, value]) => value !== null);
  const cards = Array.from(hero?.querySelectorAll('.qres-hero-cards > *') ?? []).map(opacity);
  const hidden = [...parts.filter(([, v]) => v < 0.99).map(([s]) => s), ...cards.filter((v) => v < 0.99).map(() => 'card')];
  return { whole: hidden.length === 0, hidden, scrollY: Math.round(window.scrollY) };
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
  if (label === 'hero') {
    const content = await heroContent();
    ok(content.whole, `hero: the first screen is whole (${content.hidden.join(', ') || 'everything in place'})`);
  }
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
  // And back to the first screen: an interrupted transition must not leave it
  // empty, whichever way the story was left.
  await p.click('[data-nav-label="hero"]').catch(() => {});
  await p.waitForTimeout(2400);
  const content = await heroContent();
  ok(
    content.whole && content.scrollY === 0,
    `interrupted run ${round + 1}: the first screen comes back whole (${content.hidden.join(', ') || 'everything in place'}, y ${content.scrollY})`
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

// 4. Every gesture has to do something.
//
// Landing on the last stop puts a hold on the page so the tail of that same
// swipe does not carry it into the footer. The hold used to eat the whole next
// gesture: the page was under `overflow: hidden`, the browser had already
// decided the event scrolled nothing, and unlocking inside the handler did not
// bring it back. From the outside, a swipe that did nothing at all.
await p.click('[data-nav-label="quick"]').catch(() => {});
await p.waitForTimeout(2500);
const atLastStop = (await screenState()).scrollY;
await p.mouse.wheel(0, 400);
await p.waitForTimeout(1200);
const afterLastStop = (await screenState()).scrollY;
ok(
  afterLastStop > atLastStop,
  `the first swipe after the last stop moves the page (${atLastStop} -> ${afterLastStop})`
);

// 5. Coming back to the first screen must not take it out of the story.
//
// Restoring the first screen after a transition used to kill the tweens on the
// cards by target, and `gsap.killTweensOf` reaches inside the story timeline,
// which owns three of them. After one return to the hero the story could no
// longer move those cards: they stayed lit over "What is it" and "How it works"
// with their text printed across the panel's own. One trip was enough, and it
// never healed short of a reload — so the walk here is trip, return, walk on.
const heroCard = () => p.evaluate(() => {
  const card = document.querySelector('.qres-hero-card');
  if (!card) return null;
  const box = card.getBoundingClientRect();
  return {
    opacity: +(+getComputedStyle(card).opacity).toFixed(2),
    onScreen: box.top < window.innerHeight && box.bottom > 0
  };
});

for (const label of ['how', 'what']) {
  await p.click('[data-nav-label="hero"]').catch(() => {});
  await p.waitForTimeout(2400);
  const home = await heroCard();
  ok(home && home.opacity > 0.9, `hero: the Commit SOL card is there to begin with (opacity ${home?.opacity})`);

  await p.click(`[data-nav-label="${label}"]`).catch(() => {});
  await p.waitForTimeout(2400);
  const away = await heroCard();
  ok(
    away && (away.opacity < 0.15 || !away.onScreen),
    `${label} after a return to the hero: the first screen is out of the way (opacity ${away?.opacity}, on screen ${away?.onScreen})`
  );
}

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'STORY NAV ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
