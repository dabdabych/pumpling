// My commits: a person sees themselves both in the pool table and on their own page.
import { launch, BASE } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { SCENARIOS, mockCurrent, MINTS } from '../lib/pool-mock.mjs';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const commitsBody = {
  total_sol: 1.75,
  rounds: [
    {
      lottery_id: 128,
      lottery_type: 'dex',
      status: 'created',
      created_at: new Date(Date.now() - 3600_000).toISOString(),
      end_date: new Date(Date.now() + 3600_000).toISOString(),
      my_sol: 1.5,
      pool_sol: 64.5,
      wallets: ['Wa11etOne111111111111111111111111111111111'],
      coins: [
        { mint: MINTS.mochi, name: 'Mochi', ticker: 'MOCHI', logo_url: null, my_sol: 1.2, my_commits: 2, pool_sol: 30.5, drawn_sol: null, signatures: ['Sig111111111111111111111111111111111111111111'] },
        { mint: MINTS.toad, name: 'Toad Signal', ticker: 'TOAD', logo_url: null, my_sol: 0.3, my_commits: 1, pool_sol: 20, drawn_sol: null, signatures: [] }
      ]
    },
    {
      lottery_id: 127,
      lottery_type: 'dex',
      status: 'closed',
      created_at: new Date(Date.now() - 20 * 3600_000).toISOString(),
      end_date: new Date(Date.now() - 18 * 3600_000).toISOString(),
      my_sol: 0.25,
      pool_sol: 12,
      wallets: ['Wa11etOne111111111111111111111111111111111'],
      coins: [
        { mint: MINTS.zapz, name: 'Zapz', ticker: 'ZAPZ', logo_url: null, my_sol: 0.25, my_commits: 1, pool_sol: 12, drawn_sol: 11.6, signatures: ['Sig222222222222222222222222222222222222222222'] }
      ]
    }
  ]
};

const withCommits = async (ctx, body = commitsBody, status = 200) => {
  await ctx.route('**/lottery/my/commits', (route) => route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  }));
};

// 1. The personal page
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await withCommits(ctx);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.mround', { timeout: 15000 });

  const view = await p.evaluate(() => ({
    total: document.querySelector('.mine__total')?.textContent?.replace(/\s+/g, ' ').trim(),
    rounds: [...document.querySelectorAll('.mround')].map((el) => ({
      id: el.querySelector('.mround__id')?.textContent?.trim(),
      live: !!el.querySelector('.chip--live'),
      mine: el.querySelector('.mround__mine')?.textContent?.replace(/\s+/g, ' ').trim(),
      coins: [...el.querySelectorAll('.mcoin')].map((row) => row.textContent.replace(/\s+/g, ' ').trim()),
      links: [...el.querySelectorAll('.mcoin__links a')].map((a) => a.getAttribute('href'))
    })),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));

  ok(/1.75/.test(view.total ?? ''), `the total of the commits is visible (${view.total})`);
  ok(view.rounds.length === 2, `both rounds are there (${view.rounds.length})`);
  ok(view.rounds[0].live === true, 'the running round is marked as running');
  ok(/1.5/.test(view.rounds[0].mine ?? ''), `my amount in the round (${view.rounds[0].mine})`);
  ok(/\$MOCHI/.test(view.rounds[0].coins[0]) && /3.9%/.test(view.rounds[0].coins[0]), `my share in the coin is visible (${view.rounds[0].coins[0]})`);
  ok(/draw is ahead/.test(view.rounds[0].coins[0]), 'before the draw we do not invent a result');
  ok(/11.6 SOL of buys/.test(view.rounds[1].coins[0]), `a closed round shows how much went into the buying (${view.rounds[1].coins[0]})`);
  ok((view.rounds[0].links[0] ?? '').includes('solscan.io/tx/Sig111'), `the commit signature leads to Solscan (${view.rounds[0].links[0]})`);
  ok(view.overflow === 0, 'no horizontal scrolling');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  if (S) {
    await p.screenshot({ path: `${S}/pw/shots/my-commits.png`, fullPage: false });
    execSync(`sips -s format jpeg -s formatOptions 82 -Z 900 ${S}/pw/shots/my-commits.png --out ${S}/pw/shots/my-commits.jpg >/dev/null && rm ${S}/pw/shots/my-commits.png`);
  }
  await ctx.close();
}

// 2. Not signed in — the page explains why to sign in
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await withCommits(ctx, { detail: 'Not authenticated' }, 401);
  const p = await ctx.newPage();
  await p.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForSelector('.mine__state', { timeout: 20000 });
  const text = await p.locator('.mine__state').innerText();
  ok(/Sign in to see your commits/.test(text), `without a sign-in we show the sign-in (${text.split('\n')[0]})`);
  await ctx.close();
}

// 3. An empty history
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await withCommits(ctx, { total_sol: 0, rounds: [] });
  const p = await ctx.newPage();
  await p.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForSelector('.mine__state', { timeout: 20000 });
  const text = await p.locator('.mine__state').innerText();
  ok(/Nothing here yet/.test(text), `an empty history explains itself (${text.split('\n')[0]})`);
  await ctx.close();
}

// 4. The pool page: my rows are marked
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await withCommits(ctx);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.coin-row', { timeout: 20000 });
  await p.waitForTimeout(800);

  const marks = await p.evaluate(() => [...document.querySelectorAll('.coin-row')].map((row) => ({
    ticker: row.querySelector('.coin-row__ticker')?.textContent?.trim(),
    mine: row.querySelector('.coin-row__mine')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    href: row.querySelector('.coin-row__mine')?.getAttribute('href') ?? null
  })));

  const mochi = marks.find((row) => row.ticker === '$MOCHI');
  const zapz = marks.find((row) => row.ticker === '$ZAPZ');
  ok(/you · 1.2 SOL/.test(mochi?.mine ?? ''), `my row is marked with the amount (${mochi?.mine})`);
  ok(mochi?.href === '/me', `the mark leads to my page (${mochi?.href})`);
  ok(zapz?.mine === null, 'other people\'s rows are not marked');
  ok(marks.filter((row) => row.mine).length === 2, `exactly my two coins are marked (${marks.filter((row) => row.mine).length})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 5. Phone
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await withCommits(ctx);
  const p = await ctx.newPage();
  await p.goto(BASE + '/me', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.mround', { timeout: 15000 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow === 0, `phone: no horizontal scrolling (${overflow})`);
  if (S) {
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${S}/pw/shots/my-commits-phone.png` });
    execSync(`sips -s format jpeg -s formatOptions 82 -Z 760 ${S}/pw/shots/my-commits-phone.png --out ${S}/pw/shots/my-commits-phone.jpg >/dev/null && rm ${S}/pw/shots/my-commits-phone.png`);
  }
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'MY COMMITS ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
