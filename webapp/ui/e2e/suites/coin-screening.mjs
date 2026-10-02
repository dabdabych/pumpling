// The red-flag mark after a ticker, and its card (shared/coin-screening).
//
// The backend checks each coin once, at its first commit in a pool, and
// answers clean or flagged with what it read. The mark comes up only for an
// answer and is the same for every coin, a magnifier: the row carries no
// verdict. The card shows the readings as ranges, the flags in red and counted,
// when it was checked and by whom, on a mouse resting on the mark, a tap, or
// Enter. Checked here with real input: the mouse, the keyboard and a finger.
//
// TOAD is Krackpot as the stand saw it on 2026-10-02: the first card called it
// "No red flags" over a sentence about liquidity, on a coin still on its curve.
//
// What a phone must never do: lay two things in a row on top of each other,
// run a row off the screen, or put the card over its own mark. Before this
// suite the coin row did the first two on its own with a long ticker and a
// burn mark (at 320px the row ran 37px off the screen), and the card's first
// placement did the third at 320px.
import { launch } from '../lib/browser.mjs';
import { mockCurrent, entries, summary, MINTS } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const errors = [];

const AT = new Date(Date.now() - 12 * 60_000).toISOString();
const pool = () => {
  const list = entries([
    ['mochi', 30.5, 4, 'Mochi', 'MOCHI'],
    ['toad', 20, 3, 'Toad Signal Extended Name', 'TOADSIGNALXXXXX'],
    ['zapz', 10, 2, 'Zapz', 'ZAPZ'],
    ['tiny', 3, 1, 'Tiny Orbit', 'TINY'],
    ['nib', 1, 1, 'Nib', 'NIB']
  ]);
  list[0].screening = { status: 'clean', reasons: [], missing: ['bundle'], source: 'tracced', checked_at: AT, on_curve: true,
    levels: { dev: 'low', bundle: 'unknown', bundled_launch: 'low', top10: 'medium', insiders: 'low' } };
  list[1].screening = { status: 'flagged', reasons: ['bundled_launch'], missing: [], source: 'tracced', checked_at: AT, on_curve: true,
    levels: { dev: 'low', bundle: 'medium', bundled_launch: 'high', top10: 'low', insiders: 'low' } };
  list[1].burn_bps_avg = 5000;
  list[2].screening = { status: 'flagged', reasons: ['freeze_authority', 'mint_authority'], missing: [], source: 'chain', checked_at: AT, levels: {} };
  // TINY has no answer; NIB's answer has only a reason from the first version, which the site no longer shows.
  list[4].screening = { status: 'flagged', reasons: ['bundle_cluster'], missing: [], source: 'tracced', checked_at: AT };
  return { entries: list, has_active_lottery: true, active_lotteries: [summary({})], latest_lotteries: [summary({})], hype_countdowns: [] };
};

async function open(viewport, mobile) {
  const ctx = await b.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, pool);
  await ctx.route('**/lottery/check-mint', async (route) => {
    const mint = JSON.parse(route.request().postData() || '{}').mint_address;
    const names = { [MINTS.mochi]: ['MOCHI', 'Mochi'], [MINTS.toad]: ['TOADSIGNALXXXXX', 'Toad Signal Extended Name'], [MINTS.zapz]: ['ZAPZ', 'Zapz'] };
    const [symbol, name] = names[mint] ?? ['NEW', 'New coin'];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ mint_address: mint, token_symbol: symbol, token_name: name, token_image_url: null }) });
  });
  await ctx.route('**/lottery/coin/*/chart', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ mint: MINTS.mochi, available: true, minutes: 24, venue: 'raydium', price_usd: 0.00004, change_pct: 3,
      points: Array.from({ length: 25 }, (_, i) => ({ t: Math.floor(Date.now() / 1000) - (24 - i) * 60, p: 0.00004 + i * 1e-7 })) })
  }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${viewport.width}px: ${e.message}`));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForSelector('.coin-row', { timeout: 15000 });
  await p.waitForTimeout(600);
  return { ctx, p };
}

// The site scrolls smoothly (Bootstrap's `scroll-behavior: smooth`): a row brought
// into view has to arrive before the mark is measured, or the mouse lands where it was.
const mark = (p, ticker) => p.locator('.coin-row', { hasText: ticker }).locator('app-coin-screening-badge button');
const card = (p) => p.locator('.cdk-overlay-pane .card');

/** The card's place against the window and against its mark. */
const geometry = (p) => p.evaluate(() => {
  const c = document.querySelector('.cdk-overlay-pane .card')?.getBoundingClientRect();
  const m = [...document.querySelectorAll('app-coin-screening-badge button')].find((b) => b.getAttribute('aria-expanded') === 'true')?.getBoundingClientRect();
  if (!c || !m) return null;
  const vw = document.documentElement.clientWidth;
  return {
    left: Math.round(c.left), right: Math.round(vw - c.right), top: Math.round(c.top), bottom: Math.round(innerHeight - c.bottom),
    coversMark: !(c.right <= m.left || c.left >= m.right || c.bottom <= m.top || c.top >= m.bottom)
  };
});

/** Anything in a coin row lying on anything else, or past the row's edge, and whether the page scrolls sideways. */
const rowTrouble = (p) => p.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll('.coin-row')) {
    const rr = row.getBoundingClientRect();
    const parts = [...row.querySelectorAll('.coin-row__ticker, .coin-row__burn, .coin-row__mine, .coin-row__name, app-coin-screening-badge, .coin-row__mint, .coin-row__logo, .coin-row__sol, .coin-row__commits')];
    for (const el of parts) {
      const r = el.getBoundingClientRect();
      if (r.right > rr.right - 1 || r.left < rr.left + 1) out.push(`${el.className.split?.(' ')[0] || el.tagName} past the row`);
    }
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      if (parts[i].contains(parts[j]) || parts[j].contains(parts[i])) continue;
      const a = parts[i].getBoundingClientRect(), c = parts[j].getBoundingClientRect();
      const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left), oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (ox > 1 && oy > 1) out.push(`${parts[i].className.split?.(' ')[0] || parts[i].tagName} on ${parts[j].className.split?.(' ')[0] || parts[j].tagName}`);
    }
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`page ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px wider than the screen`);
  return out;
});

// 1. A mouse.
{
  const { ctx, p } = await open({ width: 1440, height: 900 }, false);
  ok(await p.locator('app-coin-screening-badge').count() === 3, 'marks on the three coins with an answer the site can show, none on the others');
  ok(await mark(p, 'TINY').count() === 0 && await mark(p, '$NIB').count() === 0, 'no answer, or one with no reason the site knows, shows nothing');
  // What the row shows: drawing, colours, frame. A clean coin and a flagged one must not differ.
  const look = (ticker) => mark(p, ticker).evaluate((el) => {
    // The drawn square: inside the trigger now, the button itself before.
    const drawn = el.querySelector('.mark') ?? el;
    const css = getComputedStyle(drawn);
    return { svg: drawn.innerHTML.replace(/_ngcontent-[\w-]+=""/g, ''), bg: css.backgroundColor, color: css.color, border: css.borderColor };
  });
  const [plain, toadLook, zapzLook] = [await look('MOCHI'), await look('TOAD'), await look('ZAPZ')];
  ok(JSON.stringify(plain) === JSON.stringify(toadLook) && JSON.stringify(plain) === JSON.stringify(zapzLook), `the mark is the same on a clean coin and on flagged ones (${JSON.stringify(plain).slice(0, 90)}…)`);
  ok(plain.bg === 'rgb(252, 252, 252)' && plain.color === 'rgb(2, 2, 2)', `black on white, no green and no red on the row (${plain.bg} / ${plain.color})`);
  const labels = [await mark(p, 'MOCHI').getAttribute('aria-label'), await mark(p, 'TOAD').getAttribute('aria-label')];
  ok(labels[0] === 'Coin check on $MOCHI. Show the check' && labels[1] === 'Coin check on $TOADSIGNALXXXXX. Show the check', `a screen reader hears the same for every coin (${labels.join(' / ')})`);

  // A mouse passing over does not flash the card; resting on the mark opens it.
  await p.locator('.coin-row', { hasText: 'TOAD' }).evaluate((row) => row.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p.waitForTimeout(300);
  const box = await mark(p, 'TOAD').boundingBox();
  await p.mouse.move(box.x + 10, box.y + 10);
  await p.mouse.move(box.x + 300, box.y + 10);
  await p.waitForTimeout(400);
  ok(await card(p).count() === 0, 'a mouse passing over does not flash the card');
  await p.mouse.move(box.x + 10, box.y + 10);
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  const text = (await card(p).innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok(/^Coin check 1 red flag /i.test(text) && /Dev under 5%/.test(text) && /Bundlers 5–20%/.test(text) && /Bundled at launch over 50%/.test(text) && /Top 10 under 20%/.test(text),
    `the card shows what was read, as ranges (${text.slice(0, 120)}…)`);
  const red = await card(p).locator('.card__row--flagged').evaluateAll((rows) => rows.map((row) => [row.innerText.replace(/\s+/g, ' '), getComputedStyle(row.querySelector('dd')).color]));
  ok(red.length === 1 && /Bundled at launch over 50%/.test(red[0][0]) && red[0][1] === 'rgb(176, 52, 29)', `the flag is the one line in red (${JSON.stringify(red)})`);
  ok(!/liquidity/i.test(text), 'no word of liquidity on a coin still on its curve');
  ok(!/still buys/i.test(text), 'and no line about the pool buying it anyway');
  ok(/At the first commit in this pool, 12 min ago/.test(text), 'and when it was checked');
  ok(!/\bsafe\b|scam|verified|no red flags|guarantee/i.test(text), 'and no verdict either way');
  const link = card(p).locator('a.card__source');
  ok(await link.getAttribute('href') === 'https://tracced.xyz' && await link.getAttribute('target') === '_blank' && /noopener/.test(await link.getAttribute('rel')), 'checked by tracced, linked, in a new tab');
  ok(await p.locator('.coin-chart').count() === 0, 'the price card stays down while this one is up');

  // The mouse can travel into the card to reach its link.
  const cardBox = await card(p).boundingBox();
  await p.mouse.move(cardBox.x + 20, cardBox.y + 20, { steps: 6 });
  await p.waitForTimeout(400);
  ok(await card(p).count() === 1, 'moving into the card keeps it up');
  await p.mouse.move(cardBox.x + cardBox.width + 200, cardBox.y - 200);
  await p.waitForTimeout(500);
  ok(await card(p).count() === 0, 'and leaving both takes it down');

  await p.locator('.coin-row', { hasText: 'ZAPZ' }).evaluate((row) => row.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p.waitForTimeout(300);
  const g = await (async () => { await mark(p, 'ZAPZ').hover(); await card(p).waitFor({ timeout: 3000 }); return geometry(p); })();
  const chainText = (await card(p).innerText()).replace(/\s+/g, ' ');
  ok(/^Coin check 2 red flags /i.test(chainText) && /Freeze authority active/.test(chainText) && /Mint authority active/.test(chainText) && /Read from the coin.s own account/.test(chainText) && await card(p).locator('a').count() === 0,
    `a flag from the mint itself says so, with no outside link (${chainText.slice(0, 120)})`);
  ok(!!g && !g.coversMark && g.left >= 16 && g.right >= 16, `the card sits beside its mark, inside the window (${JSON.stringify(g)})`);
  await p.mouse.move(5, 5);
  await p.waitForTimeout(400);

  // The keyboard: Enter opens and moves the focus in, Tab reaches the link, Escape comes back.
  await p.locator('.coin-row', { hasText: 'MOCHI' }).evaluate((row) => row.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await p.waitForTimeout(300);
  await mark(p, 'MOCHI').focus();
  await p.keyboard.press('Enter');
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  await p.waitForTimeout(150);
  ok(await p.evaluate(() => document.activeElement?.classList.contains('card')), 'Enter opens the card and the focus goes into it');
  await p.keyboard.press('Tab');
  ok(await p.evaluate(() => document.activeElement?.matches('a.card__source')), 'Tab reaches its link');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  ok(await card(p).count() === 0 && await p.evaluate(() => document.activeElement?.closest('app-coin-screening-badge') !== null), 'Escape closes it and gives the focus back to the mark');
  const clean = (await (async () => { await mark(p, 'MOCHI').click(); await card(p).waitFor({ timeout: 3000 }); return card(p).innerText(); })()).replace(/\s+/g, ' ');
  ok(/Coin check/.test(clean) && /Bundlers no data/.test(clean) && /Top 10 20–40%/.test(clean) && /Mint & freeze revoked/.test(clean), `a clean card shows its readings, and what had no data (${clean.slice(0, 140)}…)`);
  ok(!/no red flags|liquidity|\bsafe\b|guarantee|still buys/i.test(clean) && await card(p).locator('.card__row--flagged, .card__flags').count() === 0, 'and no verdict, no liquidity, no count, nothing in red');
  await p.mouse.click(5, 300);
  await p.waitForTimeout(250);
  ok(await card(p).count() === 0, 'a click elsewhere closes a card opened by a click');
  await ctx.close();
}

// 2. Phones and a tablet: a finger, and nothing on top of anything.
for (const [width, height] of [[320, 640], [360, 740], [390, 844], [430, 932], [768, 1024]]) {
  const { ctx, p } = await open({ width, height }, true);
  const trouble = await rowTrouble(p);
  ok(trouble.length === 0, `${width}px: nothing in a coin row on anything else, nothing off the screen (${trouble.join('; ') || 'clean'})`);
  for (const ticker of ['MOCHI', 'TOAD', 'ZAPZ']) {
    const target = mark(p, ticker);
    await target.scrollIntoViewIfNeeded();
    const markBox = await target.boundingBox();
    ok(markBox.width >= 20 && markBox.height >= 20, `${width}px: $${ticker}'s mark is a finger's target, at least 20px and 32px with its margin`);
    await target.tap();
    await card(p).waitFor({ timeout: 3000 }).catch(() => {});
    const g = await geometry(p);
    ok(!!g && !g.coversMark && g.left >= 16 && g.right >= 16 && g.top >= 0 && g.bottom >= 0,
      `${width}px: $${ticker}'s card is inside the window with 16px each side, off its mark (${JSON.stringify(g)})`);
    const overflow = await card(p).evaluate((el) => [...el.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5).length);
    ok(overflow === 0, `${width}px: nothing runs out of $${ticker}'s card`);
    const clash = await card(p).evaluate((el) => [...el.querySelectorAll('.card__row')].filter((row) => {
      const a = row.querySelector('dt').getBoundingClientRect(), c = row.querySelector('dd').getBoundingClientRect();
      return Math.min(a.right, c.right) - Math.max(a.left, c.left) > 0.5 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 0.5;
    }).map((row) => row.innerText.replace(/\s+/g, ' ')));
    ok(clash.length === 0, `${width}px: in $${ticker}'s card no name lies on its value (${clash.join('; ') || 'clean'})`);
    // A second tap on the same mark closes it; the next one opens again.
    await target.tap();
    await p.waitForTimeout(250);
    ok(await card(p).count() === 0, `${width}px: a second tap on the mark closes the card`);
  }
  // A tap elsewhere closes it too.
  await mark(p, 'MOCHI').scrollIntoViewIfNeeded();
  await mark(p, 'MOCHI').tap();
  await card(p).waitFor({ timeout: 3000 });
  // Away from the card, which may open above its mark and reach near the top of a small screen.
  const up = await card(p).boundingBox();
  await p.touchscreen.tap(Math.round(width / 2), Math.round(up.y > 80 ? up.y - 40 : Math.min(up.y + up.height + 40, height - 20)));
  await p.waitForTimeout(300);
  ok(await card(p).count() === 0, `${width}px: a tap elsewhere closes the card`);
  await ctx.close();
}

// 3. The commit dialog shows the same mark for the coin being committed to.
for (const [width, height] of [[390, 844], [1440, 900]]) {
  const { ctx, p } = await open({ width, height }, width < 600);
  await p.locator('.coin-row', { hasText: 'TOAD' }).locator('.coin-row__add').click();
  await p.waitForSelector('.commit-coin', { timeout: 15000 });
  const dialogMark = p.locator('.commit-coin app-coin-screening-badge button');
  ok(await dialogMark.count() === 1, `${width}px: the dialog marks the coin from the pool's own list`);
  if (width < 600) { await dialogMark.tap(); } else { await dialogMark.click(); }
  await card(p).waitFor({ timeout: 3000 }).catch(() => {});
  const g = await geometry(p);
  const zOk = await p.evaluate(() => {
    const c = document.querySelector('.cdk-overlay-pane .card').getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + 20);
    return !!hit?.closest('.card');
  });
  ok(!!g && !g.coversMark && g.left >= 16 && g.right >= 16 && zOk, `${width}px: its card opens over the dialog, inside the window (${JSON.stringify(g)})`);
  await ctx.close();
}

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'COIN SCREENING ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
