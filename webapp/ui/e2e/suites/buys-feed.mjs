// The purchase feed: what is shown, where the links lead and how often we ask the server.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, mockPurchases, purchaseFeed, MINTS } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

// 1. The buying is running: the feed, the progress and the Solscan links
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  let feed = purchaseFeed();
  await mockCurrent(ctx, () => SCENARIOS.buying());
  await mockPurchases(ctx, () => feed);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  let feedCalls = 0;
  p.on('request', (r) => { if (/\/purchases/.test(r.url())) feedCalls++; });
  for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForSelector('.buy-row', { timeout: 15000 });

  const rows = await p.locator('.buy-row').count();
  ok(rows === 12, `the feed shows every buy the server sent (${rows})`);
  const href = await p.locator('.buy-row__tx').first().getAttribute('href');
  ok(/solscan\.io\/tx\/feedsig/.test(href), `each buy links to its transaction (${href})`);
  const progress = await p.locator('.pool-progress__row').innerText();
  ok(/31\.8 of 53\.35 SOL bought/.test(progress.replace(/\s+/g, ' ')), `progress is the real one, not the clock (${progress.replace(/\s+/g, ' ')})`);
  const bought = await p.locator('.pool-stats dd').nth(1).innerText();
  ok(/31\.8/.test(bought), `the card shows how much is already bought (${bought})`);
  const perCoin = await p.locator('.coin-row .bar__fill--bought').count();
  ok(perCoin >= 2, `each coin shows its own buying progress (${perCoin} bars)`);

  // SOL amounts are shown to two decimals. A live round brings fractions like
  // 0.4929, and the page used to print them as they came — next to their rounded
  // neighbours that read as a glitch.
  const longNumbers = await p.evaluate(() => {
    const text = (document.querySelector('main') || document.body).innerText;
    return (text.match(/\d+\.\d{3,}\s*SOL/gi) || []).slice(0, 5);
  });
  ok(longNumbers.length === 0, `SOL amounts are rounded to two decimals (${longNumbers.join(', ') || 'clean'})`);
  const zapz = (await p.locator('.coin-row', { hasText: 'ZAPZ' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok(/0\.01 bought/i.test(zapz) && !/0\.0123/.test(zapz), `a tiny bought amount is shortened, not printed raw (${zapz.slice(0, 80)})`);

  // a new purchase arrives in the feed by itself
  feed = purchaseFeed({
    bought_sol: 33.2,
    completed_purchases: 26,
    purchases: [
      { mint: MINTS.zapz, name: 'Zapz', symbol: 'ZAPZ', logo_url: null, sol_amount: 1.4, signature: 'freshsig999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', venue: 'pumpfun', at: new Date().toISOString() },
      ...purchaseFeed().purchases
    ]
  });
  const appeared = await p.waitForFunction(
    () => !!document.body.innerText.includes('$ZAPZ'),
    null,
    { timeout: 45000 }
  ).then(() => true).catch(() => false);
  ok(appeared, 'a new buy shows up without reloading the page');

  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 2. The poll rate: rare purchases mean rare requests
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, () => SCENARIOS.buying());
  // four purchases an hour: there is no point expecting a new one sooner than a quarter of an hour
  await mockPurchases(ctx, () => purchaseFeed({ planned_purchases: 4, completed_purchases: 1, coins: [], purchases: [] }));
  const p = await ctx.newPage();
  let calls = 0;
  p.on('request', (r) => { if (/\/purchases/.test(r.url())) calls++; });
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  calls = 0;
  await p.waitForTimeout(40000);
  ok(calls <= 2, `a slow pool is polled slowly: ${calls} feed requests in 40s`);
  await ctx.close();
}

// 3. The buyer is silent: we wait rather than show zero
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, () => SCENARIOS.buying());
  await mockPurchases(ctx, () => ({ lottery_id: 128, available: false, target_sol: 0, bought_sol: 0, completed_purchases: 0, planned_purchases: 0, finished: false, coins: [], purchases: [] }));
  const p = await ctx.newPage();
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1500);
  const empty = await p.locator('.pool-empty__title').last().innerText();
  ok(/First buys are on the way/.test(empty), `waiting state instead of a zero (${empty})`);
  const progress = await p.locator('.pool-progress__row').innerText();
  ok(/Buy window/.test(progress), `until the buyer speaks the bar shows the window (${progress.replace(/\s+/g, ' ')})`);
  await ctx.close();
}

// 4. Phone: the feed does not break the layout
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mockCurrent(ctx, () => SCENARIOS.buying());
  await mockPurchases(ctx, () => purchaseFeed());
  const p = await ctx.newPage();
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForSelector('.buy-row', { timeout: 15000 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow === 0, `phone: no horizontal scroll (${overflow})`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'BUYS FEED ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
