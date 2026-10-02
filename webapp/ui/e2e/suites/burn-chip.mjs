// The burn chip's card: what "50% BURN" on a coin means, and on my page what my
// own burn means (pool/burn-chip, opened by shared/info-popover like the coin
// check). Checked with real input: the mouse, the keyboard and a finger.
//
// Read alone, "50% BURN" sounds like half of everybody's tokens go. The card
// says it is the share of the coin's buy that is burned, and that each backer
// burns only their own share.
//
// On the code before this suite the chip is a plain span: nothing opens, and
// this fails at once.
import { launch, BASE } from '../lib/browser.mjs';
import { MINTS, SCENARIOS, entries, five, mockCurrent } from '../lib/pool-mock.mjs';

const cors = { 'access-control-allow-origin': '*' };
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const errors = [];
const AT = new Date(Date.now() - 12 * 60_000).toISOString();

/** Burn shares on two coins; MOCHI also has a coin check, so two triggers share its line. */
const withBurns = (scenario) => () => {
  const body = scenario();
  body.entries = entries(five).map((entry) => ({
    ...entry,
    burn_bps_avg: entry.coin.symbol === 'MOCHI' ? 5000 : entry.coin.symbol === 'ZAPZ' ? 10000 : 0,
    screening: entry.coin.symbol === 'MOCHI'
      ? { status: 'clean', reasons: [], missing: [], source: 'tracced', checked_at: AT, on_curve: true, levels: { dev: 'low', bundle: 'low', bundled_launch: 'low', top10: 'low', insiders: 'low' } }
      : null
  }));
  return body;
};

const myCommits = {
  total_sol: 1.2,
  rounds: [{
    lottery_id: 128, lottery_type: 'dex', status: 'proceeding_purchases',
    created_at: new Date(Date.now() - 3600_000).toISOString(), end_date: new Date(Date.now() - 1800_000).toISOString(),
    my_sol: 1.2, pool_sol: 64.5, wallets: ['Wa11etOne111111111111111111111111111111111'],
    coins: [{ mint: MINTS.toad, name: 'Toad Signal', ticker: 'TOAD', logo_url: null, my_sol: 1.2, my_commits: 1, pool_sol: 20, drawn_sol: 19.4, signatures: [], burn_bps: 2500 }]
  }]
};

async function open(path, viewport, mobile, scenario) {
  const ctx = await b.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, scenario ?? withBurns(SCENARIOS.open));
  await ctx.route('**/lottery/*/purchases', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ available: false, coins: [], purchases: [] }) }));
  await ctx.route('**/lottery/my/commits', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(myCommits) }));
  await ctx.route('**/lottery/coin/*/chart', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ mint: MINTS.mochi, available: true, minutes: 24, venue: 'raydium', price_usd: 0.00004, change_pct: 3,
      points: Array.from({ length: 25 }, (_, i) => ({ t: Math.floor(Date.now() / 1000) - (24 - i) * 60, p: 0.00004 + i * 1e-7 })) })
  }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${path} ${viewport.width}px: ${e.message}`));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForSelector(path === '/me' ? '.mcoin' : '.coin-row', { timeout: 15000 });
  await p.waitForTimeout(600);
  return { ctx, p };
}

const row = (p, ticker) => p.locator('.coin-row', { hasText: `$${ticker}` });
const chip = (p, ticker) => row(p, ticker).locator('app-burn-chip button');
const markOf = (p, ticker) => row(p, ticker).locator('app-coin-screening-badge button');
const card = (p) => p.locator('.cdk-overlay-pane .card');
const text = async (p) => (await card(p).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
// Bootstrap scrolls smoothly: a row has to arrive before the mouse is aimed at it.
const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));

/** The open card against the window and against the trigger that opened it. */
const geometry = (p) => p.evaluate(() => {
  const c = document.querySelector('.cdk-overlay-pane .card')?.getBoundingClientRect();
  const t = [...document.querySelectorAll('app-info-popover button')].find((el) => el.getAttribute('aria-expanded') === 'true')?.getBoundingClientRect();
  if (!c || !t) return null;
  const vw = document.documentElement.clientWidth;
  return {
    left: Math.round(c.left), right: Math.round(vw - c.right), top: Math.round(c.top), bottom: Math.round(innerHeight - c.bottom),
    coversTrigger: !(c.right <= t.left || c.left >= t.right || c.bottom <= t.top || c.top >= t.bottom)
  };
});

const LEAD_50 = '50% of the $MOCHI this pool buys is burned on chain during the buy.';
const NOTE = 'Each backer chose how much of their own share to burn. The rest goes to their wallets.';
const LIVE = 'It changes with every commit until the pool closes.';

// 1. A mouse and a keyboard, on an open pool.
{
  const { ctx, p } = await open('/pool', { width: 1440, height: 900 }, false);
  ok(await chip(p, 'MOCHI').count() === 1 && await chip(p, 'ZAPZ').count() === 1 && await chip(p, 'TOAD').count() === 0, 'a chip on each coin with a burn, none on the others');
  ok((await chip(p, 'MOCHI').innerText()).replace(/\s+/g, ' ').trim() === '50% BURN', 'the chip still reads 50% BURN');
  ok(await chip(p, 'MOCHI').getAttribute('aria-label') === '50% burn. What it means', 'its name for a screen reader starts with its own words');

  await center(row(p, 'MOCHI'));
  await p.waitForTimeout(200);
  const box = await chip(p, 'MOCHI').boundingBox();
  await p.mouse.move(box.x + 8, box.y + 8);
  await p.mouse.move(box.x + 400, box.y + 200);
  await p.waitForTimeout(400);
  ok(await card(p).count() === 0, 'a mouse passing over does not flash the card');
  await p.mouse.move(box.x + 8, box.y + 8);
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  const words = await text(p);
  ok(words.startsWith('50% burn') && words.includes(LEAD_50) && words.includes(NOTE), `resting on it opens the card: whose tokens and how much (${words.slice(0, 140)}…)`);
  ok(words.includes(LIVE), 'and that the share moves while the pool is open');
  ok(await card(p).locator('app-flame svg').count() === 1, 'with the flame in its title');
  await p.waitForTimeout(700);
  ok(await p.locator('.coin-chart').count() === 0, 'the price card stays down while this one is up');
  const cardBox = await card(p).boundingBox();
  await p.mouse.move(cardBox.x + 20, cardBox.y + 20, { steps: 6 });
  await p.waitForTimeout(400);
  ok(await card(p).count() === 1, 'moving into the card keeps it up');
  await p.mouse.move(cardBox.x + cardBox.width + 200, cardBox.y - 200);
  await p.waitForTimeout(500);
  ok(await card(p).count() === 0, 'and leaving both takes it down');

  await chip(p, 'MOCHI').focus();
  await p.keyboard.press('Enter');
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => document.activeElement?.classList.contains('card')), 'Enter opens the card and the focus goes into it');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  ok(await card(p).count() === 0 && await p.evaluate(() => document.activeElement?.closest('app-burn-chip') !== null), 'Escape closes it and gives the focus back to the chip');

  await center(row(p, 'ZAPZ'));
  await chip(p, 'ZAPZ').click();
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  const all = await text(p);
  ok(all.includes('All the $ZAPZ this pool buys is burned on chain during the buy.') && all.includes('Nothing goes to wallets.'), `a whole burn says so (${all.slice(0, 120)}…)`);
  await p.mouse.click(5, 300);
  await p.waitForTimeout(250);
  ok(await card(p).count() === 0, 'a click elsewhere closes a card opened by a click');
  await ctx.close();
}

// 2. Once the pool no longer takes commits, the share is fixed and the card does not say it moves.
{
  const { ctx, p } = await open('/pool', { width: 1440, height: 900 }, false, withBurns(SCENARIOS.buying));
  await center(row(p, 'MOCHI'));
  await chip(p, 'MOCHI').click();
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  const words = await text(p);
  ok(words.includes(LEAD_50) && !words.includes(LIVE), `while buying: the same words, no "changes with every commit" (${words.slice(0, 120)}…)`);
  await ctx.close();
}

// 3. Phones and a tablet: a finger; each trigger gets its own taps; nothing on top of anything.
for (const [width, height] of [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024]]) {
  const { ctx, p } = await open('/pool', { width, height }, true);
  for (const ticker of ['MOCHI', 'ZAPZ']) {
    const target = chip(p, ticker);
    await center(target);
    await p.waitForTimeout(150);
    const tb = await target.boundingBox();
    ok(tb.height >= 18, `${width}px: $${ticker}'s chip is ${Math.round(tb.width)}×${Math.round(tb.height)}, 30px tall with its margin`);
    await target.tap();
    await card(p).waitFor({ timeout: 3000 }).catch(() => {});
    const words = await text(p);
    ok(/^(50|100)% burn/.test(words), `${width}px: a tap on $${ticker}'s chip opens its card (${words.slice(0, 40)})`);
    const g = await geometry(p);
    ok(!!g && !g.coversTrigger && g.left >= 16 && g.right >= 16 && g.top >= 0 && g.bottom >= 0,
      `${width}px: the card is inside the window with 16px each side, off its chip (${JSON.stringify(g)})`);
    const overflow = await card(p).evaluate((el) => [...el.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5).length);
    ok(overflow === 0, `${width}px: nothing runs out of the card`);
    await target.tap();
    await p.waitForTimeout(250);
    ok(await card(p).count() === 0, `${width}px: a second tap on the chip closes it`);
  }

  // The coin check's mark and the burn chip sit side by side on $MOCHI's line.
  await center(row(p, 'MOCHI'));
  await p.waitForTimeout(150);
  const hits = await p.evaluate(() => {
    const line = [...document.querySelectorAll('.coin-row')].find((r) => r.textContent.includes('$MOCHI'));
    const mark = line.querySelector('app-coin-screening-badge button').getBoundingClientRect();
    const burn = line.querySelector('app-burn-chip button').getBoundingClientRect();
    const owner = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('app-burn-chip') ? 'burn' : el?.closest('app-coin-screening-badge') ? 'check' : 'other';
    };
    const midY = (r) => r.top + r.height / 2;
    return {
      sameLine: Math.abs(midY(mark) - midY(burn)) < 4,
      markEdge: owner(mark.right - 1, midY(mark)),
      burnEdge: owner(burn.left + 1, midY(burn)),
      beforeBurn: owner(burn.left - 1, midY(burn)),
      aboveBurn: owner(burn.left + burn.width / 2, burn.top - 4)
    };
  });
  ok(hits.markEdge === 'check' && hits.burnEdge === 'burn' && hits.beforeBurn !== 'burn',
    `${width}px: the mark and the chip each get their own taps, right up to their edges (${JSON.stringify(hits)})`);
  ok(hits.aboveBurn === 'burn', `${width}px: a tap just above the chip still reaches it`);
  const markBox = await markOf(p, 'MOCHI').boundingBox();
  await p.touchscreen.tap(Math.round(markBox.x + markBox.width / 2), Math.round(markBox.y + markBox.height / 2));
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  ok(/^Coin check/.test(await text(p)), `${width}px: a tap on the mark beside it opens the coin check, not the burn`);
  const up = await card(p).boundingBox();
  await p.touchscreen.tap(Math.round(width / 2), Math.round(up.y > 80 ? up.y - 40 : Math.min(up.y + up.height + 40, height - 20)));
  await p.waitForTimeout(300);
  ok(await card(p).count() === 0, `${width}px: a tap elsewhere closes it`);

  const sideways = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(sideways <= 0, `${width}px: the page does not scroll sideways (${sideways}px)`);
  await ctx.close();
}

// 4. My page: the burn I asked for, in my words.
for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true], [320, 640, true]]) {
  const { ctx, p } = await open('/me', { width, height }, mobile);
  const mine = p.locator('.mcoin app-burn-chip button').first();
  ok((await mine.innerText()).replace(/\s+/g, ' ').trim() === '25% BURN', `${width}px: my page still shows the burn I asked for`);
  if (mobile) { await mine.tap(); } else { await mine.click(); }
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  const words = await text(p);
  ok(words.includes('25% of the $TOAD bought for you is burned on chain during the buy.') && words.includes('You chose it when you committed. The rest comes to your wallet.'),
    `${width}px: the card speaks of my tokens only (${words.slice(0, 120)}…)`);
  const g = await geometry(p);
  ok(!!g && !g.coversTrigger && g.left >= 16 && g.right >= 16, `${width}px: inside the window, off its chip (${JSON.stringify(g)})`);
  await ctx.close();
}

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'BURN CHIP ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
