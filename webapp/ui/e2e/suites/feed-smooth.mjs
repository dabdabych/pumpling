// The commit and purchase feeds: rows do not jump and the total agrees with the row.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto('http://localhost:3200/#how', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => { try { return !!ng.getComponent(document.querySelector('app-main-page')).storyTimeline; } catch { return false; } }, null, { timeout: 90000 });
await p.waitForTimeout(1200);
const goTo = async (label) => { await p.evaluate((l) => ng.getComponent(document.querySelector('app-main-page')).goToSection(l), label); await p.waitForTimeout(1300); };

const probe = (scene, listSel, totalSel) => p.evaluate(([scene, listSel, totalSel]) => {
  const list = document.querySelector(`[data-how-scene="${scene}"] ${listSel}`);
  const box = list.getBoundingClientRect();
  const rows = [...list.children].map((el) => {
    const r = el.getBoundingClientRect();
    return { top: +(r.top - box.top).toFixed(1), h: +r.height.toFixed(1), text: el.textContent.replace(/\s+/g, ' ').trim(), inside: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 };
  });
  return { at: performance.now(), boxH: +box.height.toFixed(1), rows, total: Number(document.querySelector(`[data-how-scene="${scene}"] ${totalSel}`).textContent) };
}, [scene, listSel, totalSel]);

for (const [scene, listSel, totalSel, label] of [[1, '.hrows--feed', '.pcard__big b', 'commits'], [4, '.hrows--tx', '.buyprog__text b', 'purchases']]) {
  await goTo(scene === 1 ? 'how' : 'step4');
  const first = await probe(scene, listSel, totalSel);
  ok(first.rows.length === 4, `${label}: four rows in the markup, the last one spare (${first.rows.length})`);
  // At rest exactly one row lies past the edge of the list: the spare one. In
  // motion it comes into frame and travels down, so we take several measurements.
  const spare = [];
  for (let i = 0; i < 14; i++) {
    await p.waitForTimeout(150);
    spare.push((await probe(scene, listSel, totalSel)).rows.filter((r) => r.inside).length);
  }
  ok(Math.min(...spare) === 3 || spare.includes(3), `${label}: at rest exactly three are visible (${spare.join('')})`);
  // We measure the settled rows: the first one may be unrolling at that moment.
  const step = first.rows[2].top - first.rows[1].top;
  const expected = first.rows[1].h * 3 + (step - first.rows[1].h) * 2;
  ok(Math.abs(first.boxH - expected) < 2, `${label}: the list height is exactly three rows (${first.boxH} against ${expected.toFixed(1)})`);

  // Frame by frame from inside the page: between neighbouring frames a row must
  // not move by more than a few pixels, otherwise it is a jerk.
  const motion = await p.evaluate(([scene, listSel]) => new Promise((done) => {
    const list = document.querySelector(`[data-how-scene="${scene}"] ${listSel}`);
    const frames = [];
    const t0 = performance.now();
    const tick = () => {
      const box = list.getBoundingClientRect();
      frames.push({
        ms: performance.now() - t0,
        rows: [...list.children].map((el) => {
          const r = el.getBoundingClientRect();
          // We tag the element itself: two rows in the feed can have identical
          // text, and the measurement would then compare different rows and see
          // a jerk that is not there.
          if (!el.dataset.probeId) el.dataset.probeId = String(Math.random());
          return { top: r.top - box.top, key: el.dataset.probeId };
        })
      });
      if (performance.now() - t0 < 5000) requestAnimationFrame(tick);
      else {
        // Speed rather than the shift per frame: the browser sometimes drops a
        // frame and the shift then doubles although the movement is the same.
        let speed = 0;
        let moved = 0;
        for (let i = 1; i < frames.length; i++) {
          const dt = Math.max(1, frames[i].ms - frames[i - 1].ms);
          for (const row of frames[i].rows) {
            const same = frames[i - 1].rows.find((r) => r.key === row.key);
            if (same) {
              const delta = Math.abs(same.top - row.top);
              speed = Math.max(speed, delta / dt);
              if (delta > 0.2) moved++;
            }
          }
        }
        done({ speed, moved, frames: frames.length });
      }
    };
    tick();
  }), [scene, listSel]);
  ok(motion.speed < 0.45, `${label}: the row travels no faster than ${motion.speed.toFixed(2)}px/ms (a jerk would be three times that)`);
  ok(motion.moved > 60, `${label}: the movement takes many frames rather than a jerk (${motion.moved} over ${motion.frames})`);

  // A row arrived and the total grew by exactly its size
  const frames = [];
  for (let i = 0; i < 170; i++) {
    await p.waitForTimeout(50);
    frames.push(await probe(scene, listSel, totalSel));
  }
  // Whatever arrived as rows has to be added to the total. We count from the
  // first arriving row to the last, letting the counter finish travelling each
  // time: it changes over half a second rather than instantly.
  const arrivals = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].rows[0].text !== frames[i - 1].rows[0].text) {
      arrivals.push({ i, sol: Number((frames[i].rows[0].text.match(/([\d.]+) SOL/) || [])[1]) });
    }
  }
  const settled = (index) => {
    const deadline = frames[index].at + 900;
    const found = frames.findIndex((f) => f.at >= deadline);
    return found === -1 ? -1 : found;
  };
  const usable = arrivals.filter((a) => settled(a.i) !== -1);
  ok(usable.length >= 2, `${label}: several rows arrived over the stretch (${usable.length})`);
  const fromArrival = usable[0];
  const toArrival = usable[usable.length - 1];
  const grew = frames[settled(toArrival.i)].total - frames[settled(fromArrival.i)].total;
  const arrived = usable.slice(1).reduce((sum, a) => sum + a.sol, 0);
  ok(Math.abs(grew - arrived) < 0.16, `${label}: the total grew by exactly the rows that arrived (${grew.toFixed(1)} against ${arrived.toFixed(1)})`);
}
if (S) {
  await p.screenshot({ path: `${S}/pw/shots/feed.png`, clip: await p.locator('[data-how-scene="4"] .pcard').boundingBox() });
  execSync(`sips -s format jpeg -s formatOptions 82 -Z 820 ${S}/pw/shots/feed.png --out ${S}/pw/shots/feed.jpg >/dev/null && rm ${S}/pw/shots/feed.png`);
}
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'FEED ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
