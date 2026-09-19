// The mark in the header: it has to be visible on every page and under any dialog.
//
// The splash hides the mark in the header while its own mark flies there, and
// removes the class from html at the very end. It is the only rule on the site
// that hides exactly one element, so its failure looks odd: the page is whole and
// there is a hole at the top left. The suite holds both ends: the class does not
// survive the splash leaving, and the mark is visible with a dialog over the page.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, MINTS } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const state = (p) => p.evaluate(() => {
  const node = document.querySelector('[data-splash-target]');
  if (!node) {
    return { found: false };
  }
  const rect = node.getBoundingClientRect();
  const hidden = [];
  for (let el = node; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.15) {
      hidden.push(`${el.tagName}.${String(el.className).slice(0, 24)}`);
    }
  }
  const img = node.querySelector('img');
  return {
    found: true,
    width: Math.round(rect.width),
    onScreen: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0,
    hidden,
    splashClass: document.documentElement.classList.contains('qres-splash-active'),
    imageLoaded: !img || (img.complete && img.naturalWidth > 0)
  };
});

const visible = (s) => s.found && s.width > 4 && s.onScreen && s.hidden.length === 0 && s.imageLoaded && !s.splashClass;

for (const [label, width, height, mobile] of [['desktop', 1440, 900, false], ['phone', 390, 844, true]]) {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ mint_address: MINTS.mochi, token_symbol: 'MOCHI', token_name: 'Mochi', is_pumpfun_mint: true })
  }));
  const p = await ctx.newPage();

  for (const path of ['/', '/pool', '/archive', '/me']) {
    for (let a = 0; a < 3; a++) {
      try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
    }
    await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
    await p.waitForTimeout(700);
    const s = await state(p);
    ok(visible(s), `${label} ${path}: the mark is in the header (${JSON.stringify(s)})`);
  }

  // The commit dialog over the page: the mark stays where it is.
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(700);
  await p.evaluate(() => window.scrollTo(0, 600));
  await p.waitForTimeout(400);
  const add = p.locator('.coin-row__add').first();
  if (await add.count()) {
    await add.click();
  } else {
    await p.locator('.pool-cta').first().click();
  }
  await p.waitForSelector('.commit__title', { timeout: 12000 });
  await p.waitForTimeout(1000);
  const withDialog = await state(p);
  ok(visible(withDialog), `${label}: the mark survives the commit window (${JSON.stringify(withDialog)})`);

  await p.keyboard.press('Escape');
  await p.waitForTimeout(800);
  const afterDialog = await state(p);
  ok(visible(afterDialog), `${label}: and stays after it closes (${JSON.stringify(afterDialog)})`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'HEADER MARK ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
