// The launch countdown, on a site that has run pools before.
//
// Production launches on 2026-10-04 at 19:00 UTC. The server says so in
// `hype_countdowns`, and the page has a "first pool opens in" view for it. Until
// 2026-10-03 that view showed only when no pool had ever run, and production
// has its September pools closed behind it: the site said "Next pool opens
// soon, we announce the next pool on our X" over a launch a day away. The
// mocked launch scenario had no past pool in it, so nothing caught that.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, summary } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function open(path, scenario) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/lottery/current**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(scenario)
  }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(2200);
  return { ctx, p, errors };
}

const text = (p, selector) => p.locator(selector).first().evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
// The long countdown: "1d 04h 14m".
const COUNTDOWN = /1d 04h 1[45]m/;

// ------------------------------------------- the pool page, past pools behind it
{
  const { ctx, p, errors } = await open('/pool', SCENARIOS.launchAfterPastPools());
  const title = await text(p, '.pool-title');
  const card = await text(p, '.pool-card');
  ok(title === 'The first pool opens soon', `the pool page announces the first pool (${title})`);
  ok(card.includes('Opens in') && COUNTDOWN.test(card), `with the time left to the launch (${card.match(/Opens in.{0,20}/)?.[0] ?? 'no timer'})`);
  ok(!card.includes('Next pool opens soon'), 'not the between-pools card');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------ the first screen's card
{
  const { ctx, p } = await open('/', SCENARIOS.launchAfterPastPools());
  const card = await text(p, '.qres-hero-card');
  const note = await text(p, '.qres-hero-card .qres-card-note');
  ok(/The first pool opens soon/i.test(card), `the main page card announces the first pool (${card.slice(0, 80)})`);
  ok(/^Opens in /.test(note) && COUNTDOWN.test(note), `and the line under it is the time left (${note || 'no note'})`);
  ok(!card.includes('We announce the next pool on our X'), 'not a pointer to X for a date it knows');
  await ctx.close();
}

// ------------------------------------- a pool in progress still comes first
{
  const scenario = SCENARIOS.launchAfterPastPools();
  scenario.active_lotteries = [summary({})];
  scenario.has_active_lottery = true;
  const { ctx, p } = await open('/pool', scenario);
  const chip = await text(p, '.pool-card__head .chip');
  ok(chip === 'Open', `an open pool is shown over a countdown (${chip})`);
  await ctx.close();
}

// ----------------------------------------- with no launch, between pools as before
{
  const { ctx, p } = await open('/', SCENARIOS.done());
  const card = await text(p, '.qres-hero-card');
  ok(/Next pool opens soon/i.test(card), `with nothing scheduled the card waits for the next pool (${card.slice(0, 80)})`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'LAUNCH COUNTDOWN ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
