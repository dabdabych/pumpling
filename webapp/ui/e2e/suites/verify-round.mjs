// "Verify this pool": the button, the dialog and what it says.
//
// This is the only place on the site where we show somebody the grounds for
// trusting a draw: the weights commitment with its preimage, the source of the
// randomness and the fingerprint of the shares algorithm. The suite holds three
// things: the button only appears when there is something to verify, the dialog
// shows all three parts, and an emergency draw is named out loud rather than hidden.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const cors = { 'access-control-allow-origin': '*' };
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const proof = (over = {}) => ({
  lottery_id: 128,
  lottery_type: 'dex',
  status: 'proceeding_purchases',
  network: 'devnet',
  program_id: '4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH',
  lottery_account: '6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9',
  vault_account: 'CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq',
  admin_account: 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ',
  weights_hash_onchain: 'a3f1'.repeat(16),
  weights_payload: '[["7XqN4wD2mJp9LcR8Vt3HzYk1BaFe5PuQ6sMdCnUa2",30.5],["C4rT9vB2nQ1sEjKpL7mWx3ZyA6dFgH8uYtRe5oPi4",20]]',
  weights_hash_recomputed: 'a3f1'.repeat(16),
  weights_match: true,
  randomness_source: 'vrf',
  randomness_account: 'J39nG8DhxdEJW2NGUr9hUfHaDQ5qQoKDD2pVtaRbQRyF',
  vrf_seed: 'f4ecb70692e899b407831de84bfd96513a2f386c447efc59ab07beaca79b41ad',
  vrf_algorithm_hash: '2ec9c530fcd55efd0838bd79245e2543e24f41cd3c2d660eaff43c0387629929',
  algorithm_source: 'webapp/backend/application/lottery/vrf_engine.py',
  winner_results: [],
  ...over
});

const openPool = async (ctx, scenario, body) => {
  await mockCurrent(ctx, () => SCENARIOS[scenario]());
  await ctx.route('**/lottery/*/verification', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body)
  }));
  await ctx.route('**/lottery/*/purchases**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ available: false, coins: [], purchases: [] })
  }));
  const p = await ctx.newPage();
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(900);
  return p;
};

// 1. The button only appears where there is something to verify.
for (const [scenario, expected] of [['open', false], ['lockedRunning', false], ['buying', true], ['done', true]]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await openPool(ctx, scenario, proof());
  const count = await p.locator('.pool-proof__verify').count();
  ok(
    (count > 0) === expected,
    `${scenario}: the verify button ${expected ? 'is offered' : 'stays away'} (${count})`
  );
  await ctx.close();
}

// 2. The dialog shows all three grounds and leads to the source data.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await openPool(ctx, 'buying', proof());
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.locator('.pool-proof__verify').click();
  await p.waitForSelector('.verify', { timeout: 10000 });
  await p.waitForTimeout(700);

  const text = (await p.locator('.verify').innerText()).replace(/\s+/g, ' ');
  ok(/Committed before the draw/i.test(text), 'the window shows what was committed before the draw');
  ok(/Randomness/i.test(text) && /Shares algorithm/i.test(text), 'and the randomness and the algorithm');
  ok(text.includes('30.5'), `the exact numbers behind the hash are there (${text.slice(0, 90)})`);
  ok(/holds the hash of the numbers below/i.test(text), 'and it says plainly that they match the chain');

  const links = await p.evaluate(() => Array.from(document.querySelectorAll('.verify__link')).map((n) => n.getAttribute('href')));
  ok(links.some((href) => /github/i.test(href || '')), `a link to the instructions (${links.join(' | ')})`);
  ok(links.some((href) => /\/verification$/.test(href || '')), 'and a link to the machine-readable data');

  // Nothing runs past the edge of the dialog.
  const fit = await p.evaluate(() => {
    const box = document.querySelector('.verify');
    const rect = box.getBoundingClientRect();
    return {
      inWindow: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      scrolls: box.scrollWidth > box.clientWidth + 1
    };
  });
  ok(fit.inWindow && !fit.scrolls, `the window fits the screen (${JSON.stringify(fit)})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 3. A round drawn with an emergency seed has to say so out loud.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await openPool(ctx, 'buying', proof({ randomness_source: 'emergency' }));
  await p.locator('.pool-proof__verify').click();
  await p.waitForSelector('.verify', { timeout: 10000 });
  await p.waitForTimeout(500);
  const text = (await p.locator('.verify').innerText()).replace(/\s+/g, ' ');
  ok(
    /operator's seed/i.test(text),
    `an emergency draw is named out loud (${text.slice(0, 160)})`
  );
  await ctx.close();
}

// 4. Phone: the dialog fits and the buttons can be reached.
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await openPool(ctx, 'done', proof());
  await p.locator('.pool-proof__verify').scrollIntoViewIfNeeded();
  await p.locator('.pool-proof__verify').tap();
  await p.waitForSelector('.verify', { timeout: 10000 });
  await p.waitForTimeout(700);
  const phone = await p.evaluate(() => {
    const box = document.querySelector('.verify');
    const rect = box.getBoundingClientRect();
    const small = Array.from(box.querySelectorAll('button')).filter((node) => {
      const r = node.getBoundingClientRect();
      return r.height > 2 && r.height < 24;
    }).length;
    return {
      fits: rect.left >= -1 && rect.right <= window.innerWidth + 1,
      scrollable: box.scrollHeight > box.clientHeight ? box.scrollHeight - box.clientHeight : 0,
      spill: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      small
    };
  });
  ok(phone.fits && phone.spill <= 1, `phone: the window fits (${JSON.stringify(phone)})`);
  ok(phone.small === 0, `phone: buttons are big enough for a finger (${phone.small} too small)`);
  await ctx.close();
}

// 5. The archive: every past round has the button.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/lottery/archive**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ items: [{
      id: 128, lottery_type: 'dex', ended_at: new Date(Date.now() - 3600_000).toISOString(),
      total_sol: 64.5, pool_account: '6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9',
      entries: [{ rank: 1, mint: '7XqN4wD2mJp9LcR8Vt3HzYk1BaFe5PuQ6sMdCnUa2', name: 'Mochi', symbol: 'MOCHI', sol: 30.5, bought_sol: 29.4 }]
    }] })
  }));
  await ctx.route('**/lottery/*/verification', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(proof())
  }));
  const p = await ctx.newPage();
  // The same retry as on the pool page: under load the dev server does not
  // answer at once, and a single attempt used to fail the whole suite.
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/archive', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(900);
  const button = p.locator('.round__verify').first();
  ok(await button.count() > 0, 'every past pool carries a verify button');
  if (await button.count() > 0) {
    await button.click();
    await p.waitForSelector('.verify', { timeout: 10000 });
    await p.waitForTimeout(900);
    const text = (await p.locator('.verify').innerText()).replace(/\s+/g, ' ');
    ok(/Committed before the draw/i.test(text), `and it opens the same proof from the archive (${text.slice(0, 120)})`);
  }
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'VERIFY ROUND ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
