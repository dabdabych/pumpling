// The burn outside the dialog: the coin row's chip, the feed of everything the
// round does on chain, and your own page.
//
// On the code before the burn this fails at once: no chip, a feed of purchases
// only under the old title, nothing about deliveries or burns.
import { launch, BASE } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { MINTS, SCENARIOS, entries, five, mockCurrent, purchaseFeed } from '../lib/pool-mock.mjs';

const S = process.env.S;
const cors = { 'access-control-allow-origin': '*' };
const ME = 'Wa11etOne111111111111111111111111111111111';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** The open pool with burn shares on two coins. */
const openWithBurns = () => {
  const body = SCENARIOS.open();
  body.entries = entries(five).map((entry) => ({
    ...entry,
    burn_bps_avg: entry.coin.symbol === 'MOCHI' ? 5000 : entry.coin.symbol === 'ZAPZ' ? 10000 : 0
  }));
  return body;
};

/** The buying feed with deliveries and burns mixed into the purchases. */
const feedWithTransfers = () => {
  const now = Date.now();
  const base = purchaseFeed();
  base.coins = base.coins.map((coin) => ({ ...coin, decimals: 6, burn_bps: coin.symbol === 'MOCHI' ? 5000 : 0 }));
  return {
    ...base,
    deliveries: [
      { mint: MINTS.mochi, name: 'Mochi', symbol: 'MOCHI', logo_url: null, signature: 'sendsig1kQeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaw2Pz', raw_amount: '4100000000000', decimals: 6,
        recipients: ['A1111111111111111111111111111111111111111', 'B1111111111111111111111111111111111111111', 'C1111111111111111111111111111111111111111', 'D1111111111111111111111111111111111111111', 'E1111111111111111111111111111111111111111'],
        at: new Date(now - 60_000).toISOString() },
      { mint: MINTS.toad, name: 'Toad Signal', symbol: 'TOAD', logo_url: null, signature: 'sendsig2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', raw_amount: '812000000', decimals: 6,
        recipients: [ME, 'B1111111111111111111111111111111111111111'], at: new Date(now - 150_000).toISOString() }
    ],
    burns: [
      { mint: MINTS.mochi, name: 'Mochi', symbol: 'MOCHI', logo_url: null, signature: 'burnsig1rNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7Q', raw_amount: '5200000000000', decimals: 6,
        at: new Date(now - 120_000).toISOString() }
    ],
    // The SOL the buying could not spend, going back to me.
    refunds: [
      { mint: MINTS.toad, name: 'Toad Signal', symbol: 'TOAD', logo_url: null, signature: 'refundsig1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sol_amount: 0.4825,
        recipients: [ME], at: new Date(now - 200_000).toISOString() }
    ]
  };
};

const myCommits = {
  total_sol: 1.2,
  rounds: [{
    lottery_id: 128, lottery_type: 'dex', status: 'proceeding_purchases',
    created_at: new Date(Date.now() - 3600_000).toISOString(), end_date: new Date(Date.now() - 1800_000).toISOString(),
    my_sol: 1.2, pool_sol: 64.5, wallets: [ME],
    coins: [{ mint: MINTS.toad, name: 'Toad Signal', ticker: 'TOAD', logo_url: null, my_sol: 1.2, my_commits: 1, pool_sol: 20, drawn_sol: 19.4, signatures: [], burn_bps: 2500 }]
  }]
};

const page = async ({ width, height, mobile = false, scenario, feed }) => {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, scenario);
  await ctx.route('**/lottery/*/purchases', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(feed ? feed() : { available: false, coins: [], purchases: [] }) }));
  await ctx.route('**/lottery/my/commits', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(myCommits) }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1300);
  return { ctx, p, errors };
};

const shot = async (p, selector, name) => {
  if (!S) return;
  await p.locator(selector).first().screenshot({ path: `${S}/pw/shots/${name}.png` });
  execSync(`sips -s format jpeg -s formatOptions 80 -Z 900 ${S}/pw/shots/${name}.png --out ${S}/pw/shots/${name}.jpg >/dev/null && rm ${S}/pw/shots/${name}.png`);
};

// 1. The coin rows: a chip for a coin with a burn, none for one without; the row keeps its height.
for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true], [320, 640, true]]) {
  const { ctx, p, errors } = await page({ width, height, mobile, scenario: openWithBurns });
  const rows = await p.evaluate(() => [...document.querySelectorAll('.coin-row:not(.coin-row--skeleton)')].map((row) => ({
    ticker: row.querySelector('.coin-row__ticker')?.textContent?.trim(),
    chip: row.querySelector('.coin-row__burn')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    flame: !!row.querySelector('.coin-row__burn app-flame svg'),
    chipInside: (() => {
      const chip = row.querySelector('.coin-row__burn');
      if (!chip) return true;
      const a = chip.getBoundingClientRect(); const r = row.getBoundingClientRect();
      return a.left >= r.left && a.right <= r.right;
    })()
  })));
  const mochi = rows.find((r) => r.ticker === '$MOCHI');
  const zapz = rows.find((r) => r.ticker === '$ZAPZ');
  const toad = rows.find((r) => r.ticker === '$TOAD');
  ok(mochi?.chip === '50% BURN' && mochi.flame, `${width}px: $MOCHI carries its burn (${mochi?.chip})`);
  ok(zapz?.chip === '100% BURN', `${width}px: $ZAPZ carries its burn (${zapz?.chip})`);
  ok(toad && toad.chip === null, `${width}px: a coin nobody burns has no chip`);
  ok(rows.every((r) => r.chipInside), `${width}px: every chip stays inside its row`);
  ok(!(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `${width}px: no sideways scroll`);
  ok(errors.length === 0, `${width}px: no page errors ${errors.join(' | ')}`);
  if (width === 390) await shot(p, '.coin-row:not(.coin-row--skeleton)', 'burn-row-390');
  await ctx.close();
}

// 2. The feed: purchases, deliveries and burns, newest first, told apart at a glance.
for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true], [320, 640, true]]) {
  const { ctx, p, errors } = await page({ width, height, mobile, scenario: SCENARIOS.buying, feed: feedWithTransfers });
  await p.locator('.pool-buys').scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  const feed = await p.evaluate(() => ({
    title: document.querySelector('#pool-buys-title')?.textContent?.trim(),
    count: document.querySelector('.pool-buys .pool-coins__count')?.textContent?.trim(),
    rows: [...document.querySelectorAll('.buy-row')].slice(0, 8).map((row) => ({
      kind: row.classList.contains('buy-row--send') ? 'send' : row.classList.contains('buy-row--burn') ? 'burn' : row.classList.contains('buy-row--refund') ? 'refund' : 'buy',
      amount: row.querySelector('.buy-row__sol')?.innerText?.replace(/\s+/g, ' ').trim(),
      chip: row.querySelector('.buy-row__venue')?.innerText?.replace(/\s+/g, ' ').trim(),
      chipOneLine: (() => { const c = row.querySelector('.buy-row__venue'); if (!c) return true; const lh = parseFloat(getComputedStyle(c).lineHeight) || 16; return c.getBoundingClientRect().height < lh * 2 + 8; })(),
      bg: getComputedStyle(row).backgroundColor,
      href: row.querySelector('.buy-row__tx')?.getAttribute('href'),
      fits: row.scrollWidth <= row.clientWidth + 1
    }))
  }));
  ok(feed.title === 'On Solana', `${width}px: the feed is "On Solana" now (${feed.title})`);
  ok(feed.count === '25 of 40 buys', `${width}px: the counter still counts buys only (${feed.count})`);
  const kinds = feed.rows.map((r) => r.kind).join(',');
  // Buys every 95s from now, deliveries 60s and 150s ago, the burn 120s ago, the refund 200s ago.
  ok(kinds === 'buy,send,buy,burn,send,buy,refund,buy', `${width}px: all four kinds, by time (${kinds})`);
  const send = feed.rows.find((r) => r.kind === 'send');
  const burn = feed.rows.find((r) => r.kind === 'burn');
  const buy = feed.rows.find((r) => r.kind === 'buy');
  const refund = feed.rows.find((r) => r.kind === 'refund');
  ok(/0\.48\d* SOL/.test(refund?.amount ?? '') && /RETURNED/.test(refund?.chip ?? ''), `${width}px: the refund shows the SOL and says RETURNED (${refund?.amount} / ${refund?.chip})`);
  ok(refund?.chip === 'RETURNED' && /to you$/.test(refund?.amount ?? ''), `${width}px: and says it came to me, on one line (${refund?.amount} / ${refund?.chip})`);
  ok(refund?.chipOneLine, `${width}px: the refund chip stays on one line`);
  ok(/solscan\.io\/tx\/refundsig1/.test(refund?.href ?? ''), `${width}px: the refund opens its transaction`);
  ok(refund?.bg !== buy?.bg && refund?.bg !== send?.bg && refund?.bg !== burn?.bg, `${width}px: the refund has its own backing (${refund?.bg})`);
  ok(/4\.1M/.test(send?.amount ?? ''), `${width}px: a delivery shows the tokens it moved (${send?.amount})`);
  ok(/5\.2M/.test(burn?.amount ?? '') && burn?.chip === 'BURNED', `${width}px: a burn shows its tokens and says BURNED (${burn?.amount} / ${burn?.chip})`);
  ok(send?.bg !== buy?.bg && burn?.bg !== buy?.bg && send?.bg !== burn?.bg, `${width}px: the three backings differ (${buy?.bg} / ${send?.bg} / ${burn?.bg})`);
  if (!mobile) {
    ok(/to 5 wallets/.test(send?.amount ?? '') && send?.chip === 'SENT', `desktop: "to 5 wallets" beside the amount, SENT in the chip (${send?.amount} / ${send?.chip})`);
  } else {
    ok(!/wallets/.test(send?.amount ?? '') && send?.chip === 'SENT TO 5', `${width}px: the recipients move into the chip, short (${send?.amount} / ${send?.chip})`);
  }
  ok(/solscan\.io\/tx\/sendsig1/.test(send?.href ?? '') && /solscan\.io\/tx\/burnsig1/.test(burn?.href ?? ''), `${width}px: each row opens its own transaction`);
  ok(feed.rows.every((r) => r.fits), `${width}px: no row overflows`);
  ok(errors.length === 0, `${width}px: no page errors ${errors.join(' | ')}`);
  if (width !== 320) await shot(p, '.buy-window', `burn-feed-${width}`);
  await ctx.close();
}

// 3. A delivery that reached me says so.
{
  const { ctx, p } = await page({ width: 1440, height: 900, scenario: SCENARIOS.buying, feed: feedWithTransfers });
  await p.locator('.pool-buys').scrollIntoViewIfNeeded();
  const toMe = await p.evaluate(() => [...document.querySelectorAll('.buy-row--send .buy-row__to')].map((n) => n.textContent.trim()));
  ok(toMe.includes('to you + 1'), `my own delivery reads "to you + 1" (${toMe.join(' | ')})`);
  await ctx.close();
}

// 4. My page: the burn I asked for, on my coin.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/lottery/my/commits', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(myCommits) }));
  const p = await ctx.newPage();
  await p.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.mcoin', { timeout: 15000 });
  const chip = await p.locator('.mcoin__burn').first().innerText().catch(() => '');
  ok(chip.replace(/\s+/g, ' ').trim() === '25% BURN', `my page shows the burn I asked for (${chip})`);
  await ctx.close();
}

await b.close();
console.log(fails ? `\nBURN FEED: ${fails} FAILED` : '\nBURN FEED ALL PASSED');
process.exit(fails ? 1 : 0);
