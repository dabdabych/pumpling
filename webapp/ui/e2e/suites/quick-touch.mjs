// Quick start under a finger: the rows show their hover looks in turn.
//
// On a touch screen hover does not exist: Tailwind 4 puts `hover:` and
// `group-hover:` under `@media (hover: hover)`, and our own hover rules sit
// under the same query so a tap cannot leave them stuck. Until 2026-10-01 only
// the falling coins had a finger version, so on a phone rows 02 to 05 never
// moved, and in the pinned story (tablets, phones on their side) nothing did.
//
// The first fix played each row by itself as it crossed a line on the screen.
// It passed a version of this suite that moved the page with `scrollTo`, which
// has no momentum. A real swipe carries the page on: the rows went off as they
// flew past, several at once and in whatever order the page moved. So the page
// is moved here with touch gestures (`Input.synthesizeScrollGesture`), flings
// with momentum included, and what is checked is what a person sees: nothing
// while the list flies past, then 01 to 05 one at a time once it is at rest.
//
// The checks read colours, positions and opacity, not the classes behind them,
// so they fail on the code before the fix.
//
// While at it: the Solana mark on Add SOL hung from the right edge of the
// title and sat on the word SOL wherever the column was narrow (phones, 1024
// to 1140px under a mouse), and the line under Add SOL stayed dark when its
// row went black, under a mouse as well.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const STEP = 3500;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const errors = [];
const NAMES = ['01 coins', '02 Add SOL', '03 Share', '04 clock', '05 tokens'];

async function open(options) {
  const ctx = await b.newContext(options);
  await mockCurrent(ctx, () => SCENARIOS.open());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${options.viewport.width}px: ${e.message}`));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/home', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1200);
  // Every frame from now on: which rows show their hover look, and where the
  // Solana mark sits against the words.
  await p.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-qres-quick-item]')];
    const black = (el) => getComputedStyle(el).backgroundColor === 'rgb(2, 2, 2)';
    // The second line of a title slides up from below; in place, it is level with its frame.
    const slidIn = (row) => {
      const words = row.querySelector('h3 span.absolute.inset-0');
      return !!words && Math.abs(words.getBoundingClientRect().top - words.parentElement.getBoundingClientRect().top) < 2;
    };
    const coins = [...rows[0].querySelectorAll('.qres-falling-coin')];
    const layer = rows[0].querySelector('.qres-falling-coins');
    const sol = rows[1];
    const circle = sol.querySelector('[data-qres-sol-circle]');
    const solWord = sol.querySelector('h3 span.absolute.inset-0')?.lastElementChild;
    const frame = sol.querySelector('h3 > span');
    const desc = sol.querySelector('.qres-quick-desc');
    window.__quick = { frames: [], mark: [] };
    const tick = () => {
      const t = Math.round(performance.now());
      window.__quick.frames.push({
        t,
        on: [
          // Falling, and not on their way out.
          coins.some((coin) => +getComputedStyle(coin).opacity > 0.05) && (!layer || +getComputedStyle(layer).opacity > 0.9),
          black(sol) && slidIn(sol),
          slidIn(rows[2]),
          +getComputedStyle(rows[3].querySelector('.qres-draw-timer-icon')).opacity > 0.9,
          black(rows[4])
        ]
      });
      if (+getComputedStyle(circle).opacity > 0.5) {
        const c = circle.getBoundingClientRect();
        const w = solWord.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        window.__quick.mark.push({
          t,
          left: c.left,
          overlap: Math.max(0, Math.min(c.right, w.right) - Math.max(c.left, w.left)),
          cut: Math.max(0, f.top - c.top, c.bottom - f.bottom, c.right - f.right, f.left - c.left),
          size: c.width,
          // A line under a black row has to be readable, not dark on black.
          descLight: black(sol) ? +getComputedStyle(desc).color.match(/\d+/)[0] > 200 : null
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return { ctx, p, cdp: await ctx.newCDPSession(p), height: options.viewport.height, width: options.viewport.width };
}

const now = (page) => page.evaluate(() => Math.round(performance.now()));
/** Per row: the moments it took its hover look and let it go, after `from`. */
const runs = (page, from) => page.evaluate((from) => {
  const frames = window.__quick.frames.filter((f) => f.t >= from);
  return [0, 1, 2, 3, 4].map((row) => {
    const out = [];
    let start = null;
    for (const f of frames) {
      if (f.on[row] && start === null) start = f.t;
      if (!f.on[row] && start !== null) { out.push([start, f.t]); start = null; }
    }
    if (start !== null) out.push([start, null]);
    return out;
  });
}, from);
/** The most rows showing their look in any one frame after `from`. */
const mostAtOnce = (page, from) => page.evaluate((from) => Math.max(0, ...window.__quick.frames.filter((f) => f.t >= from).map((f) => f.on.filter(Boolean).length)), from);
/** Where the mark settled (its leftmost frame: after that it only flies off to the right). */
const settledMark = (page, from) => page.evaluate((from) => {
  const marks = window.__quick.mark.filter((m) => m.t >= from);
  if (!marks.length) return null;
  const settled = marks.reduce((a, m) => (m.left < a.left ? m : a));
  const lights = marks.map((m) => m.descLight).filter((v) => v !== null);
  return { overlap: Math.round(settled.overlap), cut: Math.round(settled.cut), size: Math.round(settled.size), descLight: lights.length ? lights.every(Boolean) : null };
}, from);
const describe = (r, from) => r.map((row, i) => `${NAMES[i]}: ${row.length ? row.map(([a, z]) => `${((a - from) / 1000).toFixed(1)}-${z === null ? '…' : ((z - from) / 1000).toFixed(1)}`).join(',') : 'never'}`).join('; ');

/** The walk as it should be: every row once, in order, one at a time, a step each. */
function walkedInOrder(r) {
  if (!r.every((row) => row.length === 1 && row[0][1] !== null)) return false;
  const starts = r.map((row) => row[0][0]);
  const lengths = r.map((row) => row[0][1] - row[0][0]);
  return starts.every((t, i) => i === 0 || (t - starts[i - 1] >= STEP - 400 && t - starts[i - 1] <= STEP + 400))
    && lengths.every((ms) => ms >= STEP - 700 && ms <= STEP + 400);
}

/** A walk under way: the rows so far went in order from 01, a step apart, and at least `atLeast` of them. */
function startedInOrder(r, atLeast = 2) {
  const played = r.findIndex((row) => row.length === 0);
  const count = played === -1 ? r.length : played;
  if (count < atLeast || r.slice(count).some((row) => row.length > 0) || r.slice(0, count).some((row) => row.length !== 1)) return false;
  const starts = r.slice(0, count).map((row) => row[0][0]);
  return starts.every((t, i) => i === 0 || (t - starts[i - 1] >= STEP - 400 && t - starts[i - 1] <= STEP + 400));
}

// A finger. Dragging stops where it lets go; a fling carries on with momentum.
function touch(page) {
  const gesture = (dy, fling) => page.cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(page.width / 2),
    // Up the screen to scroll down, down the screen to scroll back.
    y: Math.round(page.height * (dy > 0 ? 0.8 : 0.2)),
    yDistance: -dy,
    gestureSourceType: 'touch',
    speed: fling ? 2500 : 800,
    preventFling: !fling
  });
  const listTop = () => page.p.evaluate(() => document.querySelector('.qres-quick-list').getBoundingClientRect().top);
  const headerBottom = () => page.p.evaluate(() => Math.max(0, document.querySelector('.qres-site-header').getBoundingClientRect().bottom));
  const limit = Math.round(page.height * 0.55);
  return {
    drag: (dy) => gesture(Math.max(-limit, Math.min(limit, dy)), false),
    fling: (dy) => gesture(Math.max(-limit, Math.min(limit, dy)), true),
    /** Drags until the list sits just under the header, the way a person settles on it. */
    async settleOnList() {
      for (let i = 0; i < 40; i++) {
        const gap = (await listTop()) - (await headerBottom()) - 12;
        if (Math.abs(gap) <= 8) return;
        await gesture(Math.max(-limit, Math.min(limit, gap)), false);
        await page.p.waitForTimeout(80);
      }
    }
  };
}

// 1. A phone, the way it was reported: flick down the page, come back up to
// Quick start, stay. Then take it away and bring it back.
{
  const page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { p } = page;
  const finger = touch(page);

  const flying = await now(p);
  for (let i = 0; i < 40 && (await p.evaluate(() => window.scrollY + innerHeight < document.documentElement.scrollHeight - 5)); i++) {
    await finger.fling(500);
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(1500);
  let r = await runs(p, flying);
  ok(r.every((row) => row.length === 0), `phone: flicking past Quick start plays nothing (${describe(r, flying)})`);

  const settled = await now(p);
  await finger.settleOnList();
  await p.waitForTimeout(5 * STEP + 1500);
  r = await runs(p, settled);
  ok(walkedInOrder(r), `phone: at rest on Quick start the rows play 01 to 05, a step each (${describe(r, settled)})`);
  ok(await mostAtOnce(p, settled) === 1, 'phone: one row at a time');
  const mark = await settledMark(p, settled);
  ok(!!mark && mark.overlap === 0 && mark.cut === 0, `phone: the Solana mark sits after the words, whole (${JSON.stringify(mark)})`);
  ok(!!mark && mark.descLight === true, 'phone: the line under Add SOL stays readable while the row is black');

  const stay = await now(p);
  await p.waitForTimeout(3000);
  r = await runs(p, stay);
  ok(r.every((row) => row.length === 0), `phone: once through, nothing more while the list stays (${describe(r, stay)})`);

  // Away to How it works and back: the walk starts over from 01.
  await finger.drag(-460);
  await p.waitForTimeout(80);
  await finger.drag(-460);
  await p.waitForTimeout(800);
  const back = await now(p);
  await finger.settleOnList();
  await p.waitForTimeout(STEP + 1200);
  r = await runs(p, back);
  ok(startedInOrder(r), `phone: brought back, it starts over from 01 (${describe(r, back)})`);

  // Taken away in the middle: everything goes back at once, nothing plays out of sight.
  await finger.drag(-460);
  await p.waitForTimeout(80);
  await finger.drag(-460);
  await p.waitForTimeout(300);
  const away = await now(p);
  await p.waitForTimeout(STEP + 500);
  const last = await p.evaluate(() => window.__quick.frames.at(-1).on);
  r = await runs(p, away);
  ok(last.every((on) => !on) && r.every((row) => row.length === 0), `phone: taken away mid-walk, every row goes back and stays (${describe(r, away)})`);
  await page.ctx.close();
}

// 2. Phones where the list is taller than the screen under the header.
for (const [width, height] of [[375, 667], [320, 568]]) {
  const page = await open({ viewport: { width, height }, isMobile: true, hasTouch: true });
  const { p } = page;
  const finger = touch(page);
  const from = await now(p);
  await finger.settleOnList();
  await p.waitForTimeout(2 * STEP + 1000);
  const r = await runs(p, from);
  ok(startedInOrder(r) && await mostAtOnce(p, from) === 1, `${width}x${height}: the walk starts at 01, one row at a time (${describe(r, from)})`);
  const mark = await settledMark(p, from);
  ok(!!mark && mark.overlap === 0 && mark.cut === 0, `${width}x${height}: the Solana mark sits after the words, whole (${JSON.stringify(mark)})`);
  await page.ctx.close();
}

// 3. A phone on its side gets the pinned story: Quick start is a step, not a place.
{
  const page = await open({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const { p } = page;
  let from = await now(p);
  await p.click('[data-nav-label="quick"]');
  await p.waitForTimeout(5 * STEP + 2000);
  let r = await runs(p, from);
  ok(walkedInOrder(r), `on its side: Quick start comes up and the rows play 01 to 05 (${describe(r, from)})`);
  ok(await mostAtOnce(p, from) === 1, 'on its side: one row at a time');
  const mark = await settledMark(p, from);
  ok(!!mark && mark.overlap === 0 && mark.cut === 0, `on its side: the Solana mark sits after the words, whole (${JSON.stringify(mark)})`);

  // Off to How it works in the middle of the walk, then back.
  await p.click('[data-nav-label="how"]');
  await p.waitForTimeout(2500);
  await p.click('[data-nav-label="quick"]');
  await p.waitForTimeout(STEP + 800);
  await p.click('[data-nav-label="how"]');
  await p.waitForTimeout(2500);
  const last = await p.evaluate(() => window.__quick.frames.at(-1).on);
  ok(last.every((on) => !on), `on its side: leaving Quick start mid-walk leaves no row on (${last})`);
  from = await now(p);
  await p.click('[data-nav-label="quick"]');
  await p.waitForTimeout(STEP + 1500);
  r = await runs(p, from);
  ok(startedInOrder(r), `on its side: coming back starts over from 01 (${describe(r, from)})`);
  await page.ctx.close();
}

// 4. Reduced motion: nothing plays by itself.
{
  const page = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const from = await now(page.p);
  await touch(page).settleOnList();
  await page.p.waitForTimeout(STEP + 1000);
  const r = await runs(page.p, from);
  ok(r.every((row) => row.length === 0), `reduced motion: no row plays by itself (${describe(r, from)})`);
  await page.ctx.close();
}

// 5. A mouse: nothing plays by itself, hover works as it did, and the mark sits
// after the words at every width, including 1024 to 1140 where it sat on SOL.
for (const [width, height] of [[1440, 900], [1140, 800], [1024, 768]]) {
  const { ctx, p } = await open({ viewport: { width, height } });
  await p.mouse.move(5, 5);
  let from = await now(p);
  await p.click('[data-nav-label="quick"]');
  await p.mouse.move(5, 5);
  await p.waitForTimeout(STEP + 500);
  let r = await runs(p, from);
  ok(r.every((row) => row.length === 0), `${width}px mouse: no row plays by itself (${describe(r, from)})`);

  if (width === 1440) {
    for (const i of [0, 2, 3, 4]) {
      const box = await p.locator('[data-qres-quick-item]').nth(i).boundingBox();
      from = await now(p);
      await p.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
      await p.waitForTimeout(900);
      await p.mouse.move(5, 5);
      await p.waitForTimeout(700);
      r = await runs(p, from);
      ok(r[i].length === 1 && r[i][0][1] !== null, `${width}px mouse: hover on ${NAMES[i]} shows it, leaving takes it off (${JSON.stringify(r[i])})`);
    }
  }

  // Add SOL under a held mouse keeps looping, as it always did.
  const box = await p.locator('[data-qres-sol-commit-row]').boundingBox();
  from = await now(p);
  await p.mouse.move(box.x + 40, box.y + box.height / 2);
  await p.waitForTimeout(4600);
  const late = await p.evaluate((after) => window.__quick.mark.some((m) => m.t > after), from + 3200);
  ok(late, `${width}px mouse: the Solana mark keeps looping while the mouse stays`);
  const mark = await settledMark(p, from);
  ok(!!mark && mark.overlap === 0 && mark.cut === 0, `${width}px mouse: the Solana mark sits after the words, whole (${JSON.stringify(mark)})`);
  ok(!!mark && mark.descLight === true, `${width}px mouse: the line under Add SOL stays readable while the row is black`);
  await ctx.close();
}

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'QUICK TOUCH ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
