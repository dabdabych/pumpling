// The coin chart on hover: what it shows and how often it asks the server.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { SCENARIOS, mockCurrent, MINTS, entries, summary, five } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const now = Math.floor(Date.now() / 1000);

const chartBody = (over = {}) => ({
  mint: MINTS.mochi,
  available: true,
  minutes: 24,
  venue: 'raydium',
  price_usd: 0.0000412,
  change_pct: 12.4,
  points: Array.from({ length: 25 }, (_, i) => ({ t: now - (24 - i) * 60, p: 0.00004 * (1 + Math.sin(i / 3) * 0.06 + i * 0.008) })),
  ...over
});

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await mockCurrent(ctx, () => SCENARIOS.open());
let chartCalls = 0;
let body = chartBody();
await ctx.route('**/lottery/coin/*/chart', (route) => {
  chartCalls++;
  route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
});
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });

// we bring the row to the middle of the screen so the tooltip has room
await p.evaluate(() => document.querySelector('.coin-row').scrollIntoView({ block: 'center' }));
await p.waitForTimeout(300);
const box = await p.locator('.coin-row').first().boundingBox();
await p.mouse.move(box.x + 220, box.y + box.height / 2);
await p.waitForSelector('.coin-chart__line', { timeout: 8000 });
await p.waitForTimeout(350);

const tip = await p.evaluate(() => {
  const node = document.querySelector('.coin-chart');
  const rect = node.getBoundingClientRect();
  return {
    text: node.textContent.replace(/\s+/g, ' ').trim(),
    path: node.querySelector('path')?.getAttribute('d') ?? '',
    onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight
  };
});
ok(/\$MOCHI/.test(tip.text) && /\$0\.000041/.test(tip.text), `the hover card shows the coin and its price (${tip.text})`);
ok(/last 24 min/.test(tip.text) && /raydium/.test(tip.text), 'it says how far back the chart goes and where the coin trades');
ok(tip.path.startsWith('M') && tip.path.includes('C'), 'the chart is a smooth line');
ok(tip.onScreen, 'the card stays inside the window');
if (S) {
  await p.screenshot({ path: `${S}/pw/shots/coin-hover.png`, clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 20), width: 920, height: 280 } });
  execSync(`sips -s format jpeg -s formatOptions 85 -Z 900 ${S}/pw/shots/coin-hover.png --out ${S}/pw/shots/coin-hover.jpg >/dev/null && rm ${S}/pw/shots/coin-hover.png`);
}

// a second pass over the same coin does not bother the server
await p.mouse.move(10, 10);
await p.waitForTimeout(300);
const callsAfterFirst = chartCalls;
await p.mouse.move(box.x + 220, box.y + box.height / 2);
await p.waitForTimeout(700);
ok(chartCalls === callsAfterFirst, `hovering the same coin again does not ask the server (${chartCalls} calls)`);

// running the mouse down the list must not fire request after request
await p.mouse.move(10, 10);
await p.waitForTimeout(200);
const before = chartCalls;
for (const row of [1, 2, 3, 4]) {
  const rowBox = await p.locator('.coin-row').nth(row).boundingBox();
  await p.mouse.move(rowBox.x + 220, rowBox.y + rowBox.height / 2);
  await p.waitForTimeout(60);
}
await p.mouse.move(10, 10);
await p.waitForTimeout(600);
ok(chartCalls - before <= 1, `a quick pass over the list asks at most once (${chartCalls - before})`);

// a coin with no chart: an honest caption rather than an empty card
body = chartBody({ available: false, points: [], minutes: 0 });
const lastRow = await p.locator('.coin-row').last().boundingBox();
await p.mouse.move(lastRow.x + 220, lastRow.y + lastRow.height / 2);
await p.waitForTimeout(900);
const emptyText = await p.locator('.coin-chart').innerText().catch(() => '');
ok(/No chart yet/i.test(emptyText), `a coin without a chart says so (${emptyText.replace(/\s+/g, ' ')})`);

// phone: there is no tooltip at all
const phone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await mockCurrent(phone, () => SCENARIOS.open());
let phoneCalls = 0;
await phone.route('**/lottery/coin/*/chart', (route) => { phoneCalls++; route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(chartBody()) }); });
const p2 = await phone.newPage();
await p2.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
await p2.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p2.locator('.coin-row').first().tap();
await p2.waitForTimeout(800);
ok(await p2.locator('.coin-chart').count() === 0 && phoneCalls === 0, `phone: no hover card and no requests (${phoneCalls})`);
await phone.close();

// The tooltip must not run past its frame. We check the nasty case: a
// fifteen-letter ticker, a price with eight zeros after the point and a sawtooth
// instead of a chart — at that price Catmull-Rom threw the curve past the edge.
const hostilePool = () => ({
  entries: entries([['mochi', 30.5, 4, 'Mochi Very Long Coin Name', 'MOCHIMOCHIMOCHI'], ...five.slice(1)]),
  has_active_lottery: true,
  active_lotteries: [summary({})],
  latest_lotteries: [summary({})],
  hype_countdowns: []
});
// A step rather than a sawtooth: that is what throws the spline's control points
// past the edge. On a sawtooth the neighbours are equal, the tangent is zero and
// there is no overshoot at all.
const spikeChart = chartBody({
  price_usd: 0.000000012345678,
  change_pct: -99.94,
  points: Array.from({ length: 25 }, (_, i) => ({ t: now - (24 - i) * 60, p: i < 12 ? 0.0000000123 : 0.0000000999 }))
});

for (const width of [1024, 1280, 1440, 1920]) {
  const wideCtx = await b.newContext({ viewport: { width, height: 900 } });
  await mockCurrent(wideCtx, hostilePool);
  await wideCtx.route('**/lottery/coin/*/chart', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(spikeChart)
  }));
  const pw = await wideCtx.newPage();
  pw.on('pageerror', (e) => errors.push(`${width}px: ${e.message}`));
  await pw.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pw.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await pw.evaluate(() => document.querySelector('.coin-row').scrollIntoView({ block: 'center' }));
  await pw.waitForTimeout(250);
  // Under load a hover does not fire on the first attempt: if there is no
  // tooltip we move the mouse away and hover again rather than failing the suite.
  const hover = async () => {
    const rowBox = await pw.locator('.coin-row').first().boundingBox();
    await pw.mouse.move(10, 10);
    await pw.waitForTimeout(120);
    await pw.mouse.move(rowBox.x + Math.min(220, rowBox.width / 3), rowBox.y + rowBox.height / 2);
    return pw.waitForSelector('.coin-chart__line', { timeout: 10000 }).then(() => true, () => false);
  };
  if (!(await hover()) && !(await hover())) {
    ok(false, `${width}px: the hover card never showed up`);
    await wideCtx.close();
    continue;
  }
  await pw.waitForTimeout(300);

  const fit = await pw.evaluate(() => {
    const card = document.querySelector('.coin-chart');
    const rect = card.getBoundingClientRect();
    const svg = card.querySelector('svg');
    const path = card.querySelector('path');
    const view = svg.viewBox.baseVal;
    const bbox = path.getBBox();
    // The curve is defined by both the anchor and the control points: the
    // overshoot shows in those, while getBBox rounds at the boundary and can
    // swallow it.
    const ys = (path.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g)?.filter((_, i) => i % 2 === 1).map(Number) ?? [];
    const worst = ys.length ? Math.max(...ys.map((y) => Math.max(view.y - y, y - (view.y + view.height)))) : 0;
    const spill = [];
    for (const child of card.children) {
      const r = child.getBoundingClientRect();
      if (r.right > rect.right + 1 || r.left < rect.left - 1) {
        spill.push(`${child.className}: ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      }
    }
    return {
      spill,
      scrolls: card.scrollWidth > card.clientWidth + 1,
      inWindow: rect.left >= 0 && rect.right <= window.innerWidth,
      curveInside: bbox.y >= view.y - 0.01 && bbox.y + bbox.height <= view.y + view.height + 0.01,
      worst: Math.round(worst * 100) / 100
    };
  });

  ok(fit.spill.length === 0, `${width}px: nothing sticks out of the hover card (${fit.spill.join('; ') || 'clean'})`);
  ok(!fit.scrolls, `${width}px: the card does not scroll sideways`);
  ok(fit.inWindow, `${width}px: the card stays inside the window`);
  ok(fit.curveInside && fit.worst <= 0.01, `${width}px: the curve stays inside its box (overshoot ${fit.worst})`);
  if (S && width === 1440) {
    const cardBox = await pw.locator('.coin-chart').boundingBox();
    await pw.screenshot({ path: `${S}/pw/shots/coin-hover-long.png`, clip: { x: Math.max(0, cardBox.x - 20), y: Math.max(0, cardBox.y - 60), width: 560, height: 260 } });
    execSync(`sips -s format jpeg -s formatOptions 85 -Z 900 ${S}/pw/shots/coin-hover-long.png --out ${S}/pw/shots/coin-hover-long.jpg >/dev/null && rm ${S}/pw/shots/coin-hover-long.png`);
  }
  await wideCtx.close();
}

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'COIN HOVER ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
