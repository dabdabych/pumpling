// The pool page's transactions feed at every window: nothing out of place, nothing
// on top of anything.
//
// The feed became one component, `app-tx-feed`, shared with the archive
// (2026-10-05). Checking it there showed what was already true on the pool page:
// on a phone a ticker like $PUMPLING ran out of its cell into the amount, and in
// a narrow card the chip lay on the transaction link. Below 360px of feed the
// rows now take three lines. This walks the page in both phases that show the
// feed, with every kind of row and long tickers, down to a 320px phone.
import { launch, BASE } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';
import { FEED_SIZES, feedLayoutIssues } from '../lib/feed-layout.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const cors = { 'access-control-allow-origin': '*' };
const ME = 'Me11111111111111111111111111111111111111111';
const LONG = [
  { mint: 'PumpLing111111111111111111111111111111pump', name: 'pumpling', symbol: 'PUMPLING' },
  { mint: 'SuperInuXX11111111111111111111111111111111', name: 'Super Inu Extra', symbol: 'SUPERINUXX' }
];
const at = (ms) => new Date(Date.now() - ms).toISOString();
const sig = (k, i) => `${k}x${i}`.padEnd(87, 'a');

const feed = (finished) => ({
  lottery_id: 128, available: true, target_sol: 20.37, bought_sol: 12.4, completed_purchases: 9, planned_purchases: 24,
  finished, phase: finished ? 'finished' : 'buying', fallback_ends_at: null,
  coins: LONG.map((c) => ({ ...c, logo_url: null, target_sol: 10, bought_sol: 6, completed_purchases: 4, planned_purchases: 12, status: 'in_progress', decimals: 6 })),
  purchases: Array.from({ length: 8 }, (_, i) => ({ ...LONG[i % 2], logo_url: null, sol_amount: 0.4352, signature: sig('buy', i), venue: i % 3 ? 'pumpfun' : 'dex', at: at(i * 95_000 + 30_000) })),
  deliveries: [
    { ...LONG[0], logo_url: null, signature: sig('send', 0), raw_amount: '7339618392727', decimals: 6, recipients: ['A1111111111111111111111111111111111111111', 'B1111111111111111111111111111111111111111', 'C1111111111111111111111111111111111111111'], at: at(60_000) },
    { ...LONG[1], logo_url: null, signature: sig('send', 1), raw_amount: '812000000', decimals: 6, recipients: [ME, 'B1111111111111111111111111111111111111111'], at: at(150_000) }
  ],
  burns: [{ ...LONG[0], logo_url: null, signature: sig('burn', 0), raw_amount: '7339618392727', decimals: 6, at: at(120_000) }],
  refunds: [{ ...LONG[0], logo_url: null, signature: sig('refund', 0), sol_amount: 0.0096, recipients: [ME], at: at(200_000) }]
});
const myCommits = { total_sol: 1, rounds: [{ lottery_id: 128, lottery_type: 'dex', status: 'proceeding_purchases', created_at: at(3600_000), end_date: at(1800_000), my_sol: 1, pool_sol: 64.5, wallets: [ME], coins: [] }] };

const problems = [];
for (const phase of ['buying', 'done']) {
  for (const [width, height] of FEED_SIZES) {
    const ctx = await b.newContext({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
    await mockCurrent(ctx, SCENARIOS[phase]);
    await ctx.route('**/lottery/*/purchases', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(feed(phase === 'done')) }));
    await ctx.route('**/lottery/my/commits', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(myCommits) }));
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    for (let a = 0; a < 3; a++) {
      try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
      catch (e) { if (a === 2) throw e; }
    }
    await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
    await p.waitForSelector('.pool-buys .buy-row', { timeout: 20000 });
    await p.locator('.pool-buys').scrollIntoViewIfNeeded();
    await p.waitForTimeout(700);
    const found = await feedLayoutIssues(p, '.pool-buys');
    const rows = await p.locator('.pool-buys .buy-row').count();
    if (rows !== 12) found.push(`${rows} rows instead of 12`);
    if (errors.length) found.push(`page errors: ${errors.join(' | ')}`);
    if (found.length) problems.push(`${phase} ${width}x${height}: ${found.slice(0, 4).join('; ')}`);
    console.log(`     ${phase} ${width}x${height}: ${found.length ? found.length + ' problem(s)' : 'clean'}`);
    await ctx.close();
  }
}
ok(problems.length === 0, `the feed fits at every size in both phases, nothing on top of anything (${problems.length} with problems)${problems.length ? '\n     ' + problems.join('\n     ') : ''}`);

console.log(fails ? `${fails} FAILED` : 'TX FEED LAYOUT ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
