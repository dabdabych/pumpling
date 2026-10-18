// The order of the story, and How it works as a place of its own.
//
// Asked for on 2026-10-16: scrolling through What is it goes straight on to
// Quick start, with no How it works between them. How it works is reached from
// the header; once there, a scroll moves between its five phases and never out
// of them, and the last phase has a button to go on with (Promote your coin).
// What this checks, pinned (1440x900): the walk hero → What is it → Quick start
// and back, with no frame of How it works on the way; the way in from the
// header; down from the last phase and up from the first going nowhere, by
// wheel and by keys; the strip still leading out; the button on the last phase
// leading to the pool page, with no commit dialog opened for you. And laid out
// as an ordinary page (a phone), the sections in the order What is it, Quick
// start, How it works.
import { launch, BASE } from '../lib/browser.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { mockBubbles, mockChat } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function open(viewport = { width: 1440, height: 900 }) {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  await mockCard(ctx, 'openEmpty');
  await mockBubbles(ctx);
  await mockChat(ctx);
  await ctx.addInitScript(() => { window.__events = []; window.gtag = (...args) => { if (args[0] === 'event') window.__events.push({ name: args[1], ...args[2] }); }; });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  return { ctx, p, errors };
}

/** What is on screen: each overlay's opacity, and How it works' phase. */
const screen = (p) => p.evaluate(() => {
  const o = (sel) => { const el = document.querySelector(sel); return el ? +(+getComputedStyle(el).opacity).toFixed(2) : null; };
  const phase = [...document.querySelectorAll('[data-how-scene]')].findIndex((el) => +getComputedStyle(el).opacity > 0.5) + 1;
  return { what: o('[aria-label="what is it?"]'), how: o('[aria-label="how it works"]'), quick: o('[aria-label="quick start"]'), phase, y: Math.round(scrollY) };
});

/** Watches How it works' opacity on every frame from now on; `stop()` gives the most it reached. */
const watchHow = (p) => p.evaluate(() => {
  window.__howMax = 0;
  window.__howWatch = true;
  const tick = () => {
    const el = document.querySelector('[aria-label="how it works"]');
    if (el) window.__howMax = Math.max(window.__howMax, +getComputedStyle(el).opacity);
    if (window.__howWatch) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const howMax = (p) => p.evaluate(() => { window.__howWatch = false; return +window.__howMax.toFixed(2); });

const wheel = async (p, dy, settle = 1600) => { await p.mouse.move(700, 500); await p.mouse.wheel(0, dy); await p.waitForTimeout(settle); };

// ------------------------------------------------------------ the walk skips How it works
{
  const { ctx, p, errors } = await open();
  await watchHow(p);
  await wheel(p, 300);           // → What is it, beat 1
  await wheel(p, 300);           // → beat 2
  await wheel(p, 300);           // → beat 3
  let s = await screen(p);
  ok(s.what === 1 && s.quick === 0, `three steps down: the last beat of What is it (${JSON.stringify(s)})`);
  await wheel(p, 300, 2200);     // → Quick start, by a jump
  s = await screen(p);
  const seen = await howMax(p);
  ok(s.quick === 1 && s.how === 0 && s.what === 0, `the next step is Quick start (${JSON.stringify(s)})`);
  ok(seen === 0, `and not one frame of How it works on the way (most it showed: ${seen})`);

  await watchHow(p);
  await wheel(p, -300, 2200);    // back up: What is it again
  s = await screen(p);
  const seenBack = await howMax(p);
  ok(s.what === 1 && s.quick === 0, `a step up from Quick start is What is it again (${JSON.stringify(s)})`);
  ok(seenBack === 0, `again with no frame of How it works (most it showed: ${seenBack})`);
  const beat = await p.evaluate(() => [...document.querySelectorAll('[data-what-copy]')].findIndex((el) => [...el.querySelectorAll('[data-what-line]')].some((l) => +getComputedStyle(l).opacity > 0.5)) + 1);
  ok(beat === 3, `its last beat, the one the walk left from (beat ${beat})`);

  // Down to Quick start and on into the footer: the end of the story is still the way out.
  await wheel(p, 300, 2200);
  await wheel(p, 300, 1200);
  await wheel(p, 600, 1200);
  const footer = await p.evaluate(() => document.querySelector('.qres-footer')?.getBoundingClientRect().top < innerHeight);
  ok(footer, 'below Quick start the footer comes as before');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ How it works: a place of its own
{
  const { ctx, p, errors } = await open();
  await p.getByRole('button', { name: 'How it works' }).first().click();
  await p.waitForTimeout(2400);
  let s = await screen(p);
  ok(s.how === 1 && s.phase === 1, `the header's How it works opens it at phase 1 (${JSON.stringify(s)})`);

  await wheel(p, -300);
  s = await screen(p);
  ok(s.how === 1 && s.phase === 1 && s.what === 0, `up from phase 1 goes nowhere (${JSON.stringify(s)})`);

  for (let phase = 2; phase <= 5; phase++) {
    await wheel(p, 300);
    s = await screen(p);
    ok(s.how === 1 && s.phase === phase, `a step down: phase ${phase} (${s.phase})`);
  }
  const atEnd = s.y;
  await wheel(p, 300);
  await wheel(p, 900);
  s = await screen(p);
  ok(s.how === 1 && s.phase === 5 && s.quick === 0 && s.y === atEnd, `down from phase 5 goes nowhere, not to Quick start (${JSON.stringify(s)})`);
  await p.keyboard.press('PageDown');
  await p.waitForTimeout(1400);
  await p.keyboard.press('ArrowDown');
  await p.waitForTimeout(1400);
  s = await screen(p);
  ok(s.phase === 5 && s.y === atEnd, `nor with the keys (${JSON.stringify(s)})`);
  const footer = await p.evaluate(() => document.querySelector('.qres-footer')?.getBoundingClientRect().top < innerHeight);
  ok(!footer, 'and the footer does not come');

  // The button on the last phase.
  const cta = p.locator('.scene__cta');
  const box = await cta.boundingBox();
  ok(!!box && box.y > 0 && box.y + box.height < 900 && (await cta.innerText()).trim() === 'Promote your coin', `phase 5 has "Promote your coin" on screen (${box ? Math.round(box.y) : 'none'})`);
  const hit = await p.evaluate(() => {
    const el = document.querySelector('.scene__cta'); const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === el || el.contains(top);
  });
  ok(hit, 'and it takes the press, the section around it does not swallow it');
  await cta.click();
  await p.waitForURL(/\/pool$/, { timeout: 10000 });
  await p.waitForTimeout(1500);
  ok(await p.locator('mat-dialog-container').count() === 0, 'it leads to the pool page, and no commit dialog opens by itself');
  const ev = (await p.evaluate(() => window.__events)).map((e) => e.name);
  ok(ev.includes('how_promote_click'), `the press is counted (${ev.join(', ')})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// The strip still leads out of How it works, to either side.
{
  const { ctx, p } = await open();
  await p.getByRole('button', { name: 'How it works' }).first().click();
  await p.waitForTimeout(2400);
  await p.click('[data-nav-label="quick"]');
  await p.waitForTimeout(2400);
  let s = await screen(p);
  ok(s.quick === 1 && s.how === 0, `from How it works the strip's Quick start leads out (${JSON.stringify(s)})`);
  await wheel(p, -300, 2200);
  s = await screen(p);
  ok(s.what === 1 && s.how === 0, `and from there a step up is What is it, not back into How it works (${JSON.stringify(s)})`);
  await p.getByRole('button', { name: 'How it works' }).first().click({ timeout: 2000 }).catch(() => {});
  await p.click('[data-nav-label="hero"]');
  await p.waitForTimeout(2400);
  await p.getByRole('button', { name: 'How it works' }).first().click();
  await p.waitForTimeout(2400);
  await p.click('[data-nav-label="what"]');
  await p.waitForTimeout(2400);
  s = await screen(p);
  ok(s.what === 1 && s.how === 0, `and its What is it too (${JSON.stringify(s)})`);
  await ctx.close();
}

// /#how lands there and holds the same way.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCard(ctx, 'openEmpty'); await mockBubbles(ctx); await mockChat(ctx);
  const p = await ctx.newPage();
  await p.goto(BASE + '/#how', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForTimeout(3000);
  let s = await screen(p);
  ok(s.how === 1 && s.phase === 1, `/#how opens How it works (${JSON.stringify(s)})`);
  await wheel(p, -300);
  s = await screen(p);
  ok(s.how === 1 && s.phase === 1, `and up from there goes nowhere (${JSON.stringify(s)})`);
  await ctx.close();
}

// ------------------------------------------------------------ an ordinary page: What is it, Quick start, How it works
{
  const { ctx, p, errors } = await open({ width: 390, height: 844 });
  const order = await p.evaluate(() => [['what', '[aria-label="what is it?"]'], ['quick', '[aria-label="quick start"]'], ['how', '[aria-label="how it works"]']]
    .map(([name, sel]) => [name, Math.round(document.querySelector(sel).getBoundingClientRect().top + scrollY)])
    .sort((a, b) => a[1] - b[1]).map(([name]) => name).join(','));
  ok(order === 'what,quick,how', `on a phone the page reads What is it, Quick start, How it works (${order})`);
  const cta = await p.locator('.scene__cta').count();
  ok(cta === 1, 'and How it works ends with the button there too');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'STORY FLOW ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
