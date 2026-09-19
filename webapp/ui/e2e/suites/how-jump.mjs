// The "How it works" link from the pool page has to open the section straight away.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await mockCurrent(ctx, () => SCENARIOS.open());
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await Promise.all([
  p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }),
  p.locator('.pool-link', { hasText: 'How it works' }).click()
]);
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
// we watch the scroll and whether another section showed along the way
const seen = await p.evaluate(() => new Promise((resolve) => {
  const samples = [];
  const visible = new Set();
  const check = () => {
    samples.push(Math.round(window.scrollY));
    for (const [name, selector] of [['what', '[aria-label="what is it?"]'], ['how', '[aria-label="how it works"]'], ['quick', '[aria-label="quick start"]']]) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const shown = Number(style.opacity) > 0.15 && style.visibility !== 'hidden' && box.top < window.innerHeight && box.bottom > 0;
      if (shown) visible.add(name);
    }
  };
  const id = setInterval(check, 60);
  setTimeout(() => { clearInterval(id); resolve({ samples, visible: [...visible] }); }, 2600);
}));
const moved = new Set(seen.samples).size;
ok(new URL(p.url()).pathname === '/' && (await p.evaluate(() => location.hash)) === '#how', `lands on the main page at ${await p.evaluate(() => location.hash)}`);
ok(!seen.visible.includes('what'), `"What is it" never shows up on the way (seen: ${seen.visible.join(', ')})`);
ok(moved <= 2, `no scroll ride through the story (${moved} distinct scroll positions: ${[...new Set(seen.samples)].slice(0, 6).join(', ')})`);
const active = await p.locator('.qres-nav__item.is-active, [data-active-section]').first().innerText().catch(() => '');
const how = await p.evaluate(() => {
  const node = document.querySelector('[aria-label="how it works"]');
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return { opacity: Number(getComputedStyle(node).opacity).toFixed(2), top: Math.round(box.top) };
});
ok(how && Number(how.opacity) > 0.9, `the How section is on screen right away ${JSON.stringify(how)} ${active}`);
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'HOW JUMP ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
