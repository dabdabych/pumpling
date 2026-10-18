// The coins people have backed with 1 SOL and up, as bubbles on the main page.
//
// Asked for on 2026-10-16, in place of the chat on the first screen, after
// massive.gg: real coins that have been through the pools, each one opening
// where it trades; the ten latest, the biggest at most twice the smallest. What this checks in a browser: every coin drawn, none on
// another and none out of its card, the labels clear of the other bubbles, at
// every window with and without motion; each one a button opening the coin's
// window; what it is, said under it on hover and focus and in its name to a
// screen reader; a picture that fails turning into initials;
// and the empty and failed answers said in words, never as a zero.
import { launch, BASE } from '../lib/browser.mjs';
import { FEED_SIZES } from '../lib/feed-layout.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { BACKED, mockBubbles, mockChat, mockStory } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function home(viewport = { width: 1440, height: 900 }, { mode = 'ok', reducedMotion = 'no-preference' } = {}) {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, reducedMotion });
  await mockCard(ctx, 'openEmpty');
  await mockBubbles(ctx, mode);
  await mockChat(ctx);
  await mockStory(ctx);
  await ctx.addInitScript(() => { window.__events = []; window.gtag = (...args) => { if (args[0] === 'event') window.__events.push({ name: args[1], ...args[2] }); }; });
  const p = await ctx.newPage();
  const errors = [];
  const asked = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => { if (r.url().includes('/lottery/coins/backed')) asked.push(r.url()); });
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector(mode === 'ok' ? '.bub__item' : '.bub__state', { timeout: 20000 });
  await p.waitForTimeout(1200);
  return { ctx, p, errors, asked };
}
const text = (p, sel) => p.locator(sel).first().evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
/** The bubbles float a pixel or two all the time, which Playwright reads as "not stable": point at the centre, as a person does. */
async function pointAt(p, index) {
  const box = await p.locator('.bub__link').nth(index).boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

// ------------------------------------------------------------ every coin, a real link, biggest first
{
  const { ctx, p, errors, asked } = await home();
  const query = asked.length ? new URL(asked[0]).searchParams : null;
  ok(query?.get('limit') === '10' && query?.get('sort') === 'recent' && query?.get('min_sol') === '1', `it asks for the ten coins committed to most lately, 1 SOL and up (${asked[0]?.replace(/^.*\?/, '?')})`);
  const items = await p.$$eval('.bub__link', (links) => links.map((a) => ({
    tag: a.tagName, popup: a.getAttribute('aria-haspopup'),
    label: a.getAttribute('aria-label'), ticker: a.querySelector('.bub__ticker')?.textContent.trim()
  })));
  ok(items.length === BACKED.length, `all ${BACKED.length} coins are drawn (${items.length})`);
  ok(items.map((i) => i.ticker).join(',') === BACKED.map((c) => '$' + c.symbol.replace(/^\$/, '')).join(','), `in order of SOL, so the keyboard and a screen reader meet them as the eye does (${items.map((i) => i.ticker).join(' ')})`);
  ok(!items.some((i) => i.ticker.startsWith('$$')), 'a ticker that carries its own dollar sign gets no second one');
  ok(items.every((i) => i.tag === 'BUTTON' && i.popup === 'dialog'), 'each is a button that opens a window (since 2026-10-16, its chart in pumpling)');
  ok(items[0].label === '$PUMPLING, pumpling: 20.05 SOL from 2 pools. Opens its chart in pumpling.', `a screen reader hears what the bubble is and what it opens ("${items[0].label}")`);
  const names = await p.$$eval('.bub__item', (els) => els.map((el) => [el.querySelector('img') ? 'img' : 'initials', el.querySelector('.bub__initials')?.textContent.trim() ?? '']));
  ok(names[2][0] === 'initials' && names[2][1] === 'TOA', `a coin with no picture shows its initials (${names[2].join(' ')})`);
  const broken = await p.waitForFunction(() => document.querySelectorAll('.bub__item')[3]?.querySelector('.bub__initials')?.textContent.trim() === 'BRO', null, { timeout: 5000 }).then(() => true, () => false);
  ok(broken, 'a picture that fails to load turns into the initials');
  const sol = await p.$$eval('.bub__sol', (els) => els.map((e) => e.textContent.trim()));
  ok(sol.includes('20.05 SOL') && sol.includes('10.45 SOL'), `the big ones carry their SOL (${sol.join(', ')})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);

  // Hover and focus: what it is, underneath.
  const hint = await text(p, '.bub__foot');
  ok(/bigger the bubble/.test(hint ?? '') && /Click one to see its chart/.test(hint ?? ''), `the card says how to read it ("${hint}")`);
  await pointAt(p, 1);
  const detail = await text(p, '.bub__foot');
  ok(detail === '$MOCHI Mochi · 10.45 SOL from 1 pool · its chart in pumpling', `hovering a bubble says what it is under it ("${detail}")`);
  await p.mouse.move(5, 5);
  const back = await text(p, '.bub__foot');
  ok(/bigger the bubble/.test(back ?? ''), 'and moving away brings the hint back');

  // The keyboard reaches them, in order, and focus shows.
  await p.locator('.bub__link').first().focus();
  const ring = await p.evaluate(() => getComputedStyle(document.activeElement.querySelector('.bub__face')).outlineStyle);
  ok(ring === 'solid' && /PUMPLING/.test((await text(p, '.bub__foot')) ?? ''), `focus on a bubble shows a ring and says what it is (${ring})`);
  await p.keyboard.press('Tab');
  ok(await p.evaluate(() => document.activeElement?.querySelector('.bub__ticker')?.textContent.trim()) === '$MOCHI', 'Tab goes to the next biggest');

  // A press opens the coin's window (the suite coin-story checks what is in it), and the funnel hears of it.
  await pointAt(p, 0);
  await p.mouse.down();
  await p.mouse.up();
  const opened = await p.waitForSelector('mat-dialog-container .story__title', { timeout: 8000 }).then(() => true, () => false);
  const ev = await p.evaluate(() => window.__events.find((e) => e.name === 'home_bubble_click'));
  ok(opened && ev?.rank === 1, `a press opens the coin's window, and is counted (${JSON.stringify(ev)})`);
  ok(new URL(p.url()).pathname === '/' && ctx.pages().length === 1, 'and no tab opens, the main page stays where it was');
  await ctx.close();
}

// ------------------------------------------------------------ nothing yet, or no answer
{
  const { ctx, p, errors } = await home({ width: 1440, height: 900 }, { mode: 'empty' });
  const said = await text(p, '.bub__state');
  ok(said === 'Coins show up here once they have 1 SOL behind them.' && !/\b0\b/.test(said), `no coins yet is said as what will be there, not as a zero ("${said}")`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}
{
  const { ctx, p, errors } = await home({ width: 1440, height: 900 }, { mode: 'fail' });
  const said = await text(p, '.bub__state');
  ok(said === 'The coins could not be loaded just now.', `a failed answer is said plainly ("${said}")`);
  ok(errors.length === 0, `and breaks nothing else ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ at every window: apart, inside, labels clear
const problems = [];
const runs = [...FEED_SIZES.map(([w, h]) => [w, h, 'no-preference']), [1440, 900, 'reduce'], [1024, 600, 'reduce'], [390, 844, 'reduce'], [1024, 600, 'no-preference']];
for (const [width, height, motion] of runs) {
  const { ctx, p, errors } = await home({ width, height }, { reducedMotion: motion });
  const found = await p.evaluate(() => {
    const issues = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) issues.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
    const field = document.querySelector('.bub__field').getBoundingClientRect();
    const card = document.querySelector('.qres-bubbles-card').getBoundingClientRect();
    // At rest: the float is a couple of pixels and is paused on hover and focus.
    const faces = [...document.querySelectorAll('.bub__face')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2, el };
    });
    if (faces.length < 6) issues.push(`only ${faces.length} of 6 drawn`);
    faces.forEach((f, i) => {
      if (f.x - f.r < field.left - 3 || f.x + f.r > field.right + 3 || f.y - f.r < field.top - 3 || f.y + f.r > field.bottom + 3) issues.push(`bubble ${i + 1} is out of its field`);
      if (f.r < 20) issues.push(`bubble ${i + 1} is ${Math.round(f.r * 2)}px across`);
    });
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
      const d = Math.hypot(faces[i].x - faces[j].x, faces[i].y - faces[j].y) - faces[i].r - faces[j].r;
      if (d < 2) issues.push(`bubbles ${i + 1} and ${j + 1} touch (${Math.round(d)}px)`);
    }
    // The biggest at most twice the smallest across (Georgiy, 2026-10-16).
    if (faces.length) {
      const spread = Math.max(...faces.map((f) => f.r)) / Math.min(...faces.map((f) => f.r));
      if (spread > 2.02) issues.push(`the biggest is ${spread.toFixed(2)} times the smallest across`);
    }
    // Labels: inside the card, off every other bubble, off each other.
    const labels = [...document.querySelectorAll('.bub__ticker, .bub__sol')].map((el) => ({ r: el.getBoundingClientRect(), owner: el.closest('.bub__item'), text: el.textContent.trim(), el }));
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    for (const label of labels) {
      const r = label.r;
      // A long ticker may end in an ellipsis in a small bubble; in a big one it is shown whole.
      const across = label.owner.getBoundingClientRect().width;
      const style = getComputedStyle(label.el);
      // Cut only where the font is already at its 8px floor; any bigger bubble shrinks the ticker to fit whole.
      if (label.el.scrollWidth > label.el.clientWidth + 1 && (parseFloat(style.fontSize) > 8.05 || style.textOverflow !== 'ellipsis')) issues.push(`"${label.text}" is cut in a ${Math.round(across)}px bubble at ${style.fontSize}`);
      const face = label.owner.querySelector('.bub__face').getBoundingClientRect();
      if (r.left < face.left - 1 || r.right > face.right + 1 || r.top < face.top - 1 || r.bottom > face.bottom + 1) issues.push(`"${label.text}" sticks out of its bubble`);
      faces.forEach((f, i) => {
        if (f.el.closest('.bub__item') === label.owner) return;
        const gap = Math.hypot(clamp(f.x, r.left, r.right) - f.x, clamp(f.y, r.top, r.bottom) - f.y) - f.r;
        if (gap < 0) issues.push(`"${label.text}" lies on bubble ${i + 1} (${Math.round(gap)}px)`);
      });
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].r; const c = labels[j].r;
      const o = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
      if (o > 2) issues.push(`"${labels[i].text}" lies on "${labels[j].text}"`);
    }
    const foot = document.querySelector('.bub__foot');
    if (foot.getBoundingClientRect().bottom > card.bottom + 1) issues.push('the hint under the bubbles is cut by the card');
    return issues;
  });
  if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
  if (found.length) problems.push(`${width}x${height}${motion === 'reduce' ? ' reduced motion' : ''}: ${found.slice(0, 4).join('; ')}`);
  console.log(`     ${width}x${height}${motion === 'reduce' ? ' reduced motion' : ''}: ${found.length ? found.length + ' problem(s)' : 'clean'}`);
  await ctx.close();
}
ok(problems.length === 0, `the bubbles fit at every window, with and without motion (${problems.length} with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

// ------------------------------------------------------------ a card resized: drawn again to fit
{
  const { ctx, p } = await home({ width: 1440, height: 900 });
  const before = await p.$eval('.bub__item', (el) => el.getBoundingClientRect().width);
  await p.setViewportSize({ width: 1024, height: 700 });
  const after = await p.waitForFunction((w) => {
    const now = document.querySelector('.bub__item')?.getBoundingClientRect().width;
    return now && Math.abs(now - w) > 4 ? now : null;
  }, before, { timeout: 5000 }).then((h) => h.jsonValue(), () => null);
  ok(after !== null, `a smaller window redraws the bubbles to fit (${Math.round(before)}px → ${after ? Math.round(after) : 'unchanged'})`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'COIN BUBBLES ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
