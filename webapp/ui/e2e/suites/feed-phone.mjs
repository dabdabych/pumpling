// Phone: the feeds hold three rows and do not break the card.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
const S = process.env.S;
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
await p.goto('http://localhost:3200/#how', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
await p.waitForTimeout(900);
for (const [scene, listSel, name] of [[1, '.hrows--feed', 'commits'], [4, '.hrows--tx', 'purchases']]) {
  await p.evaluate((s) => document.querySelector(`[data-how-scene="${s}"]`)?.scrollIntoView({ block: 'center' }), scene);
  await p.waitForTimeout(4500);
  const st = await p.evaluate(([scene, listSel]) => {
    const list = document.querySelector(`[data-how-scene="${scene}"] ${listSel}`);
    const box = list.getBoundingClientRect();
    const rows = [...list.children].map((el) => el.getBoundingClientRect());
    const step = rows[2].top - rows[1].top;
    return {
      rows: rows.length,
      // The list has to be exactly three rows: two steps plus a row height.
      boxH: +box.height.toFixed(2),
      wanted: +(step * 2 + rows[1].height).toFixed(2),
      // The fourth row is entirely past the edge — visible only while it travels away.
      spareTop: +(rows[3].top - box.bottom).toFixed(2),
      rowH: list.style.getPropertyValue('--row-h'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardBottom: Math.round(list.closest('.pcard').getBoundingClientRect().bottom - box.bottom)
    };
  }, [scene, listSel]);
  ok(Math.abs(st.boxH - st.wanted) < 1.5, `${name}: the list is exactly three rows (${st.boxH} against ${st.wanted}, --row-h ${st.rowH})`);
  // At rest the spare row has to be past the edge of the list. In motion it
  // comes into frame and travels down, so we take several measurements.
  const spare = [st.spareTop];
  for (let i = 0; i < 14; i++) {
    await p.waitForTimeout(150);
    spare.push(await p.evaluate(([scene, listSel]) => {
      const list = document.querySelector(`[data-how-scene="${scene}"] ${listSel}`);
      const box = list.getBoundingClientRect();
      return +(list.children[3].getBoundingClientRect().top - box.bottom).toFixed(2);
    }, [scene, listSel]));
  }
  ok(Math.max(...spare) >= -1, `${name}: at rest the spare row is past the edge (${Math.max(...spare)}px)`);
  ok(st.overflow === 0, `${name}: no horizontal scrolling (${st.overflow})`);
  ok(st.cardBottom >= 0, `${name}: the list does not spill out of the card (${st.cardBottom}px to the bottom)`);
  if (S) {
    const card = await p.locator(`[data-how-scene="${scene}"] .pcard`).boundingBox();
    await p.screenshot({ path: `${S}/pw/shots/feed-phone-${scene}.png`, clip: { x: Math.max(0, card.x - 4), y: Math.max(0, card.y - 4), width: Math.min(390, card.width + 8), height: card.height + 8 } });
    execSync(`sips -s format jpeg -s formatOptions 82 -Z 760 ${S}/pw/shots/feed-phone-${scene}.png --out ${S}/pw/shots/feed-phone-${scene}.jpg >/dev/null && rm ${S}/pw/shots/feed-phone-${scene}.png`);
  }
}
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'FEED PHONE ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
