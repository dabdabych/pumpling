// How it works and Past pools in the header (header-nav.component).
//
// Asked for on 2026-10-16: How it works out of the section strip and into the
// header as a button, Past pools up there too. From 1024px the links stand in
// the bar; narrower they fold behind a menu button, a disclosure of links. What
// this checks: which form shows at which width; the menu opens, closes on
// Escape (focus back on its button), on a press outside and on a choice; How it
// works moves the story on the main page and is a link to /#how elsewhere; Past
// pools leads to the archive and says it is the current page there; and that
// both headers keep every control on one line inside the bar, signed in and out,
// from 320px to 2560px.
import { launch, BASE } from '../lib/browser.mjs';
import { FEED_SIZES } from '../lib/feed-layout.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { mockBubbles, mockChat } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const cors = { 'access-control-allow-origin': '*' };
const JWT = 'header.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig';

async function open(path, viewport, { signedIn = false } = {}) {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  await mockCard(ctx, 'openEmpty');
  await mockBubbles(ctx);
  await mockChat(ctx, { count: 2 });
  await ctx.route('**/lottery/archive**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ lottery_type: 'dex', window_days: 30, items: [] }) }));
  await ctx.route('**/lottery/my/commits**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ total_sol: 0, rounds: [] }) }));
  if (signedIn) await ctx.addInitScript((jwt) => localStorage.setItem('jwt', jwt), JWT);
  await ctx.addInitScript(() => { window.__events = []; window.gtag = (...args) => { if (args[0] === 'event') window.__events.push({ name: args[1], ...args[2] }); }; });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('app-header-nav', { timeout: 20000 });
  await p.waitForTimeout(1200);
  return { ctx, p, errors };
}
const visible = (p, sel) => p.locator(sel).first().isVisible().catch(() => false);

// ------------------------------------------------------------ wide: in the bar
{
  const { ctx, p, errors } = await open('/', { width: 1440, height: 900 });
  ok(await visible(p, '.hnav__bar') && !(await visible(p, '.hnav__toggle')), 'at 1440px the links stand in the bar, no menu button');
  const words = await p.$$eval('.hnav__bar .hnav__link', (els) => els.map((e) => e.textContent.trim()));
  ok(words.join(',') === 'How it works,Past pools', `How it works and Past pools (${words.join(', ')})`);
  ok(await p.locator('.hnav__bar button.hnav__link').first().textContent() === 'How it works', 'on the main page How it works is a button: it moves the story, it does not load a page');
  await p.locator('.hnav__bar a.hnav__link', { hasText: 'Past pools' }).click();
  await p.waitForURL(/\/archive$/, { timeout: 10000 });
  await p.waitForSelector('app-site-header .hnav__link--current', { timeout: 10000 });
  const current = await p.locator('app-site-header .hnav__bar a[aria-current="page"]').textContent().catch(() => null);
  ok(current?.trim() === 'Past pools', `Past pools takes you to the archive, and says there that you are on it (${current})`);
  const how = await p.locator('app-site-header .hnav__bar a.hnav__link', { hasText: 'How it works' }).getAttribute('href');
  ok(how === '/#how', `in the archive How it works is a link to the main page's section (${how})`);
  const ev = (await p.evaluate(() => window.__events)).find((e) => e.name === 'past_pools_click');
  ok(ev?.from === 'header', `the press is counted as coming from the header (${JSON.stringify(ev)})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ narrow: behind a button
for (const width of [390, 768]) {
  const { ctx, p, errors } = await open('/', { width, height: 844 });
  ok(await visible(p, '.hnav__toggle') && !(await visible(p, '.hnav__bar')), `at ${width}px the links fold behind a menu button`);
  const toggle = p.locator('.hnav__toggle');
  ok(await toggle.getAttribute('aria-expanded') === 'false' && (await toggle.innerText()).trim() === 'Menu', 'the button is named Menu and says it is closed');
  await toggle.click();
  // Angular draws a press's result on the next frame: wait for it, do not read at once.
  await p.waitForSelector('#hnav-list .hnav__item', { timeout: 3000 }).catch(() => {});
  const list = await p.evaluate(() => {
    const el = document.querySelector('#hnav-list');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, vw: innerWidth, items: [...el.querySelectorAll('.hnav__item')].map((i) => [i.textContent.trim(), Math.round(i.getBoundingClientRect().height)]) };
  });
  ok(!!list && await toggle.getAttribute('aria-expanded') === 'true', `pressing it opens the list (${JSON.stringify(list?.items)})`);
  ok(list && list.left >= 0 && list.right <= list.vw, `the list is inside the screen (${Math.round(list?.left)}..${Math.round(list?.right)} of ${list?.vw})`);
  ok(list && list.items.every(([, h]) => h >= 44), 'each item is a full thumb high');
  ok(await p.locator('#hnav-list [role="menu"], #hnav-list [role="menuitem"]').count() === 0, 'a list of links, not an ARIA menu');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#hnav-list', { state: 'detached', timeout: 3000 }).catch(() => {});
  ok(await p.locator('#hnav-list').count() === 0 && await p.evaluate(() => document.activeElement?.classList.contains('hnav__toggle')), 'Escape closes it, focus back on the button');
  await toggle.click();
  await p.waitForSelector('#hnav-list', { timeout: 3000 });
  // On plain text: a press on a link closes the list and follows the link, as it should.
  await p.locator('.qres-hero-lede').click({ position: { x: 4, y: 4 } });
  await p.waitForSelector('#hnav-list', { state: 'detached', timeout: 3000 }).catch(() => {});
  ok(await p.locator('#hnav-list').count() === 0, 'a press outside closes it');
  await toggle.click();
  await p.waitForSelector('#hnav-list', { timeout: 3000 });
  await p.locator('#hnav-list .hnav__item', { hasText: 'Past pools' }).click();
  await p.waitForURL(/\/archive$/, { timeout: 10000 });
  ok(await p.locator('#hnav-list').count() === 0, 'choosing Past pools goes to the archive and closes the list');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// How it works from the phone's menu moves the page to that section.
{
  const { ctx, p } = await open('/', { width: 390, height: 844 });
  await p.locator('.hnav__toggle').click();
  await p.locator('#hnav-list .hnav__item', { hasText: 'How it works' }).click();
  const reached = await p.waitForFunction(() => {
    const el = document.querySelector('[aria-label="how it works"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top < innerHeight * 0.6 && r.bottom > 0;
  }, null, { timeout: 8000 }).then(() => true, () => false);
  ok(reached && await p.locator('#hnav-list').count() === 0, 'How it works from the phone\'s menu brings the section up, and the list closes');
  await ctx.close();
}

// Signed in, the inner pages' menu has My commits.
{
  const { ctx, p } = await open('/archive', { width: 390, height: 844 }, { signedIn: true });
  await p.locator('app-site-header .hnav__toggle').click();
  await p.waitForSelector('#hnav-list .hnav__item', { timeout: 3000 }).catch(() => {});
  const items = await p.$$eval('#hnav-list .hnav__item', (els) => els.map((e) => [e.textContent.trim(), e.getAttribute('href')]));
  ok(items.map((i) => i[0]).join(',') === 'How it works,Past pools,My commits' && items[2][1] === '/me', `signed in, My commits joins them (${items.map((i) => i.join(' ')).join(', ')})`);
  await ctx.close();
}

// ------------------------------------------------------------ every control on one line, inside the bar
const problems = [];
const pages = [['/', false], ['/archive', false], ['/archive', true], ['/', true]];
for (const [path, signedIn] of pages) {
  for (const [width, height] of FEED_SIZES) {
    const { ctx, p, errors } = await open(path, { width, height }, { signedIn });
    const found = await p.evaluate(() => {
      const issues = [];
      const bar = document.querySelector('app-site-header .site-header__bar') ?? document.querySelector('.qres-header-bar.relative');
      const br = bar.getBoundingClientRect();
      const style = getComputedStyle(bar);
      const inner = { left: br.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) - 0.5, right: br.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) + 0.5 };
      const controls = [...bar.querySelectorAll('a, button')].filter((el) => el.offsetParent && el.getBoundingClientRect().width > 0)
        .map((el) => ({ el, r: el.getBoundingClientRect(), name: (el.textContent.trim() || el.getAttribute('aria-label') || el.className).slice(0, 18) }));
      for (const c of controls) {
        if (c.r.left < inner.left || c.r.right > inner.right) issues.push(`"${c.name}" leaves the bar (${Math.round(c.r.left)}..${Math.round(c.r.right)} in ${Math.round(inner.left)}..${Math.round(inner.right)})`);
        if (c.r.height > 44) issues.push(`"${c.name}" broke onto two lines (${Math.round(c.r.height)}px)`);
      }
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i].r; const c = controls[j].r;
        if (controls[i].el.contains(controls[j].el) || controls[j].el.contains(controls[i].el)) continue;
        const o = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
        if (o > 1) issues.push(`"${controls[i].name}" lies on "${controls[j].name}"`);
      }
      // The marquee on the main page, where it shows, must not run under the links.
      const marquee = bar.querySelector('p');
      if (marquee && marquee.offsetParent) {
        const m = marquee.getBoundingClientRect();
        for (const c of controls) {
          const o = Math.max(0, Math.min(m.right, c.r.right) - Math.max(m.left, c.r.left));
          if (o > 0 && c.r.top < m.bottom && c.r.bottom > m.top) issues.push(`the marquee runs under "${c.name}"`);
        }
      }
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) issues.push(`page scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
      return issues;
    });
    if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
    if (found.length) problems.push(`${path}${signedIn ? ' signed in' : ''} ${width}x${height}: ${found.slice(0, 3).join('; ')}`);
    await ctx.close();
  }
  console.log(`     ${path}${signedIn ? ' signed in' : ''}: ${problems.filter((x) => x.startsWith(path + (signedIn ? ' signed in' : ' '))).length} window(s) with problems`);
}
ok(problems.length === 0, `both headers keep every control on one line inside the bar, signed in and out, 320px to 2560px (${problems.length} with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

console.log(fails ? `${fails} FAILED` : 'HEADER NAV ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
