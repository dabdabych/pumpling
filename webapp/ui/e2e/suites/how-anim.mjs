// The live How it works scenes: every phase has to move by itself while on screen.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
const BASE = process.env.BASE || 'http://localhost:3200';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** The lengths of runs of consecutively changing samples: a step has to travel rather than click. */
const changeRuns = (samples) => {
  const runs = [];
  let run = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] - samples[i - 1] > 0.005) {
      run++;
    } else if (run) {
      runs.push(run);
      run = 0;
    }
  }
  if (run) runs.push(run);
  return runs;
};

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/#how', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
await p.waitForFunction(() => { try { return !!ng.getComponent(document.querySelector('app-main-page')).storyTimeline; } catch { return false; } }, null, { timeout: 90000 });
await p.waitForTimeout(1500);

const goTo = async (label) => {
  await p.evaluate((name) => ng.getComponent(document.querySelector('app-main-page')).goToSection(name), label);
  await p.waitForTimeout(1400);
};
const read = () => p.evaluate(() => {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  // The visible feed rows: the first three. The fourth lies past the edge of the
  // list and travels down — the smoothness test checks that one separately.
  const visibleEls = (listSel) => {
    const list = document.querySelector(listSel);
    return list ? [...list.children].slice(0, 3) : [];
  };
  const visibleRows = (listSel) => visibleEls(listSel).map((el) => el.textContent.replace(/\s+/g, ' ').trim());
  const widths = (sel) => [...document.querySelectorAll(sel)].map((el) => Math.round(parseFloat(getComputedStyle(el).width)));
  return {
    poolTotal: text('[data-how-scene="1"] .pcard__big b'),
    poolBarWidth: document.querySelector('[data-how-scene="1"] .bar--slim .bar__fill')?.style.width ?? null,
    poolClock: text('[data-how-scene="1"] .pcard__meta b'),
    poolId: text('[data-how-scene="1"] .pcard__id'),
    feedRows: visibleRows('[data-how-scene="1"] .hrows--feed'),
    price: document.querySelector('[data-how-scene="2"] path[data-how-spark]')?.getAttribute('d') ?? null,
    priceDot: (() => { const d = document.querySelector('[data-how-scene="2"] .spark__dot'); return d ? d.getAttribute('cx') + ',' + d.getAttribute('cy') : null; })(),
    priceValue: document.querySelector('[data-how-scene="2"] .spark__price')?.textContent ?? null,
    drawState: text('[data-how-scene="3"] .pcard__meta'),
    drawValues: [...document.querySelectorAll('[data-how-scene="3"] .hrow__sol b')].map((el) => el.textContent),
    drawWidths: widths('[data-how-scene="3"] .bar__fill'),
    bought: text('[data-how-scene="4"] .buyprog__text b'),
    buyText: text('[data-how-scene="4"] .buyprog__text'),
    buyHead: text('[data-how-scene="4"] .pcard__id'),
    buyCoinTags: visibleEls('[data-how-scene="4"] .hrows--tx').map((el) => el.querySelector('.hrow__coin').textContent.trim()),
    buyHeadCoins: document.querySelectorAll('[data-how-scene="4"] .pcard__coins .coin').length,
    candles: document.querySelectorAll('[data-how-scene="4"] [data-how-candle].is-shown').length,
    payoutWidths: widths('[data-how-scene="5"] .hrow--payout .bar__fill'),
    payoutTokens: [...document.querySelectorAll('[data-how-scene="5"] .hrow__tokens')].map((el) => el.textContent)
  };
});

// 1. The commit feed
await goTo('how');
const a1 = await read();
await p.waitForTimeout(3000);
const b1 = await read();
ok(Number(b1.poolTotal) > Number(a1.poolTotal), `the pool fills up on its own (${a1.poolTotal} -> ${b1.poolTotal} SOL)`);
ok(a1.feedRows.length === 3 && b1.feedRows.length === 3, `the feed always holds three rows (${a1.feedRows.length} -> ${b1.feedRows.length})`);
ok(JSON.stringify(a1.feedRows) !== JSON.stringify(b1.feedRows), `commits keep arriving (newest "${b1.feedRows[0]}")`);
ok(b1.feedRows[1] === a1.feedRows[0] || b1.feedRows[2] === a1.feedRows[0], 'the previous top row moved down, it did not vanish');
// the total grows in steps: we measure consecutive jumps
const seen = [];
for (let i = 0; i < 90; i++) {
  seen.push(Number((await read()).poolTotal));
  await p.waitForTimeout(120);
}
const jumps = [];
for (let i = 1; i < seen.length; i++) {
  const delta = Number((seen[i] - seen[i - 1]).toFixed(2));
  if (delta > 0.01) jumps.push(delta);
}
const settled = seen.filter((value, i) => i > 0 && Math.abs(value - seen[i - 1]) < 0.005).length;
ok(jumps.length > 0 && settled > seen.length * 0.3, `the pool total rests between commits and then steps up (${settled} still samples of ${seen.length})`);
// A step travels over several consecutive samples rather than clicking in one.
const poolRuns = changeRuns(seen);
const poolRamped = poolRuns.filter((run) => run >= 2).length;
ok(poolRuns.length > 0 && poolRamped >= poolRuns.length / 2, `a commit ramps in instead of snapping (runs: ${poolRuns.join(', ')})`);
const total = Number(seen[seen.length - 1]) - Number(seen[0]);
ok(total > 0.4, `over ten seconds the pool grew by ${total.toFixed(2)} SOL`);

const names = await p.evaluate(() => document.body.innerText);
ok(!/\$SNAX|\$PIXL/.test(names), 'the old tickers are gone');

ok(a1.poolClock !== b1.poolClock && /^\d\d:\d\d:\d\d$/.test(b1.poolClock), `the pool clock ticks (${a1.poolClock} -> ${b1.poolClock})`);
if (S) {
  await p.screenshot({ path: `${S}/pw/shots/how-step1.png` });
  execSync(`sips -s format jpeg -s formatOptions 65 -Z 950 ${S}/pw/shots/how-step1.png --out ${S}/pw/shots/how-step1.jpg >/dev/null && rm ${S}/pw/shots/how-step1.png`);
}

// 2. Price
await goTo('step2');
const a2 = await read();
await p.waitForTimeout(1200);
const b2 = await read();
ok(a2.price !== b2.price && /^M/.test(b2.price ?? ''), 'the price line keeps moving');
ok(a2.priceDot !== b2.priceDot, `the tip of the line moves (${a2.priceDot} -> ${b2.priceDot})`);
ok(Number((b2.priceValue ?? '$0').slice(1)) > Number((a2.priceValue ?? '$0').slice(1)), `the price itself goes up (${a2.priceValue} -> ${b2.priceValue})`);
ok((b2.price ?? '').includes('C'), 'the price line is a curve, not a zigzag of segments');
// the run-up: the tip of the line travels right and up rather than standing still
const walk = [];
for (let i = 0; i < 15; i++) {
  await p.waitForTimeout(850);
  walk.push(await p.evaluate(() => {
    const d = document.querySelector('[data-how-scene="2"] .spark__dot');
    const svg = document.querySelector('[data-how-scene="2"] .spark__chart');
    return { x: Number(d.getAttribute('cx')), y: Number(d.getAttribute('cy')), h: svg.clientHeight };
  }));
}
ok(walk[walk.length - 1].x > walk[0].x + 40, `the line stretches to the right (${walk[0].x.toFixed(0)} -> ${walk[walk.length - 1].x.toFixed(0)})`);
// By the maximum rather than the last sample: the price has visible pullbacks and
// the last frame can land exactly on a dip.
const highest = Math.min(...walk.map((w) => w.y));
ok(walk[0].y - highest > walk[0].h * 0.2, `and climbs inside the frame (${walk[0].y.toFixed(0)} -> ${highest.toFixed(0)} of ${walk[0].h})`);

// 3. The draw: no animation, just the result
await goTo('step3');
const d1 = await read();
await p.waitForTimeout(2500);
const d2 = await read();
ok(JSON.stringify(d1.drawWidths) === JSON.stringify(d2.drawWidths), `the draw slide stands still (${d1.drawWidths} -> ${d2.drawWidths})`);
ok(d2.drawState === 'draw by Switchboard', `the draw slide keeps its caption (${d2.drawState})`);
if (S) {
  await p.screenshot({ path: `${S}/pw/shots/how-step3.png` });
  execSync(`sips -s format jpeg -s formatOptions 65 -Z 950 ${S}/pw/shots/how-step3.png --out ${S}/pw/shots/how-step3.jpg >/dev/null && rm ${S}/pw/shots/how-step3.png`);
}

// 4. The buying
await goTo('step4');
const a4 = await read();
await p.waitForTimeout(2600);
const b4 = await read();
ok(Number(b4.bought) > Number(a4.bought), `bought SOL grows (${a4.bought} -> ${b4.bought})`);
ok(b4.candles >= a4.candles && b4.candles > 0, `candles appear one by one (${a4.candles} -> ${b4.candles})`);
// At the start of the hour there are exactly two candles: one green, one purple.
const firstCandles = await p.evaluate(() => [...document.querySelectorAll('[data-how-scene="4"] [data-how-candle]')]
  .filter((el) => el.classList.contains('is-shown'))
  .map((el) => el.querySelector('rect').getAttribute('fill')));
ok(a4.candles === 2, `the hour starts with two candles (${a4.candles})`);
ok(firstCandles.length === 2 && firstCandles[0] === '#8FFFAF' && firstCandles[1] === '#AF8FFF', `one green, one purple (${firstCandles.join(' ')})`);
await p.waitForTimeout(14000);
const c4candles = (await read()).candles;
ok(c4candles > 2, `and more show up as the hour runs (${c4candles})`);
const visibleBuys = () => p.evaluate(() => {
  // The first three rows are the visible ones: the fourth lies past the edge of the list.
  const list = document.querySelector('[data-how-scene="4"] .hrows--tx');
  return [...list.children].slice(0, 3).map((el) => el.querySelector('.hrow__wallet').textContent.trim());
});
const buyRowsA = await visibleBuys();
await p.waitForTimeout(2300);
const buyRowsB = await visibleBuys();
ok(buyRowsA.length === 3 && buyRowsB.length === 3, `three buys on screen (${buyRowsA.length} -> ${buyRowsB.length})`);
ok(buyRowsB[0] !== buyRowsA[0] && buyRowsB.includes(buyRowsA[0]), `buys move like the commit feed: new on top, the old one slid down (${buyRowsB[0]})`);
ok(b4.buyHead === '3 coins' && b4.buyHeadCoins === 3, `the card says the buys cover three coins (${b4.buyHead}, ${b4.buyHeadCoins} marks)`);
ok(/of 97 SOL bought across the three/.test(b4.buyText ?? ''), `the total is the whole buy budget (${b4.buyText})`);
ok(new Set(b4.buyCoinTags).size >= 2, `buy rows name their coin (${b4.buyCoinTags.join(', ')})`);
// the buying grows in steps too
const buySamples = [];
for (let i = 0; i < 60; i++) {
  buySamples.push(Number((await read()).bought));
  await p.waitForTimeout(120);
}
const buyStill = buySamples.filter((value, i) => i > 0 && Math.abs(value - buySamples[i - 1]) < 0.005).length;
const buyRuns = changeRuns(buySamples);
const buyRamped = buyRuns.filter((run) => run >= 2).length;
ok(buyStill > buySamples.length * 0.3, `bought SOL rests between buys (${buyStill} still samples)`);
ok(buyRuns.length > 0 && buyRamped >= buyRuns.length / 2, `and a buy ramps in instead of snapping (runs: ${buyRuns.join(', ')})`);

// 5. Delivery
await goTo('step5');
const a5 = await read();
await p.waitForTimeout(2200);
const b5 = await read();
ok(b5.payoutWidths[0] > a5.payoutWidths[0] || b5.payoutWidths[2] > a5.payoutWidths[2], `payout bars grow (${a5.payoutWidths} -> ${b5.payoutWidths})`);
ok(b5.payoutTokens.join() !== a5.payoutTokens.join(), `token counters count up (${a5.payoutTokens} -> ${b5.payoutTokens})`);
await p.waitForTimeout(3000);
const c5 = await read();
ok(JSON.stringify(c5.payoutWidths) === JSON.stringify(b5.payoutWidths), `the payout plays once and stays (${b5.payoutWidths} -> ${c5.payoutWidths})`);
// back on the scene — it plays again, but once again only once
await goTo('step4');
await goTo('step5');
const e1 = await read();
await p.waitForTimeout(2400);
const e2 = await read();
ok(e2.payoutWidths[2] > e1.payoutWidths[2] || e1.payoutWidths[2] === e2.payoutWidths[2], `coming back replays it (${e1.payoutWidths} -> ${e2.payoutWidths})`);
if (S) {
  await p.screenshot({ path: `${S}/pw/shots/how-step5.png` });
  execSync(`sips -s format jpeg -s formatOptions 65 -Z 950 ${S}/pw/shots/how-step5.png --out ${S}/pw/shots/how-step5.jpg >/dev/null && rm ${S}/pw/shots/how-step5.png`);
}

// We left the section — the scenes go quiet
await goTo('hero');
const c1 = await read();
await p.waitForTimeout(1500);
const c2 = await read();
ok(c1.poolTotal === c2.poolTotal && c1.bought === c2.bought, 'scenes stop when the section is off screen');

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'HOW ANIM ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
