// The coin window, opened from a bubble on the main page (coin-story-dialog).
//
// Asked for on 2026-10-16: the coin's chart from when it came into a pool to
// when the pool had bought it, for the pool where the most SOL stood behind
// it, with its ticker, picture, mint and when it took part. The fixture is the
// launch pool of 2026-10-04: its 46 real buys and GeckoTerminal's real candles.
//
// What this checks: the facts and the mint (copied whole); the chart drawn,
// with the chart library loaded only when a window opens; GeckoTerminal named
// and linked; trading the coin and the pool in the archive as the ways on;
// Escape closing it with focus back on the bubble; the windows that have no
// chart, a running pool, a buyer that did not answer, and a failed answer
// with its retry; and at every window size, the window inside the screen.
import { launch, BASE } from '../lib/browser.mjs';
import { FEED_SIZES } from '../lib/feed-layout.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { BACKED, mockBubbles, mockChat, mockStory } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const MINT = BACKED[0].mint;

async function open(viewport = { width: 1440, height: 900 }, mode = 'ok') {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await mockCard(ctx, 'openEmpty');
  await mockBubbles(ctx);
  await mockChat(ctx);
  await mockStory(ctx, mode);
  await ctx.route('**/lottery/archive**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ lottery_type: 'dex', window_days: 30, items: [] }) }));
  await ctx.addInitScript(() => { window.__events = []; window.gtag = (...args) => { if (args[0] === 'event') window.__events.push({ name: args[1], ...args[2] }); }; });
  const p = await ctx.newPage();
  const errors = [];
  const chunks = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => { if (/lightweight-charts/.test(r.url())) chunks.push(r.url()); });
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.bub__item', { timeout: 20000 });
  await p.waitForTimeout(1200);
  return { ctx, p, errors, chunks };
}

/** Press the first (biggest) bubble at its centre: they float, which Playwright reads as not stable. */
async function pressBubble(p) {
  // On a phone the card is below the first screen: bring it up as a person would.
  await p.locator('.bub').first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: 'center' });
  });
  await p.waitForTimeout(400);
  const box = await p.locator('.bub__link').first().boundingBox();
  // A phone is pressed with a finger: a tap, not a click.
  if (p.viewportSize().width < 500) await p.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForSelector('mat-dialog-container .story', { timeout: 10000 });
}
const text = (p, sel) => p.locator(sel).first().evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);

// ------------------------------------------------------------ what is in it
{
  const { ctx, p, errors, chunks } = await open();
  ok(chunks.length === 0, 'the chart library is not loaded with the page');
  await pressBubble(p);
  await p.waitForSelector('.story__canvas canvas', { timeout: 15000 });
  ok(chunks.length > 0, `it is loaded when a window opens (${chunks.length} request)`);

  ok(await text(p, '.story__title') === '$PUMPLING' && await text(p, '.story__name') === 'pumpling', 'the ticker and the name');
  const facts = await p.$$eval('.story__facts div', (els) => els.map((el) => [...el.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' ')));
  ok(facts[0] === 'In pumpling Oct 4, 19:01 → 20:34 UTC · Pool #1791138900542', `when it took part, and in which pool (${facts[0]})`);
  ok(facts[1] === 'Behind it 20.05 SOL', `how much stood behind it (${facts[1]})`);
  ok(facts[2] === 'Bought by the pool 46 public buys · 19.68 SOL', `what the pool bought of it (${facts[2]})`);

  const address = await p.locator('.story__address').getAttribute('title');
  const shown = await p.locator('.story__address').evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim());
  ok(address === MINT && shown === `${MINT.slice(0, 6)}…${MINT.slice(-6)}`, `the mint, short on screen and whole underneath (${shown})`);
  await p.locator('.story__copy').click();
  await p.waitForTimeout(200);
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  ok(clip === MINT && (await text(p, '.story__copy')) === 'Copied', `Copy mint copies it whole, and says so (${clip.slice(0, 8)}…)`);

  const canvas = await p.locator('.story__canvas').evaluate((el) => {
    const c = el.querySelector('canvas'); const r = el.getBoundingClientRect();
    return { canvases: el.querySelectorAll('canvas').length, w: Math.round(r.width), h: Math.round(r.height), label: el.getAttribute('aria-label') };
  });
  ok(canvas.canvases > 0 && canvas.w > 500 && canvas.h >= 280, `the chart is drawn (${canvas.w}x${canvas.h})`);
  ok(/^Price of \$PUMPLING in SOL over its stay, from 0\.0₇\d+ to 0\.0₆\d+, with 46 buys by the pool marked\.$/.test(canvas.label ?? ''), `and a screen reader is told what it shows ("${canvas.label}")`);
  const caption = await text(p, '.story__caption span:last-child');
  ok(/^Price in SOL, a candle a minute · Source: GeckoTerminal$/.test(caption ?? ''), `a final chart says no "updated" (${caption})`);
  const source = await p.locator('.story__caption a');
  const key = await text(p, '.story__caption span');
  ok(key === 'a buy by the pool came into the pool', `the key names the buys and the dot, both on this chart (${key})`);
  ok(await source.textContent() === 'GeckoTerminal' && (await source.getAttribute('href')).startsWith('https://www.geckoterminal.com/solana/pools/') && await source.getAttribute('target') === '_blank', 'GeckoTerminal is named under the chart and linked to the pool');

  const trade = p.locator('.story__trade');
  ok(await trade.getAttribute('href') === `https://pump.fun/coin/${MINT}` && await trade.getAttribute('target') === '_blank' && /noopener/.test(await trade.getAttribute('rel')), 'Trade on pump.fun opens the coin there, in a new tab without an opener');
  await ctx.route('https://pump.fun/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>pump</title>' }));
  const [tab] = await Promise.all([ctx.waitForEvent('page'), trade.click()]);
  await tab.close();
  const ev = (await p.evaluate(() => window.__events)).find((e) => e.name === 'coin_story_trade_click');
  ok(ev?.venue === 'pump.fun', `the press is counted (${JSON.stringify(ev)})`);

  await p.keyboard.press('Escape');
  await p.waitForSelector('mat-dialog-container', { state: 'detached', timeout: 5000 }).catch(() => {});
  const focus = await p.evaluate(() => document.activeElement?.classList.contains('bub__link'));
  ok(await p.locator('mat-dialog-container').count() === 0 && focus, 'Escape closes it, and focus is back on the bubble');

  await pressBubble(p);
  await p.locator('.story__archive').click();
  await p.waitForURL(/\/archive\?pool=1791138900542/, { timeout: 10000 });
  await p.waitForTimeout(400);
  ok(await p.locator('mat-dialog-container .story').count() === 0, 'See pool # opens that pool in the archive and closes the window');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ the windows with no chart, or no end yet
for (const [mode, want] of [
  ['busy', /GeckoTerminal is busy right now\. Trying again in a few seconds/],
  ['none', /has no chart for this coin over its stay yet/],
  ['failed', /could not be fetched just now/]
]) {
  const { ctx, p, errors } = await open(undefined, mode);
  await pressBubble(p);
  await p.waitForTimeout(600);
  const said = await text(p, '.story__empty');
  ok(want.test(said ?? '') && await p.locator('.story__canvas').count() === 0, `${mode}: said in words, no empty chart (${said})`);
  ok(await p.locator('.story__trade').count() === 1, `${mode}: the coin can still be traded from it`);
  ok(errors.length === 0, `${mode}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}
{
  // A coin just in: the server fetches its chart within a minute or so, and the window waits for it.
  const { ctx, p } = await open(undefined, 'pending');
  await pressBubble(p);
  await p.waitForSelector('.story__empty', { timeout: 8000 });
  const said = await text(p, '.story__empty');
  ok(/^Its chart is on its way: it shows up here in a minute or so\.$/.test(said ?? ''), `pending: said as on its way (${said})`);
  await ctx.unroute('**/lottery/coins/*/story');
  await mockStory(ctx, 'ok');
  const drawn = await p.waitForSelector('.story__canvas canvas', { timeout: 30000 }).then(() => true, () => false);
  ok(drawn, 'pending: the chart comes by itself once the server has it, no press needed');
  await ctx.close();
}
{
  // Busy is usually gone in seconds (about ten calls a minute): the window asks again by itself.
  const { ctx, p } = await open(undefined, 'busy');
  await pressBubble(p);
  await p.waitForSelector('.story__empty', { timeout: 8000 });
  await ctx.unroute('**/lottery/coins/*/story');
  await mockStory(ctx, 'ok');
  const drawn = await p.waitForSelector('.story__canvas canvas', { timeout: 30000 }).then(() => true, () => false);
  ok(drawn, 'busy: the chart comes by itself once GeckoTerminal answers, no press needed');
  await ctx.close();
}
{
  const { ctx, p } = await open(undefined, 'running');
  await pressBubble(p);
  await p.waitForSelector('.story__canvas canvas', { timeout: 15000 }).catch(() => {});
  const facts = await p.$$eval('.story__facts dd', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  ok(/→ now · Pool #/.test(facts[0]) && facts[2] === 'The buys start when the pool closes', `a pool still taking SOL runs to now, and says when the buys come (${facts[0]} / ${facts[2]})`);
  ok(await p.locator('.story__archive').count() === 0, 'and has no archive link yet');
  const caption = await text(p, '.story__caption span:last-child');
  ok(/a candle a minute, updated 3 min ago · Source: GeckoTerminal/.test(caption ?? ''), `a chart still being refreshed says how old it is (${caption})`);
  await ctx.close();
}
{
  // On the stand a finished pool with no buys of the coin read "Oct 2 → Oct 18", two weeks for two hours.
  const { ctx, p } = await open(undefined, 'nobuys');
  await pressBubble(p);
  await p.waitForTimeout(600);
  const facts = await p.$$eval('.story__facts dd', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  ok(/^Oct 4, 19:01 → 20:40 UTC · Pool #/.test(facts[0]) && facts[2] === 'Nothing: the draw gave it no share', `a finished pool that bought none of it ends at its close (${facts[0]} / ${facts[2]})`);
  await ctx.close();
}
{
  // LETTER on the stand: a 15 SOL share the buyer could not buy, sent back. It read "the draw gave it no share".
  const { ctx, p } = await open(undefined, 'refunded');
  await pressBubble(p);
  await p.waitForTimeout(600);
  const bought = await p.$$eval('.story__facts dd', (els) => els[2]?.textContent.replace(/\s+/g, ' ').trim());
  ok(bought === 'None. Its 15.02 SOL share went back to its backers', `a share not bought and sent back is said so, never "no share" (${bought})`);
  await p.waitForSelector('.story__canvas canvas', { timeout: 15000 });
  const key = await text(p, '.story__caption span');
  ok(key === 'came into the pool', `with no buys, the key does not name buys (${key})`);
  await ctx.close();
}
{
  const { ctx, p } = await open(undefined, 'unknown');
  await pressBubble(p);
  await p.waitForTimeout(600);
  const bought = await p.$$eval('.story__facts dd', (els) => els[2]?.textContent.trim());
  ok(bought === 'Not known right now', `a buyer that did not answer is "not known", never "nothing" (${bought})`);
  await ctx.close();
}
{
  const { ctx, p, errors } = await open(undefined, 'fail');
  await pressBubble(p);
  await p.waitForSelector('.story__retry', { timeout: 8000 });
  ok(/could not be loaded/.test(await text(p, '.story__state') ?? ''), 'a failed answer is said, with a way to try again');
  ok(await text(p, '.story__title') === '$PUMPLING' && await p.locator('.story__trade').count() === 1, 'the ticker and the way to trade are there anyway');
  await ctx.unroute('**/lottery/coins/*/story');
  await mockStory(ctx, 'ok');
  await p.locator('.story__retry').click();
  const drawn = await p.waitForSelector('.story__canvas canvas', { timeout: 15000 }).then(() => true, () => false);
  ok(drawn, 'Try again brings the chart once the answer comes');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ the chart never takes the window's scroll
// Lightweight Charts takes a vertical swipe and the wheel for itself by default
// (`vertTouchDrag`, `mouseWheel`): a swipe that began on the chart, 300px of a
// 568px phone, did not move the sheet, and the wheel zoomed the chart instead
// of moving a window taller than the screen.
{
  const { ctx, p } = await open({ width: 320, height: 568 });
  await pressBubble(p);
  await p.waitForSelector('.story__canvas canvas', { timeout: 15000 });
  await p.waitForTimeout(600);
  const before = await p.locator('.story').evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  const chart = await p.locator('.story__canvas').boundingBox();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(chart.x + chart.width / 2), y: Math.round(chart.y + chart.height * 0.7),
    yDistance: -160, gestureSourceType: 'touch', speed: 800
  });
  await p.waitForTimeout(700);
  const after = await p.locator('.story').evaluate((el) => el.scrollTop);
  ok(before.room > 40 && after > before.top + 40, `on a phone, a swipe up that starts on the chart moves the sheet (${before.top} → ${after} of ${before.room})`);
  await ctx.close();
}
{
  const { ctx, p } = await open({ width: 1024, height: 600 });
  await pressBubble(p);
  await p.waitForSelector('.story__canvas canvas', { timeout: 15000 });
  await p.waitForTimeout(600);
  const before = await p.locator('.story').evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  const chart = await p.locator('.story__canvas').boundingBox();
  await p.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2);
  await p.mouse.wheel(0, 200);
  await p.waitForTimeout(600);
  const after = await p.locator('.story').evaluate((el) => el.scrollTop);
  ok(before.room > 40 && after > before.top + 40, `in a short window, the wheel over the chart moves the window (${before.top} → ${after} of ${before.room})`);
  await ctx.close();
}

// ------------------------------------------------------------ at every window: inside the screen
const problems = [];
for (const [width, height] of [...FEED_SIZES, [1024, 600]]) {
  const { ctx, p, errors } = await open({ width, height });
  try { await pressBubble(p); } catch { problems.push(`${width}x${height}: the bubble did not open a window`); await ctx.close(); continue; }
  await p.waitForSelector('.story__canvas canvas', { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(500);
  const found = await p.evaluate(() => {
    const issues = [];
    const card = document.querySelector('.story').getBoundingClientRect();
    if (card.left < -0.5 || card.right > innerWidth + 0.5) issues.push(`the window is ${Math.round(card.left)}..${Math.round(card.right)} on a ${innerWidth}px screen`);
    if (card.top < -0.5 || card.bottom > innerHeight + 0.5) issues.push(`the window runs off the screen (${Math.round(card.top)}..${Math.round(card.bottom)} of ${innerHeight})`);
    const story = document.querySelector('.story');
    if (story.scrollWidth > story.clientWidth + 1) issues.push(`it scrolls sideways by ${story.scrollWidth - story.clientWidth}px`);
    for (const el of story.querySelectorAll('.story__head, .story__mint, .story__facts, .story__canvas, .story__caption, .story__actions')) {
      const r = el.getBoundingClientRect();
      if (r.right > card.right + 0.5 || r.left < card.left - 0.5) issues.push(`${el.className} sticks out`);
    }
    const facts = [...story.querySelectorAll('.story__facts > div')].map((el) => el.getBoundingClientRect());
    for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]; const c = facts[j];
      if (Math.min(a.right, c.right) - Math.max(a.left, c.left) > 1 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 1) issues.push('two facts lie on each other');
    }
    const trade = story.querySelector('.story__trade').getBoundingClientRect();
    if (trade.height < 44) issues.push(`the trade button is ${Math.round(trade.height)}px high`);
    return issues;
  });
  if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
  if (found.length) problems.push(`${width}x${height}: ${found.slice(0, 3).join('; ')}`);
  await ctx.close();
}
ok(problems.length === 0, `the window sits inside the screen at every size, 320px to 2560px (${problems.length} with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

console.log(fails ? `${fails} FAILED` : 'COIN STORY ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
