// The card for a post: it draws, exports, and the link and post text are there.
import { launch } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { SCENARIOS, mockCurrent, MINTS } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const S = process.env.S || '/private/tmp/claude-501/-Users-georgiy-qres/5d0d11e6-15d5-4eae-9eac-a9cc508dc8e9/scratchpad';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] });
await mockCurrent(ctx, () => SCENARIOS.open());
const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });

const save = async (name) => {
  const data = await p.locator('.share__canvas').evaluate((el) => el.toDataURL('image/png'));
  writeFileSync(`${S}/pw/shots/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  execSync(`sips -s format jpeg -s formatOptions 70 -Z 1000 ${S}/pw/shots/${name}.png --out ${S}/pw/shots/${name}.jpg >/dev/null`);
  return data.length;
};

// a card for somebody else's coin is made without signing in: it is about the coin, not about you
ok(await p.evaluate(() => !localStorage.getItem('jwt')), 'nobody is signed in for this run');

// a card about a coin
await p.locator('.coin-row__card').first().click();
await p.waitForSelector('app-share-dialog', { timeout: 8000 });
await p.waitForSelector('.share__preview.is-ready', { timeout: 15000 });
ok(true, 'the card dialog opens from a coin row without signing in');
ok(await p.locator('app-auth-dialog').count() === 0, 'it does not ask to sign in first');
const size = await save('card-coin');
ok(size > 20000, `the canvas is not tainted and exports a file (${size} chars of data url)`);
// The mock's logo address does not resolve, so the card has no picture of the
// coin: its initials stand in, on green in the top right, as in the coin list.
// The point is 12 px inside that square (share-card.ts: 132 px at x 978, y 174).
const badgePixel = (page) => page.locator('.share__canvas').evaluate((el) => Array.from(el.getContext('2d').getImageData(990, 186, 1, 1).data.slice(0, 3)));
const coinPixel = await badgePixel(p);
ok(coinPixel.join() === '143,255,175', `a coin without a picture shows its initials on green (${coinPixel})`);
const xHref = await p.locator('.share__button--x').getAttribute('href');
ok(/MOCHI/.test(decodeURIComponent(xHref)) && /pumpling/.test(decodeURIComponent(xHref)), `the post text is ready ${decodeURIComponent(xHref).slice(0, 120)}`);
// The link carries the card: /s/ is answered by the server, which gives X the
// card's tags and sends a person on to the pool (share_router.py).
const coinLink = new RegExp(`/s/coin/128/${MINTS.mochi}\\?v=[0-9a-z]+$`);
const postUrl = new URL(xHref).searchParams.get('url') ?? '';
ok(coinLink.test(postUrl), `the post links to this coin's card (${postUrl})`);
// Read before anything is copied: the note then shows the feedback instead.
const note = (await p.locator('.share__note').innerText()).trim();
ok(/X shows this card/.test(note) && !/attach it yourself/.test(note), `the note says the link brings the card (${note})`);
await p.locator('.share__button', { hasText: 'Copy link' }).click();
await p.waitForTimeout(400);
const clip = await p.evaluate(() => navigator.clipboard.readText());
ok(coinLink.test(clip), `copy link puts the same link in the clipboard (${clip})`);
await p.screenshot({ path: `${S}/pw/shots/share-dialog.png` });
execSync(`sips -s format jpeg -s formatOptions 65 -Z 900 ${S}/pw/shots/share-dialog.png --out ${S}/pw/shots/share-dialog.jpg >/dev/null`);
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

// a card about the whole pool
await p.locator('.pool-link--button').click();
await p.waitForSelector('.share__preview.is-ready', { timeout: 15000 });
await save('card-pool');
ok(true, 'the pool card renders too');
const poolPixel = await badgePixel(p);
ok(poolPixel.join() !== '143,255,175', `the pool card has no coin square (${poolPixel})`);
const poolPost = new URL(await p.locator('.share__button--x').getAttribute('href')).searchParams.get('url') ?? '';
ok(/\/s\/pool\/128\?v=[0-9a-z]+$/.test(poolPost), `the pool post links to the pool's card (${poolPost})`);
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// the link from a post highlights the coin
await p.goto(`${BASE}/pool?coin=${MINTS.zapz}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p.waitForTimeout(1500);
const highlighted = await p.locator('.coin-row--highlight .coin-row__ticker').innerText().catch(() => '');
ok(highlighted === '$ZAPZ', `the link from a post highlights that coin (${highlighted})`);

// phone: a bottom sheet, the buttons in two rows
const phone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['clipboard-read', 'clipboard-write'] });
await mockCurrent(phone, () => SCENARIOS.open());
const p2 = await phone.newPage();
p2.on('pageerror', (e) => errors.push(e.message));
await p2.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 });
await p2.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p2.locator('.coin-row__card').first().click();
await p2.waitForSelector('.share__preview.is-ready', { timeout: 15000 });
const box = await p2.locator('.share').boundingBox();
ok(box.width <= 390 && box.x >= 0, `phone: the card sheet fits the screen ${JSON.stringify(box)}`);
ok(await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, 'phone: no horizontal scroll');
await p2.screenshot({ path: `${S}/pw/shots/share-phone.png` });
execSync(`sips -s format jpeg -s formatOptions 65 -Z 700 ${S}/pw/shots/share-phone.png --out ${S}/pw/shots/share-phone.jpg >/dev/null`);
await phone.close();

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'SHARE CARD ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
