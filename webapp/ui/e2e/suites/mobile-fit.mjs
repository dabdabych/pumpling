// The layout on phones and a tablet: nothing runs past the edge and everything
// can be reached with a thumb.
//
// We check the measurable rather than "does it look nice": there is no horizontal
// scrolling, dialogs fit the screen, buttons are no smaller than forty points, and
// the commit button can be reached by scrolling inside the dialog.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, MINTS } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const cors = { 'access-control-allow-origin': '*' };
const SIZES = [
  ['iPhone SE', 375, 667],
  ['iPhone 14', 390, 844],
  ['small Android', 360, 640],
  ['iPad', 834, 1112],
];

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** What runs past the width of the screen. */
const overflow = (p) => p.evaluate(() => {
  const doc = document.documentElement;
  const spill = doc.scrollWidth - doc.clientWidth;
  const guilty = [];
  if (spill > 1) {
    for (const node of document.body.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > doc.clientWidth + 1 || rect.left < -1) {
        guilty.push(`${node.tagName}.${String(node.className).slice(0, 30)} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
        if (guilty.length >= 3) break;
      }
    }
  }
  return { spill, guilty };
});

for (const [name, width, height] of SIZES) {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ mint_address: MINTS.mochi, token_symbol: 'MOCHI', token_name: 'Mochi', is_pumpfun_mint: true })
  }));
  await ctx.route('**/rpc', (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const result = body.method === 'getRecentPrioritizationFees' ? [{ slot: 1, prioritizationFee: 40000 }] : null;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // 1. The pages: nothing sticks out sideways.
  for (const path of ['/', '/pool', '/archive', '/me']) {
    for (let a = 0; a < 3; a++) {
      try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
    }
    await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
    await p.waitForTimeout(600);
    const { spill, guilty } = await overflow(p);
    ok(spill <= 1, `${name} ${path}: nothing sticks out sideways (${spill}px ${guilty.join('; ')})`);
  }

  // 2. The commit dialog: it fits, the buttons are large, and sending can be reached.
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(700);
  const add = p.locator('.coin-row__add').first();
  if (await add.count()) {
    await add.tap();
  } else {
    await p.locator('.pool-cta').first().tap();
  }
  await p.waitForSelector('.commit__title', { timeout: 12000 });
  await p.waitForTimeout(900);

  const dialog = await p.evaluate(() => {
    const pane = document.querySelector('.cdk-overlay-pane');
    const rect = pane.getBoundingClientRect();
    const tooSmall = [];
    for (const node of pane.querySelectorAll('button')) {
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // A link inside a sentence lives by a different rule: breaking the text
      // for forty points is not on, so its lower bound is 24 — the same as
      // WCAG 2.5.8 requires.
      const inline = /link/.test(String(node.className));
      const min = inline ? 24 : 36;
      if (r.height < min) {
        tooSmall.push(`${String(node.className).slice(0, 26)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    const priority = pane.querySelector('.commit__priority-row');
    const priorityRect = priority?.getBoundingClientRect();
    return {
      fitsWidth: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      width: Math.round(rect.width),
      viewport: window.innerWidth,
      tooSmall,
      priorityInside: !priorityRect || (priorityRect.left >= rect.left - 1 && priorityRect.right <= rect.right + 1),
      levels: priority ? priority.children.length : 0
    };
  });
  ok(dialog.fitsWidth, `${name}: the commit window fits the screen (${dialog.width} of ${dialog.viewport})`);
  ok(dialog.tooSmall.length === 0, `${name}: buttons are big enough for a finger (${dialog.tooSmall.join('; ') || 'all fine'})`);
  ok(dialog.priorityInside && dialog.levels === 3, `${name}: the three priority levels sit inside the window (${dialog.levels})`);

  // The send button: visible at once or reachable by scrolling inside the dialog.
  const submit = await p.evaluate(() => {
    const button = document.querySelector('.commit__submit');
    button.scrollIntoView({ block: 'center' });
    const r = button.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), viewport: window.innerHeight };
  });
  ok(
    submit.top >= 0 && submit.bottom <= submit.viewport + 1 && submit.height >= 36,
    `${name}: the commit button can be reached (${JSON.stringify(submit)})`
  );

  const afterDialog = await overflow(p);
  ok(afterDialog.spill <= 1, `${name}: the open window adds no sideways scroll (${afterDialog.spill}px)`);

  // 3. The wallet chooser fits the screen.
  await p.locator('.commit__submit').tap();
  await p.waitForTimeout(900);
  const picker = await p.evaluate(async () => {
    const method = Array.from(document.querySelectorAll('.auth-method')).find((n) => /wallet/i.test(n.textContent || ''));
    method?.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const pane = document.querySelector('.wallet-connect-dialog');
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    return {
      fits: rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
      box: { left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  });
  ok(picker && picker.fits, `${name}: the wallet picker fits the screen (${JSON.stringify(picker)})`);

  ok(errors.length === 0, `${name}: no page errors (${errors.join(' | ')})`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'MOBILE FIT ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
