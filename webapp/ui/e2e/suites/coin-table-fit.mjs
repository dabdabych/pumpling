// The coin table on a laptop or a tablet held sideways: every row stays inside
// the list, and nothing breaks onto a second line that should not.
//
// The table layout used to start at 900px with columns whose minimums added up
// to about 1040px, so from 900px to about 1100px each row ran past the screen:
// fifty pixels of sideways scroll on an iPad at 1024, and on a 1366 laptop
// scaled to 125%. The checks run at the widths people have, with the widest
// content a row can hold: 110.95 SOL, 123 commits, a sixteen letter ticker.
// On the code before the fix they fail at every width from 900px to 1100px.
//
// After the draw the table is read for one number per coin, what it gets in
// buys, so that number is on a plate and every row's columns line up: each
// row is its own grid, and columns sized to their own row's content used to
// sit up to 18px apart.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const WIDTHS = [900, 960, 1000, 1024, 1060, 1100, 1139, 1140, 1280, 1366, 1440, 1920];

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const widest = (entries) => entries.map((entry, i) => i === 0
  ? { ...entry, total_solana_bet: '110.95', bet_count: 123, coin: { ...entry.coin, symbol: 'WWWWWWWWWWWWWWWW', name: 'A very long coin name that goes on' } }
  : entry);
const heavy = () => {
  const body = SCENARIOS.open();
  body.entries = widest(body.entries);
  return body;
};
// After the draw: the result on its green plate, the widest one a pool can give.
const heavyBuying = () => {
  const body = SCENARIOS.buying();
  body.entries = widest(body.entries);
  const summary = body.active_lotteries[0];
  summary.winner_results = [{ ...summary.winner_results[0], target_lamports: 110_950_000_000, target_sol: 110.95 }, ...summary.winner_results.slice(1)];
  return body;
};

for (const [label, scenario] of [['usual', () => SCENARIOS.open()], ['widest', heavy], ['drawn', () => SCENARIOS.buying()], ['widest drawn', heavyBuying]]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, scenario);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForSelector('.coin-row', { timeout: 20000 });

  for (const width of WIDTHS) {
    await p.setViewportSize({ width, height: 900 });
    await p.waitForTimeout(250);
    const m = await p.evaluate(() => {
      const rows = [...document.querySelectorAll('.coin-row')];
      const list = rows[0].parentElement.getBoundingClientRect();
      const past = rows.filter((row) => row.getBoundingClientRect().right > list.right + 0.5).length;
      // Cells that spill out of their column; the coin's name is cut with an
      // ellipsis on purpose and is left out.
      const spilled = rows.flatMap((row) => [...row.children]
        .filter((cell) => getComputedStyle(cell).display !== 'none' && !cell.className.includes('coin-row__coin'))
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
        .map((cell) => cell.className.split(' ')[0]));
      const chips = [...document.querySelectorAll('.coin-row__mint')];
      const brokenChips = chips.filter((chip) => chip.getBoundingClientRect().height > 40).length;
      const head = document.querySelector('.coin-head');
      const table = head && getComputedStyle(head).display !== 'none';
      // Each row is a grid of its own: in a table its columns must still sit
      // under each other, whatever each row holds.
      const lefts = (selector) => rows.map((row) => row.querySelector(selector)).filter(Boolean).map((el) => el.getBoundingClientRect().left);
      const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
      const drift = Math.max(spread(lefts('.coin-row__mint')), spread(lefts('.coin-row__sol')), spread(lefts('.coin-row__drawn')));
      return {
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        past, spilled, brokenChips, table, drift: Math.round(drift),
        plates: document.querySelectorAll('.coin-row__won').length
      };
    });
    const where = `${label} ${width}px (${m.table ? 'table' : 'cards'})`;
    ok(m.sideways === 0, `${where}: no sideways scroll (${m.sideways}px)`);
    ok(m.past === 0, `${where}: every row inside the list (${m.past} past it)`);
    ok(m.spilled.length === 0, `${where}: nothing spills out of its column (${m.spilled.join(', ') || 'none'})`);
    ok(m.brokenChips === 0, `${where}: the address stays on one line (${m.brokenChips} broken)`);
    if (m.table) {
      ok(m.drift <= 1, `${where}: the columns of every row line up (${m.drift}px apart)`);
    }
    if (label.includes('drawn')) {
      ok(m.plates === 4, `${where}: every coin the draw gave something has its amount on a plate (${m.plates})`);
    }
  }
  ok(errors.length === 0, `${label}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

await b.close();
console.log(fails ? `\nCOIN TABLE FIT: ${fails} FAILED` : '\nCOIN TABLE FIT ALL PASSED');
process.exit(fails ? 1 : 0);
