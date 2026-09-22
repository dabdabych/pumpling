// The coins on the Commit SOL card, on a reload and on a resize.
//
// Reported as "the coins flicker hard and only then settle". They were not
// flickering, they were starting over. The first screen is pinned, ScrollTrigger
// wraps a pinned element in a spacer, and every refresh rebuilds that pin and
// moves the screen in the DOM. A move restarts every CSS animation inside it.
//
// `settleStory` refreshes in a loop until five readings agree, so on a reload
// that is six or more moves in about six hundred milliseconds, against a 780ms
// entrance. Traced on 2026-09-22: the first coin reached opacity 0.22, dropped
// to 0, and did that five times before it was left alone.
//
// Two halves, and each catches its own half of the fix: the entrance now waits
// while the measuring runs, and it writes down its end state when it finishes
// so later refreshes have nothing to replay.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const ctx = await b.newContext({ viewport: { width: 1512, height: 860 } });
await mockCurrent(ctx, () => SCENARIOS.open());
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));

// Sample every frame from before the app paints, so the whole load is covered.
await p.addInitScript(() => {
  window.__coins = [];
  const tick = () => {
    const shells = document.querySelectorAll('.dex-card-animation__shell');
    if (shells.length) {
      window.__coins.push(Array.from(shells, (s) => +(+getComputedStyle(s).opacity).toFixed(2)));
    }
    if (performance.now() < 12000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

for (let attempt = 0; attempt < 3; attempt++) {
  try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
  catch (e) { if (attempt === 2) throw e; }
}
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p.waitForTimeout(8000);

const frames = await p.evaluate(() => window.__coins);
ok(frames.length > 60, `the load was sampled (${frames.length} frames)`);

// A coin fades in and stays. Going backwards means it started over, and the
// eye reads a run of those as flickering. A small tolerance so a rounding
// wobble at the top of the fade does not count as a reset.
const resets = [];
for (let coin = 0; coin < (frames[frames.length - 1] || []).length; coin++) {
  let peak = 0;
  for (let i = 0; i < frames.length; i++) {
    const value = frames[i][coin];
    if (value === undefined) continue;
    if (value + 0.05 < peak) { resets.push({ coin, frame: i, from: peak, to: value }); peak = value; }
    else if (value > peak) peak = value;
  }
}
ok(
  resets.length === 0,
  `no coin starts its entrance over during the load (${resets.length} restarts${
    resets.length ? `, e.g. coin ${resets[0].coin} fell ${resets[0].from} -> ${resets[0].to}` : ''})`
);

const settled = await p.evaluate(() => Array.from(
  document.querySelectorAll('.dex-card-animation__shell'),
  (s) => +(+getComputedStyle(s).opacity).toFixed(2)
));
ok(settled.length === 5 && settled.every((v) => v > 0.99), `all five coins end up visible (${settled.join(', ')})`);

// The other half. A refresh is not only a load thing: every resize triggers
// one, and so does coming back to the page.
const entranceTime = () => p.evaluate(() => {
  const s = document.querySelector('.dex-card-animation__shell');
  const a = s.getAnimations().find((x) => (x.animationName || '').includes('token-enter'));
  return { running: !!a, time: a ? Math.round(a.currentTime || 0) : -1, opacity: +(+getComputedStyle(s).opacity).toFixed(2) };
});

const before = await entranceTime();
await p.setViewportSize({ width: 1512, height: 861 });
await p.waitForTimeout(600);
const after = await entranceTime();

ok(
  after.opacity > 0.99,
  `a resize does not blank the coins (opacity ${before.opacity} -> ${after.opacity})`
);
ok(
  !(after.running && after.time < before.time),
  `and does not replay the entrance (animation time ${before.time} -> ${after.time})`
);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'HERO COINS ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
