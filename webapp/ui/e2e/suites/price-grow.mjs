// Slide 2: is the price visibly growing. We measure the tip of the line over time.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
const BASE = process.env.BASE || 'http://localhost:3200';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto(BASE + '/#how', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => { try { return !!ng.getComponent(document.querySelector('app-main-page')).storyTimeline; } catch { return false; } }, null, { timeout: 90000 });
await p.waitForTimeout(1200);
await p.evaluate(() => ng.getComponent(document.querySelector('app-main-page')).goToSection('step2'));
await p.waitForTimeout(1500);
const found = await p.evaluate(() => {
  const svg = document.querySelector('.spark__chart');
  const scene = svg?.closest('[data-how-scene]');
  return !!scene && Number(getComputedStyle(scene).opacity) > 0.9;
});
ok(found, 'we reached the price card');

const sample = () => p.evaluate(() => {
  const svg = document.querySelector('.spark__chart');
  const line = svg.querySelector('[data-how-spark]');
  const dot = svg.querySelector('.spark__dot');
  const area = svg.querySelector('.spark__area');
  const vb = svg.getAttribute('viewBox');
  const r = { width: svg.clientWidth, height: svg.clientHeight };
  const dr = dot.getBoundingClientRect();
  return {
    vb, w: Math.round(r.width), h: Math.round(r.height),
    d: line.getAttribute('d').slice(0, 24),
    dx: Number(dot.getAttribute('cx')), dy: Number(dot.getAttribute('cy')),
    dotW: Math.round(dr.width), dotH: Math.round(dr.height),
    areaLen: (area.getAttribute('d') || '').length,
    price: document.querySelector('.spark__price')?.textContent ?? ''
  };
});

const shots = [];
const first = await sample();
shots.push(first);
for (let i = 0; i < 16; i++) { await p.waitForTimeout(900); shots.push(await sample()); }

ok(first.vb === `0 0 ${first.w} ${first.h}`, `the viewBox matches the frame size (${first.vb} at ${first.w}x${first.h})`);
ok(Math.abs(first.dotW - first.dotH) <= 1, `the dot is round rather than an oval (${first.dotW}x${first.dotH})`);

const tops = shots.map((s) => s.h - s.dy);
console.log('the height of the line tip:', tops.map((t) => t.toFixed(0)).join(' '));
console.log('the tip horizontally:', shots.map((s) => s.dx.toFixed(0)).join(' '));
console.log('price:', shots.map((s) => s.price).join(' '));
// We compare with the maximum rather than the last sample: the price now has
// visible pullbacks and the last frame can land exactly on a dip.
ok(Math.max(...tops) - tops[0] > first.h * 0.3, `the line rose within the frame (${tops[0].toFixed(0)} → ${Math.max(...tops).toFixed(0)} of ${first.h})`);
ok(shots[shots.length - 1].dx > shots[0].dx + 40, `the line reached to the right (${shots[0].dx.toFixed(0)} → ${shots[shots.length - 1].dx.toFixed(0)})`);
ok(shots.every((s) => s.areaLen > 40), 'the fill under the line is drawn');
const prices = shots.map((s) => Number(s.price.replace('$', '')));
ok(prices[prices.length - 1] > prices[0] * 1.15, `the price number grew (${shots[0].price} → ${shots[shots.length - 1].price})`);

// the price digit must not flicker: we count text changes over three seconds
const blink = await p.evaluate(() => new Promise((done) => {
  const node = document.querySelector('.spark__price');
  let changes = 0;
  let last = node.textContent;
  const t0 = performance.now();
  const tick = () => {
    if (node.textContent !== last) { changes++; last = node.textContent; }
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else done(changes);
  };
  tick();
}));
ok(blink <= 12, `the price digit changes ${blink} times in three seconds rather than every frame`);
ok(blink >= 4, `the price digit is alive (${blink} changes in three seconds)`);

// the line must not lie on the edge of the frame, top or bottom
const edges = await p.evaluate(() => new Promise((done) => {
  const svg = document.querySelector('.spark__chart');
  const dot = svg.querySelector('.spark__dot');
  const h = svg.clientHeight;
  const seen = [];
  const t0 = performance.now();
  const tick = () => {
    seen.push(Number(dot.getAttribute('cy')) / h);
    if (performance.now() - t0 < 12000) requestAnimationFrame(tick); else done({ top: Math.min(...seen), bottom: Math.max(...seen) });
  };
  tick();
}));
ok(edges.top > 0.03 && edges.bottom < 0.97, `the line does not stick to the frame edges (${edges.top.toFixed(2)}..${edges.bottom.toFixed(2)})`);

// smoothness: we take consecutive frames and look at the step of the line tip
const fine = [];
for (let i = 0; i < 24; i++) { await p.waitForTimeout(50); const s = await sample(); fine.push({ x: s.dx, y: s.dy }); }
const jumps = fine.slice(1).map((f, i) => Math.hypot(f.x - fine[i].x, f.y - fine[i].y));
ok(Math.max(...jumps) < 6, `no jerks, at most ${Math.max(...jumps).toFixed(2)}px per 50ms`);

if (S) {
  const box = await p.locator('.pcard').first().boundingBox();
  await p.screenshot({ path: `${S}/pw/shots/price.png`, clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
  execSync(`sips -s format jpeg -s formatOptions 82 -Z 900 ${S}/pw/shots/price.png --out ${S}/pw/shots/price.jpg >/dev/null && rm ${S}/pw/shots/price.png`);
}
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'PRICE ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
