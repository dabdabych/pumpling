// Reduced motion: the scene stays quiet, but the card has to be filled in.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto('http://localhost:3200/#how', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
await p.waitForTimeout(1500);
await p.evaluate(() => document.querySelector('[data-how-scene="2"]')?.scrollIntoView({ block: 'center' }));
await p.waitForTimeout(1200);
const read = () => p.evaluate(() => {
  const svg = document.querySelector('[data-how-scene="2"] .spark__chart');
  const dot = svg.querySelector('.spark__dot');
  return { w: svg.clientWidth, h: svg.clientHeight, vb: svg.getAttribute('viewBox'), x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')), d: (svg.querySelector('[data-how-spark]').getAttribute('d') || '').length, price: document.querySelector('[data-how-scene="2"] .spark__price').textContent };
});
const a = await read();
await p.waitForTimeout(2500);
const c = await read();
ok(a.d > 80 && a.x > a.w * 0.8, `the card is drawn in full (the tip at ${a.x.toFixed(0)} of ${a.w})`);
ok(a.y > 0 && a.y < a.h, `the dot is inside the frame (${a.y.toFixed(0)} of ${a.h})`);
ok(a.vb === `0 0 ${a.w} ${a.h}`, `the viewBox matches the frame (${a.vb})`);
ok(JSON.stringify(a) === JSON.stringify(c), 'nothing moves');
console.log('price', a.price);
if (S) {
  const box = await p.locator('[data-how-scene="2"] .spark').boundingBox();
  await p.screenshot({ path: `${S}/pw/shots/price-reduced.png`, clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 } });
  execSync(`sips -s format jpeg -s formatOptions 82 -Z 800 ${S}/pw/shots/price-reduced.png --out ${S}/pw/shots/price-reduced.jpg >/dev/null && rm ${S}/pw/shots/price-reduced.png`);
}
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'REDUCED ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
