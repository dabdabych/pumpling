// The main page's Commit SOL card.
//
// 2026-10-05: "it isn't obvious what to do when you land on the site", answered
// with a panel of steps, a field and buttons laid over the card. 2026-10-16:
// that panel covered the drawing, "a nightmare". The card is Gleb's drawing
// again, the whole of it one link, with two lines in the clear band between
// the coins: what pressing it does, and where the round is.
//
// What this checks: the words in each phase and no zero anywhere; that the
// card goes where its title says (the pool page, never opening the commit
// dialog by itself; the archive's pool after one ended); that the whole drawing takes the
// press and a screen reader hears only the action; the keyboard; the funnel
// events; and at every window, with motion and without, that the words stay in
// the clear middle: inside the card, off the coins, and the drawing whole.
import { launch, BASE } from '../lib/browser.mjs';
import { FEED_SIZES } from '../lib/feed-layout.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { mockBubbles, mockChat } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function home(phase, viewport = { width: 1440, height: 900 }, { reducedMotion = 'no-preference', archiveFails = false } = {}) {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500, reducedMotion });
  await mockCard(ctx, phase, { archiveFails });
  await mockBubbles(ctx);
  await mockChat(ctx);
  await ctx.addInitScript(() => { window.__events = []; window.gtag = (...args) => { if (args[0] === 'event') window.__events.push({ name: args[1], ...args[2] }); }; });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.cta__body .cta__title', { timeout: 20000 });
  await p.waitForTimeout(3600); // the coins fly in over about three and a half seconds
  return { ctx, p, errors };
}
const text = (p, sel) => p.locator(sel).first().evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const events = (p) => p.evaluate(() => window.__events ?? []);
async function settles(read, good, timeout = 5000) {
  const until = Date.now() + timeout;
  let value = await read();
  while (!good(value) && Date.now() < until) { await new Promise((r) => setTimeout(r, 100)); value = await read(); }
  return value;
}

// ------------------------------------------------------------ the words, phase by phase
const WORDS = {
  openEmpty: { title: 'Promote your coin', status: /^Pool open · closes in \d\d:\d\d:\d\d$/, href: '/pool' },
  openWithCoins: { title: 'Promote your coin', status: /^Pool open · closes in/, href: '/pool' },
  locked: { title: 'Watch the draw', status: /^Pool locked · draw/, href: '/pool' },
  buying: { title: 'Watch the buys', status: /^Buying now/, href: '/pool' },
  done: { title: 'See how it ended', status: /^Next pool in \d\d:\d\d:\d\d$/, href: '/archive?pool=128' },
  doneAfterEmpty: { title: 'See the pool', status: /^Next pool in/, href: '/pool' },
  launch: { title: 'See the pool', status: /^First pool opens in 1d/, href: '/pool' }
};
for (const [phase, want] of Object.entries(WORDS)) {
  const { ctx, p, errors } = await home(phase);
  const got = {
    title: await text(p, '.cta__link'),
    status: await text(p, '.cta__status'),
    href: await p.locator('.cta__link').getAttribute('href'),
    name: await p.locator('.cta__link').evaluate((a) => a.textContent.replace(/\s+/g, ' ').trim()),
    all: await text(p, '.cta__body')
  };
  ok(got.title === want.title && want.status.test(got.status ?? '') && got.href === want.href,
    `${phase}: "${got.title}" / "${got.status}" → ${got.href}`);
  ok(!/\b0 (coins?|SOL|buys?)\b/.test(got.all ?? ''), `${phase}: no zero anywhere`);
  ok(got.name === want.title, `${phase}: the link's name is the action alone, no ticking clock in it ("${got.name}")`);
  ok(await p.locator('.cta__panel, .cta__steps, .cta__commit, .cta__past').count() === 0, `${phase}: no panel, steps, field or past-pools link over the drawing`);
  ok(errors.length === 0, `${phase}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ the whole drawing is the press
{
  const { ctx, p, errors } = await home('openEmpty');
  // A coin in the top left corner, far from the words.
  const coin = await p.locator('.qres-cta-card .dex-card-animation__token img').first().boundingBox();
  await p.mouse.click(coin.x + coin.width / 2, coin.y + coin.height / 2);
  await p.waitForURL(/\/pool$/, { timeout: 10000 });
  await p.waitForSelector('.pool-card', { timeout: 15000 });
  await p.waitForTimeout(1500);
  // 2026-10-16: the card opened the commit dialog at once; Georgiy: not needed.
  ok(await p.locator('mat-dialog-container').count() === 0, 'a press on a coin in the corner opens the pool page, and no commit dialog opens by itself');
  const ev = (await events(p)).map((e) => e.name);
  ok(ev.includes('home_promote_click') && !ev.includes('commit_dialog_open'), `the funnel sees the press, and no dialog (${ev.join(', ')})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}
{
  const { ctx, p } = await home('buying');
  await p.locator('.cta__link').click();
  await p.waitForURL(/\/pool$/, { timeout: 10000 });
  const ev = (await events(p)).find((e) => e.name === 'home_watch_click');
  ok(ev?.phase === 'buying' && ev?.to === 'pool', `buying: the card goes to the pool page, and says so to analytics (${JSON.stringify(ev)})`);
  ok(await p.locator('mat-dialog-container').count() === 0, 'buying: no commit dialog, nothing can be committed now');
  await ctx.close();
}

// ------------------------------------------------------------ hover and keyboard
{
  const { ctx, p } = await home('openEmpty');
  const fill = () => p.locator('.cta').evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await fill();
  await p.locator('.qres-cta-card').hover({ position: { x: 30, y: 30 } });
  const hovered = await settles(fill, (v) => v !== before, 2000);
  ok(before !== hovered, `hovering the card turns it purple, as it always did (${before} → ${hovered})`);
  await p.mouse.move(5, 5);
  // Tab from the top of the page until the card's link has focus.
  let focused = false;
  for (let i = 0; i < 25 && !focused; i++) {
    await p.keyboard.press('Tab');
    focused = await p.evaluate(() => document.activeElement?.classList.contains('cta__link'));
  }
  const ring = await p.evaluate(() => getComputedStyle(document.querySelector('.cta__link'), '::after').outlineStyle);
  ok(focused && ring === 'solid', `the card can be reached with Tab and shows where focus is (${focused}, outline ${ring})`);
  await p.keyboard.press('Enter');
  await p.waitForURL(/\/pool/, { timeout: 10000 });
  ok(true, 'Enter on it goes where a press does');
  await ctx.close();
}

// ------------------------------------------------------------ to the pool that has just ended
{
  const { ctx, p } = await home('done');
  await p.locator('.cta__link').click();
  await p.waitForURL(/\/archive\?pool=128/, { timeout: 10000 });
  const bar = p.locator('#pool-128 .round__toggle');
  const expanded = await settles(() => bar.getAttribute('aria-expanded').catch(() => null), (v) => v === 'true');
  const inView = await settles(() => p.evaluate(() => { const r = document.getElementById('pool-128')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.top < window.innerHeight; }), (v) => v);
  ok(expanded === 'true' && inView, `"See how it ended" opens that pool in the archive, in view (${expanded}, ${inView})`);
  await ctx.close();
}

// ------------------------------------------------------------ no archive: the general words, nothing broken
{
  const { ctx, p, errors } = await home('done', { width: 1440, height: 900 }, { archiveFails: true });
  const title = await text(p, '.cta__link');
  ok(title === 'See the pool' && errors.length === 0, `when the archive does not answer, the card says the general line and goes to the pool ("${title}")`);
  await ctx.close();
}

// ------------------------------------------------------------ at every window: the words in the clear band
const problems = [];
const runs = [...FEED_SIZES.map(([w, h]) => ['openEmpty', w, h, 'no-preference']), ['done', 390, 844, 'no-preference'], ['openWithCoins', 1024, 600, 'no-preference'],
  ['launch', 360, 740, 'no-preference'], ['openEmpty', 1440, 900, 'reduce'], ['openEmpty', 1024, 600, 'reduce'], ['openEmpty', 390, 844, 'reduce']];
for (const [phase, width, height, motion] of runs) {
  const { ctx, p, errors } = await home(phase, { width, height }, { reducedMotion: motion });
  // The coins wobble by about ten pixels over three seconds: measured at four
  // moments of it, so a line that only touches a coin at one end of the wobble is caught.
  const measure = () => p.evaluate(() => {
    const issues = [];
    const box = (el) => el.getBoundingClientRect();
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) issues.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
    const card = box(document.querySelector('.qres-cta-card'));
    // The words as the eye sees them: each line's own text, not the block's width.
    const lines = [...document.querySelectorAll('.cta__link, .cta__status')].map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return { name: el.className.split(' ')[0], rects: [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0) };
    });
    for (const line of lines) {
      for (const r of line.rects) {
        if (r.left < card.left || r.right > card.right || r.top < card.top || r.bottom > card.bottom) issues.push(`${line.name} runs out of the card`);
      }
    }
    // Off the coins. Each coin's picture is a 3000-unit square SVG drawn to fit
    // its box, with the coin a disc of radius 1000 in the middle and the rest
    // transparent margin: the disc is a third of the box's shorter side.
    const coins = [...document.querySelectorAll('.qres-cta-card .dex-card-animation__token img')].map((img) => {
      const r = box(img);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: Math.min(r.width, r.height) / 3 };
    });
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    for (const line of lines) {
      for (const r of line.rects) {
        coins.forEach((c, i) => {
          const gap = Math.hypot(clamp(c.x, r.left, r.right) - c.x, clamp(c.y, r.top, r.bottom) - c.y) - c.r;
          if (gap < 4) issues.push(`${line.name} ${gap < 0 ? 'lies on' : 'touches'} coin ${i + 1} (${Math.round(gap)}px)`);
        });
      }
    }
    // The drawing whole: the words take a small part of the card.
    const body = box(document.querySelector('.cta__body'));
    const share = (body.width * body.height) / (card.width * card.height);
    if (share > 0.3) issues.push(`the words take ${Math.round(share * 100)}% of the card`);
    return issues;
  });
  const found = [];
  for (let moment = 0; moment < (motion === 'reduce' ? 1 : 4); moment++) {
    if (moment) await p.waitForTimeout(800);
    for (const issue of await measure()) if (!found.includes(issue)) found.push(issue);
  }
  if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
  if (found.length) problems.push(`${phase} ${width}x${height}${motion === 'reduce' ? ' reduced motion' : ''}: ${found.slice(0, 4).join('; ')}`);
  console.log(`     ${phase} ${width}x${height}${motion === 'reduce' ? ' reduced motion' : ''}: ${found.length ? found.length + ' problem(s)' : 'clean'}`);
  await ctx.close();
}
ok(problems.length === 0, `the words stay in the clear band at every window, with and without motion (${problems.length} with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

console.log(fails ? `${fails} FAILED` : 'POOL CTA ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
