// The round archive: non-empty only, honest numbers, working links.
import { launch, BASE } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const iso = (ms) => new Date(Date.now() + ms).toISOString();
const round = (id, hoursAgo, coins) => ({
  id, lottery_type: 'dex', status: 'closed', lottery_pda: `Pda${id}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
  started_at: iso(-hoursAgo * 3600_000 - 7200_000), ended_at: iso(-hoursAgo * 3600_000), ended_at_source: 'end_date',
  total_pool_sol: coins.reduce((sum, c) => sum + c[1], 0),
  entries: coins.map(([ticker, sol, won], i) => ({ rank: i + 1, mint: `${ticker}mint111111111111111111111111111111`, name: `${ticker} coin`, ticker, total_solana_bet: sol, won_sol: won }))
});

const body = {
  lottery_type: 'dex',
  window_days: 30,
  items: [
    round(131, 2, [['MOCHI', 30.5, 29.6], ['TOAD', 20, 19.4], ['TINY', 0.5, 0]]),
    round(130, 9, [['ZAPZ', 12, 11.6]])
  ]
};

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
let asked = null;
await ctx.route('**/lottery/archive**', (route) => {
  asked = route.request().url();
  route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
});
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto(BASE + '/archive', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
await p.waitForSelector('.round', { timeout: 15000 });

ok(/lottery_type=dex/.test(asked ?? ''), `the page asks for its own pool type (${(asked ?? '').split('?')[1]})`);
ok(!/include_empty=true/.test(asked ?? ''), 'empty rounds are not requested');

const view = await p.evaluate(() => {
  const rounds = [...document.querySelectorAll('.round')].map((el) => ({
    id: el.querySelector('.round__id')?.textContent?.trim(),
    total: el.querySelector('.round__total')?.textContent?.replace(/\s+/g, ' ').trim(),
    coins: [...el.querySelectorAll('.crow')].map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
    link: el.querySelector('.round__link')?.getAttribute('href') ?? null,
    meta: el.querySelector('.round__meta')?.textContent?.trim()
  }));
  return { rounds, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, footerArchive: !!document.querySelector('.arch__footer') };
});

ok(view.rounds.length === 2, `both rounds are shown (${view.rounds.length})`);
ok(view.rounds[0].id === 'Pool #131', `the newest round is on top (${view.rounds[0].id})`);
ok(/51/.test(view.rounds[0].total ?? ''), `the pool total is the one that arrived (${view.rounds[0].total})`);
ok(view.rounds[0].coins.length === 3, `every coin of the round is there (${view.rounds[0].coins.length})`);
ok(/29.6 SOL of buys/.test(view.rounds[0].coins[0]), `how much went into the buying is visible (${view.rounds[0].coins[0]})`);
ok(/drawn to zero/.test(view.rounds[0].coins[2]), `a coin drawn to zero is labelled honestly (${view.rounds[0].coins[2]})`);
ok(/2 of 3 coins bought/.test(view.rounds[0].meta ?? ''), `the round summary (${view.rounds[0].meta})`);
ok((view.rounds[0].link ?? '').includes('solscan.io/account/Pda131'), `a link to the pool account (${view.rounds[0].link})`);
ok(view.overflow === 0, 'no horizontal scrolling');

// an empty history and a server error
await ctx.unroute('**/lottery/archive**');
await ctx.route('**/lottery/archive**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ lottery_type: 'dex', window_days: 30, items: [] }) }));
await p.goto(BASE + '/archive', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector('.arch__state', { timeout: 15000 });
const empty = await p.locator('.arch__state').innerText();
ok(/No finished pools yet/.test(empty), `an empty history explains itself (${empty.split('\n')[0]})`);

await ctx.unroute('**/lottery/archive**');
await ctx.route('**/lottery/archive**', (route) => route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
await p.goto(BASE + '/archive', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForSelector('.arch__state--bad', { timeout: 15000 });
ok(await p.locator('.arch__state--bad').count() === 1, 'a server failure does not look like "there were no rounds"');

// phone
const phone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.route('**/lottery/archive**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) }));
const p2 = await phone.newPage();
await p2.goto(BASE + '/archive', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p2.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
await p2.waitForSelector('.round', { timeout: 15000 });
await p2.waitForTimeout(400);
const phoneOverflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(phoneOverflow === 0, `phone: no horizontal scrolling (${phoneOverflow})`);
if (S) {
  await p2.screenshot({ path: `${S}/pw/shots/archive-phone.png`, fullPage: false });
  execSync(`sips -s format jpeg -s formatOptions 82 -Z 760 ${S}/pw/shots/archive-phone.png --out ${S}/pw/shots/archive-phone.jpg >/dev/null && rm ${S}/pw/shots/archive-phone.png`);
}
await phone.close();

// the link from the pool footer
const p3 = await ctx.newPage();
await p3.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p3.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
const fromPool = await p3.locator('.pool-footer a[href="/archive"]').count();
ok(fromPool === 1, `the pool page has a link to the archive (${fromPool})`);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'ARCHIVE ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
