// How many /lottery/current requests the public pages make in a minute.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const WINDOW_MS = Number(process.env.WINDOW_MS || 60000);
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function measure(scenarioName, path, expectMin, expectMax, mutate) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  let scenario = SCENARIOS[scenarioName]();
  await mockCurrent(ctx, () => scenario);
  const p = await ctx.newPage();
  let calls = 0;
  p.on('request', (r) => { if (r.url().includes('/lottery/current')) calls++; });
  for (let a = 0; a < 3; a++) { try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  calls = 0; // we count the steady state, without the first load
  const started = Date.now();
  if (mutate) await mutate(p, (next) => { scenario = next; });
  await p.waitForTimeout(WINDOW_MS - (Date.now() - started));
  const perMinute = calls * 60000 / WINDOW_MS;
  ok(perMinute >= expectMin && perMinute <= expectMax, `${path} (${scenarioName}): ${calls} calls in ${WINDOW_MS / 1000}s = ${perMinute.toFixed(1)}/min, expected ${expectMin}-${expectMax}`);
  await ctx.close();
}

// an open pool: 5s; the pool page and the main page have to behave the same
await measure('open', '/pool', 8, 14);
await measure('open', '/', 8, 14);
// locked: 3s
await measure('lockedRunning', '/pool', 14, 24);
// buying: 15s
await measure('buying', '/pool', 2, 5);
// waiting for the next: 10s
await measure('waiting', '/pool', 4, 9);
// a hidden tab does not poll: we mock document.hidden the way our code sees it
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.addInitScript(() => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
  });
  const p = await ctx.newPage();
  let calls = 0;
  p.on('request', (r) => { if (r.url().includes('/lottery/current')) calls++; });
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  calls = 0;
  await p.waitForTimeout(20000);
  ok(calls === 0, `hidden tab: ${calls} calls in 20s`);
  await p.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForTimeout(1500);
  ok(calls >= 1, `coming back to the tab asks the server at once (${calls})`);
  await ctx.close();
}
console.log(fails ? `${fails} FAILED` : 'POLL RATE ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
