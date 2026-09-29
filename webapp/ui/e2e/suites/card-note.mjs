// The line under "Next pool opens soon" on the first screen's card.
//
// Between rounds the card says only that a pool opens soon, which gives a
// visitor nothing to do. The note under it says where the next one is
// announced. The card is `overflow-hidden` and its height is whatever the hero
// leaves, so a line that does not fit is not pushed out of view — it is
// silently cut in half. That is what this measures, at every window a person is
// likely to have, down to a 320px phone and a 600px-tall laptop.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const NOTE = 'We announce the next pool on our X';

const SIZES = [
  [320, 568], [360, 640], [375, 667], [390, 844], [414, 896], [430, 932],
  [600, 960], [768, 1024], [820, 1180], [1024, 600], [1024, 768],
  [1280, 720], [1366, 768], [1440, 900], [1536, 864], [1920, 1080], [2560, 1440]
];

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** The main page with the pool in a given state. */
async function mainPage(scenario, viewport) {
  const ctx = await b.newContext({
    viewport,
    isMobile: viewport.width < 500,
    hasTouch: viewport.width < 500
  });
  // The shared `mockCurrent` names the dev backend by its full address, so it
  // misses a built site. This one holds whatever BASE points at.
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
    try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(2200);
  return { ctx, p, errors };
}

/**
 * The card and its text.
 *
 * The animation layers inside the card are absolutely positioned and overflow
 * it by design, so `scrollHeight` says nothing. What has to fit is the column
 * of text: the title, the phase line and the note.
 */
const measure = (p) => p.evaluate(() => {
  const card = document.querySelector('.qres-hero-card');
  if (!card) return null;
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) };
  };
  const note = card.querySelector('.qres-card-note');
  const text = Array.from(card.children).filter((el) => !el.classList.contains('pointer-events-none'));
  const boxes = text.map(rect);
  return {
    card: rect(card),
    note: note ? rect(note) : null,
    text: note ? note.textContent.trim() : null,
    lines: note ? Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight)) : 0,
    // The phase line sits between the title and the note.
    above: boxes.length > 1 ? boxes[boxes.length - 2] : null,
    content: boxes.length ? {
      top: Math.min(...boxes.map((r) => r.top)),
      bottom: Math.max(...boxes.map((r) => r.bottom)),
      left: Math.min(...boxes.map((r) => r.left)),
      right: Math.max(...boxes.map((r) => r.right))
    } : null
  };
});

// ------------------------------------------------- it fits, at every window
{
  let missing = 0;
  let cut = 0;
  let wrapped = 0;
  let worst = { room: 1e9, at: '' };

  for (const [width, height] of SIZES) {
    const { ctx, p } = await mainPage(SCENARIOS.done(), { width, height });
    const m = await measure(p);
    const label = `${width}x${height}`;

    if (!m || !m.note) {
      missing++;
      console.log(`     ${label}: no note on the card`);
    } else {
      const inside = m.content.top >= m.card.top - 1
        && m.content.bottom <= m.card.bottom + 1
        && m.content.left >= m.card.left - 1
        && m.content.right <= m.card.right + 1;
      if (!inside) {
        cut++;
        console.log(`     ${label}: cut off (card ${m.card.top}..${m.card.bottom}, text ${m.content.top}..${m.content.bottom})`);
      }
      // Two lines is still fine on a narrow card; three means the wording has
      // outgrown the space it has.
      if (m.lines > 2) {
        wrapped++;
        console.log(`     ${label}: the note runs to ${m.lines} lines`);
      }
      const room = Math.min(m.content.top - m.card.top, m.card.bottom - m.content.bottom);
      if (room < worst.room) worst = { room, at: label };
    }
    await ctx.close();
  }

  ok(missing === 0, `the note is on the card at every size (${SIZES.length - missing} of ${SIZES.length})`);
  ok(cut === 0, `and none of them cuts the card's text off (${cut} cut)`);
  ok(wrapped === 0, `and it never runs past two lines (${wrapped} over)`);
  ok(worst.room >= 8, `the tightest fit still has room (${worst.room}px at ${worst.at})`);
}

// ------------------------------------------------- what it says, and where
{
  const { ctx, p, errors } = await mainPage(SCENARIOS.done(), { width: 1440, height: 900 });
  const m = await measure(p);

  ok(m.text === NOTE, `it reads "${NOTE}" (${m.text})`);
  ok(m.lines === 1, `on one line at a normal window (${m.lines})`);
  ok(!!m.note && !!m.above && m.note.top >= m.above.bottom, `under the phase line, not over it (${m.above?.bottom} -> ${m.note?.top})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------- a running pool has better things to say
{
  const { ctx, p } = await mainPage(SCENARIOS.open(), { width: 1440, height: 900 });
  const m = await measure(p);
  ok(m.note === null, `while a pool is open the card does not carry it (${m.text ?? 'clean'})`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'CARD NOTE ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
