// The path to a commit: pick a coin and everything is ready but the signature.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { SCENARIOS, mockCurrent, MINTS } from '../lib/pool-mock.mjs';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const setup = async (w, h, mobile) => {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, () => SCENARIOS.open());
  let checks = 0;
  await ctx.route('**/lottery/check-mint', async (route) => {
    checks++;
    const body = JSON.parse(route.request().postData() || '{}');
    const mint = body.mint_address;
    const names = { [MINTS.mochi]: ['MOCHI', 'Mochi'], [MINTS.toad]: ['TOAD', 'Toad Signal'], [MINTS.zapz]: ['ZAPZ', 'Zapz'] };
    const [symbol, name] = names[mint] ?? ['NEW', 'New coin'];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({
      mint_address: mint, token_symbol: symbol, token_name: name, token_image_url: null,
      price_usd: 0.0000412, price_change_24h: 12.4, market_cap_usd: 412000, liquidity_usd: 62000, dex_id: 'raydium', pair_url: 'https://dexscreener.com/solana/x'
    }) });
  });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://localhost:3200/pool', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForTimeout(1300);
  return { ctx, p, errors, checks: () => checks };
};

// 1. A commit from a table row: the coin is already chosen
{
  const { ctx, p, errors } = await setup(1440, 900, false);
  const add = p.locator('.coin-row__add').first();
  ok(await add.count() > 0, 'the coin row has a commit button');
  await add.click();
  await p.waitForTimeout(1200);
  const state = await p.evaluate(() => ({
    title: document.querySelector('.commit__title')?.textContent?.trim(),
    coin: document.querySelector('.commit-coin__names b')?.textContent?.trim(),
    market: !!document.querySelector('.commit-market'),
    amount: document.querySelector('#commit-amount')?.value,
    summary: document.querySelector('.commit__summary')?.textContent?.replace(/\s+/g, ' ').trim(),
    expect: document.querySelector('.commit__expect')?.textContent?.replace(/\s+/g, ' ').trim(),
    cta: document.querySelector('.commit__submit')?.textContent?.trim(),
    ctaDisabled: document.querySelector('.commit__submit')?.disabled
  }));
  ok(state.coin === '$MOCHI', `the coin from the row filled itself in (${state.coin})`);
  ok(state.market, 'the coin market is shown at once');
  ok(state.amount === '0.5', `the amount is already in the field (${state.amount})`);
  ok(/0\.5 SOL goes behind \$MOCHI/.test(state.summary ?? '') && /% of the pool/.test(state.summary ?? ''), `what the commit becomes is visible (${state.summary})`);
  ok(!state.ctaDisabled, 'the button is live right away');
  // 30.5 behind the coin + a 0.5 commit with a pool of 64.5: a share of 31/65 of 97% of the budget.
  ok(/\$MOCHI.*≈ 30\.0\d? SOL of buys/.test(state.expect ?? ''), `the announced buying is visibly growing (${state.expect})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  if (S) {
    await p.screenshot({ path: `${S}/pw/shots/commit-picked.png`, clip: await p.locator('.commit').boundingBox() });
    execSync(`sips -s format jpeg -s formatOptions 82 -Z 900 ${S}/pw/shots/commit-picked.png --out ${S}/pw/shots/commit-picked.jpg >/dev/null && rm ${S}/pw/shots/commit-picked.png`);
  }
  await ctx.close();
}

// 2. The general button: the coin is picked from the pool list
{
  const { ctx, p, errors } = await setup(390, 844, true);
  await p.locator('.pool-cta').first().click();
  await p.waitForTimeout(900);
  const chips = await p.locator('.commit-pick__coin').count();
  ok(chips >= 3, `the pool's coins are offered right in the dialog (${chips})`);
  const firstChip = await p.locator('.commit-pick__coin').first().innerText();
  ok(/\$MOCHI/.test(firstChip) && /SOL/.test(firstChip), `each shows how much stands behind it (${firstChip.replace(/\s+/g, ' ')})`);
  await p.locator('.commit-pick__coin').first().click();
  await p.waitForTimeout(900);
  const picked = await p.evaluate(() => ({
    coin: document.querySelector('.commit-coin__names b')?.textContent?.trim(),
    chips: document.querySelectorAll('.commit-pick__coin').length,
    mint: document.querySelector('#commit-mint')?.value
  }));
  ok(picked.coin === '$MOCHI', `picked with one tap (${picked.coin})`);
  ok(picked.chips === 0 && (picked.mint ?? '').length > 30, 'after the pick the list hides and the address is in the field');
  // the button is visible without scrolling on a phone
  const cta = await p.locator('.commit__submit').boundingBox();
  ok(cta.y + cta.height <= 844 + 1, `the button fits the phone screen (bottom at ${Math.round(cta.y + cta.height)})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}
console.log(fails ? `${fails} FAILED` : 'COMMIT FLOW ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
