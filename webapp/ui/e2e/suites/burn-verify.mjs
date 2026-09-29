// "Verify this pool": the burn section. What was asked for, what burned, how far
// the fuse has run, whether the supply agrees, and where each burn is on chain.
//
// On the code before the burn this fails at once: the section does not exist.
import { launch, BASE } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const S = process.env.S;
const cors = { 'access-control-allow-origin': '*' };
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const burn = (over = {}) => ({
  mint: '56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump', name: 'CMC', symbol: 'CMC', decimals: 6,
  coin_sol: 10.45, burn_bps: 9569.38,
  bets: [
    { wallet: 'PrpNxdeSX8SwyUNv4H2pA7aZ6PRYzfAyEPPogCgCDnQ', sol: 10, burn_bps: 10000, signature: 'commit1' }
  ],
  bought_raw: '54668000000000', owed_raw: '52313440000000', burned_raw: '52313440000000',
  supply_at_start: '1000000000000000', supply_at_end: '947686560000000',
  blocked_reason: null,
  transactions: [
    { signature: '3pbWaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaafA5Q', raw_amount: '18204112000000', at: '2026-09-25T16:31:00Z' },
    { signature: '5ZkLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaar7wd', raw_amount: '17066905000000', at: '2026-09-25T16:36:00Z' },
    { signature: '2Hqmaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9aTe', raw_amount: '17042423000000', at: '2026-09-25T16:41:00Z' }
  ],
  final: true,
  ...over
});

const proof = (burns) => ({
  lottery_id: 128, lottery_type: 'dex', status: 'proceeding_purchases', network: 'devnet',
  program_id: '4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH', lottery_account: '6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9',
  vault_account: null, admin_account: null, weights_hash_onchain: 'ab'.repeat(32), weights_payload: '[["x",1]]',
  weights_hash_recomputed: 'ab'.repeat(32), weights_match: true, randomness_source: 'vrf', randomness_account: null,
  vrf_seed: 'cd'.repeat(32), vrf_algorithm_hash: 'ef'.repeat(32), algorithm_source: 'x', winner_results: [], burns
});

const open = async ({ width, height, mobile = false, body }) => {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, () => SCENARIOS.buying());
  let asked = 0;
  await ctx.route('**/lottery/*/verification', (route) => { asked++; return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) }); });
  await ctx.route('**/lottery/*/purchases**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ available: false, coins: [], purchases: [] }) }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(900);
  await p.locator('.pool-proof__verify').click();
  await p.waitForSelector('.verify-burn', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(500);
  return { ctx, p, errors, asked: () => asked };
};

const read = (p) => p.evaluate(() => {
  const section = document.querySelector('.verify-burn');
  if (!section) return null;
  const text = (sel) => section.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const visible = (sel) => { const n = section.querySelector(sel); return !!n && getComputedStyle(n).display !== 'none'; };
  const fuse = section.querySelector('.verify-burn__fuse')?.getBoundingClientRect();
  const fill = section.querySelector('.verify-burn__fill')?.getBoundingClientRect();
  const spark = section.querySelector('.verify-burn__spark')?.getBoundingClientRect();
  const verdict = section.querySelector('.verify__verdict');
  return {
    exact: text('.verify-burn__exact'), compact: text('.verify-burn__compact'),
    exactShown: visible('.verify-burn__exact'), compactShown: visible('.verify-burn__compact'),
    ticker: text('.verify-burn__ticker'), caption: text('.verify-burn__caption'),
    fill: fuse && fill ? Math.round((fill.width / (fuse.width - 4)) * 100) : null,
    sparkInside: fuse && spark ? spark.left >= fuse.left - 1 && spark.right <= fuse.right + 1 : null,
    legend: text('.verify-burn__legend'),
    verdict: verdict?.textContent?.replace(/\s+/g, ' ').trim(),
    verdictOk: verdict?.classList.contains('verify__verdict--ok'), verdictBad: verdict?.classList.contains('verify__verdict--bad'),
    supply: text('.verify-burn__supply'),
    who: [...section.querySelectorAll('.verify-burn__who tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' ')),
    txs: [...section.querySelectorAll('.verify-burn__txs li')].map((li) => [...li.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' ')),
    links: [...section.querySelectorAll('.verify-burn__txs a')].map((a) => a.getAttribute('href')),
    overflow: document.querySelector('.verify').scrollWidth > document.querySelector('.verify').clientWidth + 1
  };
});

const shot = async (p, name) => {
  if (!S) return;
  await p.locator('.verify-burn').screenshot({ path: `${S}/pw/shots/${name}.png` });
  execSync(`sips -s format jpeg -s formatOptions 80 -Z 900 ${S}/pw/shots/${name}.png --out ${S}/pw/shots/${name}.jpg >/dev/null && rm ${S}/pw/shots/${name}.png`);
};

// 1. Finished: everything asked for burned, the supply down by exactly that.
{
  const { ctx, p, errors } = await open({ width: 1440, height: 1000, body: proof([burn()]) });
  const v = await read(p);
  ok(v !== null, 'the window has a burn section');
  ok(v?.exact === '52,313,440' && v.exactShown && v.ticker === '$CMC', `the exact tokens burned, with the ticker (${v?.exact} ${v?.ticker})`);
  ok(v?.caption === 'destroyed on chain · everything that was asked for', `the caption (${v?.caption})`);
  ok(v?.fill >= 98 && v.sparkInside, `the fuse has run to the end and the flame stays on it (${v?.fill}%)`);
  ok(/52,313,440 burned/i.test(v?.legend ?? '') && /52,313,440 promised/i.test(v?.legend ?? ''), `burned against promised (${v?.legend})`);
  ok(v?.verdictOk && /went down by exactly this much/.test(v.verdict), `the verdict (${v?.verdict})`);
  ok(/1,000,000,000/.test(v?.supply ?? '') && /947,686,560/.test(v?.supply ?? ''), `the supply before and after (${v?.supply})`);
  ok(v?.who.length === 2 && v.who[0] === 'PrpN…CDnQ 10 SOL 100%', `who asked (${v?.who.join(' | ')})`);
  ok(/Behind \$CMC 10\.45 SOL 95\.7%/.test(v?.who[1] ?? ''), `and the coin as a whole (${v?.who[1]})`);
  ok(v?.txs.length === 3 && /16:31 UTC 18,204,112/.test(v.txs[0]), `each burn with its time and amount (${v?.txs[0]})`);
  ok(v?.links.every((href) => /solscan\.io\/tx\//.test(href)), 'each burn opens on Solscan');
  ok(!v?.overflow, 'nothing spills sideways');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await shot(p, 'burn-verify-done');
  await ctx.close();
}

// 2. During the buying: the fuse measures what is owed so far, and the answer is not cached.
{
  const { ctx, p, errors, asked } = await open({ width: 1440, height: 1000, body: proof([burn({ final: false, burned_raw: '32434333000000', supply_at_end: null })]) });
  const v = await read(p);
  ok(v?.caption === 'destroyed on chain · the buying is still running', `the caption says the buying goes on (${v?.caption})`);
  ok(v?.fill >= 60 && v.fill <= 64, `the fuse at 62% (${v?.fill}%)`);
  ok(/Burning as the buying goes/.test(v?.verdict ?? ''), `the verdict (${v?.verdict})`);
  ok(/after the round/.test(v?.supply ?? ''), `the supply after is not guessed (${v?.supply})`);
  await p.locator('.verify__close').click();
  await p.waitForTimeout(400);
  await p.locator('.pool-proof__verify').click();
  await p.waitForSelector('.verify-burn', { timeout: 10000 });
  ok(asked() === 2, `a burn in progress is asked for again on reopening (${asked()} requests)`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await shot(p, 'burn-verify-live');
  await ctx.close();
}

// 3. Blocked: red, with the reason and where the tokens are.
{
  const { ctx, p } = await open({ width: 1440, height: 1000, body: proof([burn({ burned_raw: '0', blocked_reason: "the coin's mint is paused", supply_at_end: '1000000000000000', transactions: [] })]) });
  const v = await read(p);
  ok(v?.verdictBad && /Burning stopped: the coin's mint is paused/.test(v.verdict) && /delivered to no one/.test(v.verdict), `a blocked burn is red and says why (${v?.verdict})`);
  ok(v?.caption === 'destroyed on chain · burning stopped', `the caption (${v?.caption})`);
  ok(v?.txs.length === 0, 'no transactions to list');
  await ctx.close();
}

// 4. A round without a burn: no section at all.
{
  const { ctx, p } = await open({ width: 1440, height: 1000, body: proof([]) });
  ok((await read(p)) === null, 'a round nobody burned in has no burn section');
  await ctx.close();
}

// 5. Phones: the compact number under 400px, nothing spills at 320.
for (const [width, height] of [[390, 844], [320, 640]]) {
  const { ctx, p, errors } = await open({ width, height, mobile: true, body: proof([burn()]) });
  await p.locator('.verify-burn').scrollIntoViewIfNeeded();
  const v = await read(p);
  ok(v?.compactShown && !v.exactShown && v.compact === '52.3M', `${width}px: the compact number (${v?.compact})`);
  ok(/52,313,440 burned/i.test(v?.legend ?? ''), `${width}px: the legend keeps the exact one`);
  ok(!v?.overflow, `${width}px: nothing spills sideways`);
  ok(v?.sparkInside, `${width}px: the flame stays on the fuse`);
  ok(errors.length === 0, `${width}px: no page errors ${errors.join(' | ')}`);
  if (width === 320) await shot(p, 'burn-verify-320');
  await ctx.close();
}

await b.close();
console.log(fails ? `\nBURN VERIFY: ${fails} FAILED` : '\nBURN VERIFY ALL PASSED');
process.exit(fails ? 1 : 0);
