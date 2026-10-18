// The scale at the top of How it works, at every window, with and without motion.
//
// Until 2026-10-18 it was two equal hours, 0h / 1h / 2h, the pool open for an
// hour and an hour of buying. The buying went from fifty minutes to twenty
// that day and the pool from seventy to sixty-five, so the scale is to time
// now: Locked at 65 of 85 minutes, and the dots of Locked, Buying and Sent sit
// close together on the right. What this checks: the words (65 and 20, no
// hour left), the dots where the minutes put them, and no caption, tick or
// segment name on another or off the screen, from 320px to 2560px.
import { launch, BASE } from '../lib/browser.mjs';
import { FEED_SIZES } from '../lib/feed-layout.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { mockBubbles, mockChat } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function how(viewport, reducedMotion) {
  const phone = viewport.width < 500;
  const ctx = await b.newContext({ viewport, reducedMotion, isMobile: phone, hasTouch: phone });
  await mockCard(ctx, 'openEmpty');
  await mockBubbles(ctx);
  await mockChat(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/#how', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.track__node', { timeout: 20000 });
  await p.locator('.track').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await p.waitForTimeout(2500);
  return { ctx, p, errors };
}

const measure = (p) => p.evaluate(() => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, text: el.textContent.replace(/\s+/g, ' ').trim() }; };
  const track = document.querySelector('.track');
  const t = track.getBoundingClientRect();
  const nodes = [...track.querySelectorAll('.track__node')].map((n) => (n.getBoundingClientRect().left + n.getBoundingClientRect().width / 2 - t.left) / t.width);
  return {
    width: t.width,
    nodes,
    labels: [...track.querySelectorAll('.track__label')].filter(visible).map(box),
    ticks: [...track.querySelectorAll('.track__ticks span')].filter(visible).map(box),
    segments: [...track.querySelectorAll('.track__segments span')].filter(visible).map(box),
    allText: track.textContent.replace(/\s+/g, ' '),
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  };
});
const overlap = (a, c) => Math.min(a.r, c.r) - Math.max(a.l, c.l) > 1 && Math.min(a.b, c.b) - Math.max(a.t, c.t) > 1;

// ------------------------------------------------------------ the words and the dots
{
  const { ctx, p } = await how({ width: 1440, height: 900 }, 'no-preference');
  const m = await measure(p);
  ok(!/\b[012]h\b|hour/i.test(m.allText), `no hour left on the scale ("${m.allText.trim()}")`);
  ok(m.ticks.map((x) => x.text).join(' | ') === '0 | 65 min | 85 min', `the ticks: 0, 65 and 85 minutes (${m.ticks.map((x) => x.text).join(' | ')})`);
  const want = [0, 32.5 / 85, 65 / 85, 75 / 85, 1];
  ok(m.nodes.every((at, i) => Math.abs(at - want[i]) < 0.01), `the dots where the minutes put them (${m.nodes.map((x) => x.toFixed(3)).join(' ')})`);
  const copy = await p.$$eval('.scene__title, .scene__text', (els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
  ok(copy.includes('A pool opens every 1.5 hours') && copy.includes('20 minutes of public buys')
    && copy.some((x) => x.startsWith('After 65 minutes or at 77 SOL')) && copy.some((x) => x.includes('spread across 20 minutes')),
    'the phases say 1.5 hours, 65 minutes and 20 minutes');
  ok(!copy.some((x) => /\bhour\b|one hour|1 hour/i.test(x)), `and no phase says an hour (${copy.filter((x) => /hour/i.test(x)).join(' / ')})`);
  await ctx.close();
}
{
  const { ctx, p } = await how({ width: 390, height: 844 }, 'no-preference');
  const m = await measure(p);
  ok(m.segments.map((x) => x.text).join(' | ') === 'Pool open · 65 min | Buys · 20 min', `on a phone the segments are named with their minutes (${m.segments.map((x) => x.text).join(' | ')})`);
  await ctx.close();
}

// ------------------------------------------------------------ at every window, nothing on anything
const problems = [];
for (const reducedMotion of ['no-preference', 'reduce']) {
  for (const [width, height] of [...FEED_SIZES, [1024, 600], [900, 700]]) {
    const { ctx, p, errors } = await how({ width, height }, reducedMotion);
    const m = await measure(p);
    const found = [];
    const all = [...m.labels.map((x) => ({ ...x, kind: 'label' })), ...m.ticks.map((x) => ({ ...x, kind: 'tick' })), ...m.segments.map((x) => ({ ...x, kind: 'segment' }))];
    for (let i = 0; i < all.length; i++) {
      if (all[i].l < -0.5 || all[i].r > m.innerWidth + 0.5) found.push(`${all[i].kind} "${all[i].text}" off the screen`);
      for (let j = i + 1; j < all.length; j++) if (overlap(all[i], all[j])) found.push(`"${all[i].text}" on "${all[j].text}"`);
    }
    if (m.scrollWidth > m.innerWidth + 1) found.push(`the page scrolls sideways by ${m.scrollWidth - m.innerWidth}px`);
    if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
    if (found.length) problems.push(`${width}x${height} ${reducedMotion}: ${found.slice(0, 3).join('; ')}`);
    await ctx.close();
  }
}
ok(problems.length === 0, `no caption, tick or segment name on another or off the screen, 320px to 2560px, with and without motion (${problems.length} with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

console.log(fails ? `${fails} FAILED` : 'HOW SCALE ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
