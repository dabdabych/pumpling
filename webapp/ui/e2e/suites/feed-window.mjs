// The buys are shown in a window of their own, not as the tail of the page.
//
// A round buys for an hour in small batches, so the feed runs to a few hundred
// rows. Everything printed under it — the program id, the pool account, the
// link that proves the draw — used to sit below all of them, and reaching it
// meant scrolling past every buy.
//
// What this checks is the thing that broke: the page stops growing with the
// feed, and the feed still scrolls. The wheel is a real wheel, because setting
// scrollTop from a script passes whether or not a person could have done it.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, mockPurchases, purchaseFeed, MINTS } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** A feed of `count` buys, the length a real hour of buying produces. */
const feedOf = (count) => purchaseFeed({
  purchases: Array.from({ length: count }, (_, i) => ({
    mint: i % 2 ? MINTS.toad : MINTS.mochi,
    name: i % 2 ? 'Toad Signal' : 'Mochi',
    symbol: i % 2 ? 'TOAD' : 'MOCHI',
    logo_url: null,
    sol_amount: Number((0.4 + 0.15 * (i % 5)).toFixed(2)),
    signature: `windowsig${String(i).padStart(3, '0')}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    venue: i % 3 === 0 ? 'dex' : 'pumpfun',
    at: new Date(Date.now() - i * 95_000).toISOString()
  }))
});

/** The pool page mid-buying, with `count` buys already made. */
async function poolWithBuys(count, contextOptions) {
  const ctx = await b.newContext(contextOptions);
  // `mockCurrent` names the dev backend by its full address, so against a built
  // site the real one answers and the page shows whatever pool is live. The
  // feed is at its longest while the buying runs, which is the state this is
  // about, so it is pinned here whatever BASE points at.
  await ctx.route('**/lottery/current**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(SCENARIOS.buying())
  }));
  await mockCurrent(ctx, () => SCENARIOS.buying());
  await mockPurchases(ctx, () => feedOf(count));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForSelector('.buy-row', { timeout: 20000 });
  await p.waitForTimeout(800);
  return { ctx, p, errors };
}

// Falls back to the bare list, so a regression that loses the window reports
// every check rather than throwing on the first one.
const box = (p) => p.evaluate(() => {
  const node = document.querySelector('.buy-feed') || document.querySelector('.buy-list');
  if (!node) return null;
  return {
    framed: node.classList.contains('buy-feed'),
    height: Math.round(node.clientHeight),
    inner: Math.round(node.scrollHeight),
    top: Math.round(node.scrollTop),
    rows: document.querySelectorAll('.buy-row').length,
    page: document.documentElement.scrollHeight,
  };
});

// ------------------------------------------------------- desktop: a window
{
  const { ctx, p, errors } = await poolWithBuys(80, { viewport: { width: 1440, height: 900 } });
  const m = await box(p);

  ok(m !== null && m.framed, 'the feed has a window of its own');
  ok(m.rows === 80, `every buy is still there (${m.rows})`);
  ok(m.height <= 450, `the window is no taller than half the screen (${m.height}px of 900)`);
  ok(m.inner > m.height * 3, `and the buys go well past it (${m.inner}px inside a ${m.height}px window)`);

  // The point of the whole change: what is printed under the feed has to be
  // within reach. Eighty buys used to add about four and a half thousand pixels
  // to the page.
  const short = await poolWithBuys(4, { viewport: { width: 1440, height: 900 } });
  const shortPage = (await box(short.p)).page;
  // Four buys fit: no window to scroll, so no bar drawn beside them either.
  const shortBar = await short.p.locator('.buy-rail').count();
  ok(shortBar === 0, `a feed that fits gets no bar (${shortBar})`);
  const grew = m.page - shortPage;
  ok(grew < 260, `eighty buys instead of four barely lengthen the page (${grew}px)`);
  await short.ctx.close();

  // And the accounts under it are reachable without going through the rows.
  const proofTop = await p.evaluate(() => {
    const node = document.querySelector('.pool-proof');
    return node ? Math.round(node.getBoundingClientRect().top + window.scrollY) : null;
  });
  ok(proofTop !== null && proofTop < 2600, `the on-chain accounts are near the top of the page (${proofTop}px down)`);

  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// -------------------------------------------------- desktop: it does scroll
{
  const { ctx, p } = await poolWithBuys(80, { viewport: { width: 1440, height: 900 } });
  const frame = await p.locator('.buy-feed, .buy-list').first().boundingBox();
  await p.evaluate((y) => window.scrollTo(0, y), Math.max(0, Math.round(frame.y) - 200));
  await p.waitForTimeout(400);

  const hover = await p.locator('.buy-feed, .buy-list').first().boundingBox();
  await p.mouse.move(hover.x + hover.width / 2, hover.y + hover.height / 2);
  const pageBefore = await p.evaluate(() => Math.round(window.scrollY));

  await p.mouse.wheel(0, 200);
  await p.waitForTimeout(500);
  const m = await box(p);
  const pageAfter = await p.evaluate(() => Math.round(window.scrollY));

  ok(m.top > 100, `the wheel moves the buys inside the window (top ${m.top})`);
  const thumb = await p.evaluate(() => {
    const node = document.querySelector('.buy-rail__thumb');
    const rail = document.querySelector('.buy-rail');
    if (!node || !rail) return null;
    const a = node.getBoundingClientRect();
    const b = rail.getBoundingClientRect();
    return { top: Math.round(a.top - b.top), height: Math.round(a.height), rail: Math.round(b.height) };
  });
  ok(thumb !== null, 'the window has a bar of its own to show where it is');
  ok(thumb && thumb.top > 5, `and the bar moved with the buys (${thumb?.top}px down its rail)`);
  ok(thumb && thumb.height < thumb.rail * 0.5, `the bar is as short as the window is deep (${thumb?.height} of ${thumb?.rail})`);
  ok(Math.abs(pageAfter - pageBefore) < 20, `and leaves the page where it was (${pageBefore} -> ${pageAfter})`);

  // Dragging the bar is how a scrollbar is expected to work, and ours is drawn
  // rather than the browser's, so nothing gives us that for free.
  const rail = await p.locator('.buy-rail').boundingBox().catch(() => null);
  const grip = await p.locator('.buy-rail__thumb').boundingBox().catch(() => null);
  if (rail && grip) {
    const before = (await box(p)).top;
    await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await p.mouse.down();
    await p.mouse.move(grip.x + grip.width / 2, rail.y + rail.height - 10, { steps: 8 });
    await p.mouse.up();
    await p.waitForTimeout(400);
    const after = (await box(p)).top;
    ok(after > before + 500, `dragging the bar runs down the buys (${before} -> ${after})`);
  } else {
    ok(false, 'dragging the bar runs down the buys (no bar to drag)');
  }

  // Reachable without a mouse: the window takes focus and the keyboard moves it.
  // Back to the newest buy first, or the drag above would have satisfied this
  // on its own.
  await p.mouse.move(hover.x + hover.width / 2, hover.y + hover.height / 2);
  await p.mouse.wheel(0, -8000);
  await p.waitForTimeout(500);
  const back = (await box(p)).top;
  ok(back < 50, `the wheel comes back to the newest buy (${back})`);

  await p.evaluate(() => (document.querySelector('.buy-feed') || document.querySelector('.buy-list')).focus());
  const focused = await p.evaluate(() => document.activeElement?.className ?? '');
  ok(focused.includes('buy-feed'), `the window takes keyboard focus (${focused || 'nothing'})`);
  await p.keyboard.press('End');
  await p.waitForTimeout(500);
  const end = await box(p);
  ok(end.top > back + 500, `the keyboard reaches the oldest buys (${back} -> ${end.top})`);

  await ctx.close();
}

// ---------------------------------------------------------------- on a phone
{
  const { ctx, p, errors } = await poolWithBuys(80, {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3
  });
  const m = await box(p);

  ok(m.height <= 430, `phone: the window leaves room for the page (${m.height}px of 844)`);
  ok(m.inner > m.height * 3, `phone: and the buys go past it (${m.inner}px)`);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow === 0, `phone: no horizontal scroll (${overflow})`);
  ok(errors.length === 0, `phone: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'FEED WINDOW ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
