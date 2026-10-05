// The archive: each past pool opens to its transactions.
//
// Until 2026-10-05 a finished round in the archive showed its coins and its
// totals, and the transactions behind them (every purchase, delivery, burn and
// refund) could be seen only on the pool page, and only until the next round
// opened. Each round now has a bar that opens the same feed, asked for once.
// What this checks: the bar and its state, the first opening asking and the
// next not, the four kinds of row, the clock in place of "2 min ago", a round
// with nothing recorded, a failed request and its retry, a capped feed, the
// keyboard, and at every window a person is likely to have, that nothing in an
// open round runs out of its card or lies on top of anything else.
import { launch, BASE } from '../lib/browser.mjs';
import { FEED_SIZES, feedLayoutIssues } from '../lib/feed-layout.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const cors = { 'access-control-allow-origin': '*' };
const ME = 'Me11111111111111111111111111111111111111111';
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const sig = (kind, round, i) => `${kind}${round}x${i}`.padEnd(87, 'a');
const COINS = [
  { mint: 'PumpLing111111111111111111111111111111pump', name: 'pumpling', symbol: 'PUMPLING' },
  { mint: 'SuperInu1111111111111111111111111111111111', name: 'Super Inu', symbol: 'SI' }
];
const coinOf = (i) => COINS[i % COINS.length];

/** A finished round's feed, as `/lottery/{id}/purchases` sends it. */
function feed(round, { buys = 0, sends = 0, burns = 0, refunds = 0, mine = false } = {}) {
  const ended = -2 * 3600_000;
  const at = (i, n) => iso(ended - 50 * 60_000 + (i / Math.max(1, n)) * 50 * 60_000);
  return {
    lottery_id: round, available: true, target_sol: 20.37, bought_sol: 20.35, completed_purchases: buys, planned_purchases: buys,
    finished: true, phase: 'finished', fallback_ends_at: null,
    coins: COINS.map((c) => ({ ...c, logo_url: null, target_sol: 10, bought_sol: 10, completed_purchases: 1, planned_purchases: 1, status: 'completed', decimals: 6 })),
    purchases: Array.from({ length: buys }, (_, i) => ({ ...coinOf(i), logo_url: null, sol_amount: 0.38 + (i % 7) * 0.01, signature: sig('buy', round, i), venue: i % 9 === 0 ? 'dex' : 'pumpfun', at: at(i, buys) })),
    deliveries: Array.from({ length: sends }, (_, i) => ({ ...coinOf(i), logo_url: null, signature: sig('send', round, i), raw_amount: String(7_000_000_000_000 + i * 31_000_000), decimals: 6,
      recipients: i === 0 && mine ? [ME] : ['A1111111111111111111111111111111111111111', 'B1111111111111111111111111111111111111111'], at: at(i, sends) })),
    burns: Array.from({ length: burns }, (_, i) => ({ ...coinOf(0), logo_url: null, signature: sig('burn', round, i), raw_amount: String(8_000_000_000_000 + i), decimals: 6, at: at(i, burns) })),
    refunds: Array.from({ length: refunds }, (_, i) => ({ ...coinOf(0), logo_url: null, signature: sig('refund', round, i), sol_amount: 0.0096, recipients: mine ? [ME] : ['A1111111111111111111111111111111111111111'], at: iso(ended) }))
  };
}

const round = (id, hoursAgo, coins) => ({
  id, lottery_type: 'dex', status: 'closed', lottery_pda: `Pda${id}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
  started_at: iso(-hoursAgo * 3600_000 - 7200_000), ended_at: iso(-hoursAgo * 3600_000), ended_at_source: 'end_date',
  total_pool_sol: coins.reduce((sum, c) => sum + c[1], 0),
  entries: coins.map(([ticker, sol, won], i) => ({ rank: i + 1, mint: `${ticker}mint111111111111111111111111111111`, name: `${ticker} coin`, ticker, total_solana_bet: sol, won_sol: won }))
});
const archive = {
  lottery_type: 'dex', window_days: 30,
  items: [
    round(201, 2, [['PUMPLING', 20, 19.69], ['SI', 1, 0.68]]),
    round(202, 4, [['FINGEX', 0.1, 0.09], ['NANA', 0.09, 0.09]]),
    round(203, 6, [['ZAPZ', 0.2, 0.19]]),
    round(204, 8, [['TOAD', 0.5, 0.48]]),
    round(205, 10, [['MOCHI', 60, 58.2]])
  ]
};
const feeds = {
  201: () => feed(201, { buys: 52, sends: 11, burns: 10, refunds: 1, mine: true }),
  202: () => feed(202, { buys: 2, sends: 2, burns: 1 }),
  203: () => ({ lottery_id: 203, available: false, coins: [], purchases: [] }),
  205: () => feed(205, { buys: 200, sends: 40, burns: 10 })
};
const myCommits = { total_sol: 20, rounds: [{ lottery_id: 201, lottery_type: 'dex', status: 'closed', created_at: iso(-4 * 3600_000), end_date: iso(-3 * 3600_000),
  my_sol: 20, pool_sol: 21, wallets: [ME], coins: [] }] };

async function page(viewport) {
  const ctx = await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const asked = {};
  let failOnce = true;
  await ctx.route('**/lottery/archive**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(archive) }));
  await ctx.route('**/lottery/my/commits', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(myCommits) }));
  await ctx.route('**/lottery/*/purchases', (route) => {
    const id = Number(route.request().url().match(/lottery\/(\d+)\/purchases/)[1]);
    asked[id] = (asked[id] ?? 0) + 1;
    if (id === 204 && failOnce) {
      failOnce = false;
      return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{}' });
    }
    const body = id === 204 ? feed(204, { buys: 3, sends: 1 }) : feeds[id]();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/archive', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.round', { timeout: 15000 });
  return { ctx, p, asked, errors };
}

/** Angular redraws on the next frame after an event: wait for the state, do not read it at once. */
async function settles(read, expected, timeout = 3000) {
  const until = Date.now() + timeout;
  let value = await read();
  while (value !== expected && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value === expected;
}

const card = (p, id) => p.locator('.round').filter({ has: p.locator('.round__id', { hasText: `Pool #${id}` }) });
const toggle = (p, id) => card(p, id).locator('.round__toggle');
async function openRound(p, id) {
  await toggle(p, id).click();
  await card(p, id).locator('.round__tx .buy-row, .round__tx .round__tx-state').first().waitFor({ timeout: 10000 });
}

// ----------------------------------------------------------- behaviour
{
  const { ctx, p, asked, errors } = await page({ width: 1440, height: 900 });

  const closed = await p.evaluate(() => [...document.querySelectorAll('.round')].map((r) => ({
    expanded: r.querySelector('.round__toggle')?.getAttribute('aria-expanded'),
    controls: r.querySelector('.round__toggle')?.getAttribute('aria-controls'),
    panel: !!r.querySelector('.round__tx')
  })));
  ok(closed.length === 5 && closed.every((r) => r.expanded === 'false'), `every round has a closed Transactions bar (${closed.map((r) => r.expanded).join(',')})`);
  ok(closed.every((r) => !r.panel && r.controls === null), 'nothing is open and nothing controls a missing panel');
  ok(Object.keys(asked).length === 0, `opening the archive asks for no transactions (${JSON.stringify(asked)})`);

  await openRound(p, 201);
  const big = await card(p, 201).evaluate((el) => {
    const bar = el.querySelector('.round__toggle');
    const panel = el.querySelector('.round__tx');
    const feed = el.querySelector('.buy-feed');
    const rows = [...el.querySelectorAll('.buy-row')];
    return {
      expanded: bar.getAttribute('aria-expanded'),
      controls: bar.getAttribute('aria-controls'),
      panelId: panel?.id,
      labelled: panel?.getAttribute('aria-labelledby'),
      title: document.getElementById(panel?.getAttribute('aria-labelledby') ?? '')?.textContent?.trim(),
      feedLabelled: feed?.getAttribute('aria-labelledby'),
      summary: el.querySelector('.round__tx-summary')?.textContent?.trim(),
      rows: rows.length,
      kinds: {
        buy: rows.filter((r) => !/buy-row--(send|burn|refund)/.test(r.className)).length,
        send: el.querySelectorAll('.buy-row--send').length,
        burn: el.querySelectorAll('.buy-row--burn').length,
        refund: el.querySelectorAll('.buy-row--refund').length
      },
      times: rows.slice(0, 5).map((r) => r.querySelector('.buy-row__when')?.textContent?.trim()),
      hrefs: rows.slice(0, 3).map((r) => r.querySelector('.buy-row__tx')?.getAttribute('href')),
      toYou: el.textContent.includes('to you'),
      scrolls: feed.scrollHeight > feed.clientHeight + 8,
      thumb: !!el.querySelector('.buy-rail__thumb'),
      note: el.querySelector('.round__tx-note')?.textContent?.trim() ?? null
    };
  });
  ok(big.expanded === 'true' && big.controls === 'round-tx-201' && big.panelId === 'round-tx-201', `the bar opens the round and points at its panel (${big.expanded}, ${big.controls})`);
  ok(big.title === 'Transactions of pool #201' && big.feedLabelled === big.labelled, `the panel and its feed are named for a screen reader (${big.title})`);
  ok(big.summary === '52 buys · 11 deliveries · 10 burns · 1 refund', `the line above counts each kind (${big.summary})`);
  ok(big.rows === 74, `every transaction is a row (${big.rows} of 74)`);
  ok(big.kinds.buy === 52 && big.kinds.send === 11 && big.kinds.burn === 10 && big.kinds.refund === 1, `purchases, deliveries, burns and the refund (${JSON.stringify(big.kinds)})`);
  ok(big.times.every((t) => /^\d{2}:\d{2}$/.test(t ?? '')), `a finished round tells the clock, not "ago" (${big.times.join(' ')})`);
  ok(big.hrefs.every((h) => /^https:\/\/solscan\.io\/tx\/(buy|send|burn|refund)201x/.test(h ?? '')), `each row links to its transaction (${(big.hrefs[0] ?? '').slice(0, 44)})`);
  ok(big.toYou, 'a delivery to my own wallet says "to you", as on the pool page');
  ok(big.scrolls && big.thumb, 'a long round scrolls inside its own window, with the drawn bar');
  ok(big.note === null, 'no cap note under 200 rows');
  ok(asked[201] === 1, `opened once, asked once (${asked[201]})`);

  // a second round opens beside it
  await openRound(p, 202);
  const both = await p.evaluate(() => [...document.querySelectorAll('.round__tx')].map((el) => el.id));
  ok(both.length === 2 && both.includes('round-tx-201') && both.includes('round-tx-202'), `any number of rounds can be open (${both.join(', ')})`);
  ok(await card(p, 202).locator('.buy-row').count() === 5, 'the small round shows its five transactions');

  // closing and opening again asks nothing
  await toggle(p, 201).click();
  const shut = await settles(() => toggle(p, 201).getAttribute('aria-expanded'), 'false');
  ok(shut && await card(p, 201).locator('.round__tx').count() === 0, 'the bar closes its round');
  await openRound(p, 201);
  ok(await card(p, 201).locator('.buy-row').count() === 74 && asked[201] === 1, `opened again, the rows come back without a second request (${asked[201]})`);

  // nothing recorded
  await openRound(p, 203);
  const none = await card(p, 203).locator('.round__tx-state').innerText();
  ok(/No transactions were recorded/.test(none), `a round with no record says so (${none})`);

  // a failed request, then a retry
  await openRound(p, 204);
  const bad = card(p, 204).locator('.round__tx-state--bad');
  ok(await bad.count() === 1 && await bad.getAttribute('role') === 'alert', 'a failed request is said, not shown as an empty round');
  await bad.locator('.round__retry').click();
  await card(p, 204).locator('.buy-row').first().waitFor({ timeout: 10000 });
  ok(await card(p, 204).locator('.buy-row').count() === 4 && asked[204] === 2, `"Try again" asks again and shows the rows (${asked[204]} requests)`);

  // a capped feed
  await openRound(p, 205);
  const capped = await card(p, 205).evaluate((el) => ({ rows: el.querySelectorAll('.buy-row').length, note: el.querySelector('.round__tx-note')?.textContent?.trim() }));
  ok(capped.rows === 200 && capped.note === 'The latest 200 of 250 transactions.', `past 200 rows it says how many there were (${capped.rows}, ${capped.note})`);

  // the keyboard
  await toggle(p, 202).focus();
  await p.keyboard.press('Enter');
  ok(await settles(() => toggle(p, 202).getAttribute('aria-expanded'), 'false'), 'Enter on the bar closes it');
  await p.keyboard.press('Space');
  ok(await settles(() => toggle(p, 202).getAttribute('aria-expanded'), 'true'), 'Space opens it again');
  ok(await settles(async () => (await card(p, 202).locator('.buy-row').count()) === 5, true), 'and its rows are back');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ----------------------------------------------------------- at every window
const problems = [];
for (const [width, height] of FEED_SIZES) {
  const { ctx, p, errors } = await page({ width, height });
  await openRound(p, 201);
  await openRound(p, 202);
  await p.waitForTimeout(400);
  const found = await feedLayoutIssues(p, '.round');
  // The bar itself: its words fit, the label and the hint apart.
  found.push(...await p.evaluate(() => {
    const issues = [];
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    for (const round of document.querySelectorAll('.round')) {
      const id = round.querySelector('.round__id')?.textContent?.trim();
      const bar = round.querySelector('.round__toggle');
      if (bar.scrollWidth > bar.clientWidth + 1) issues.push(`${id}: the bar's text overflows`);
      if (overlap(bar.querySelector('.round__toggle-label').getBoundingClientRect(), bar.querySelector('.round__toggle-hint').getBoundingClientRect()) > 1) issues.push(`${id}: the bar's label and hint overlap`);
      const panel = round.querySelector('.round__tx');
      const r = round.getBoundingClientRect();
      if (panel) {
        const pb = panel.getBoundingClientRect();
        if (pb.left < r.left - 1 || pb.right > r.right + 1) issues.push(`${id}: the panel runs out of its card`);
      }
    }
    return issues;
  }));
  if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
  if (found.length) problems.push(`${width}x${height}: ${found.slice(0, 4).join('; ')}`);
  console.log(`     ${width}x${height}: ${found.length ? found.length + ' problem(s)' : 'clean'}`);
  await ctx.close();
}
ok(problems.length === 0, `an open round fits at every size, nothing on top of anything (${problems.length} sizes with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

console.log(fails ? `${fails} FAILED` : 'ARCHIVE TRANSACTIONS ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
