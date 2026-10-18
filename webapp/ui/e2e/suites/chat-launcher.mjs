// The chat behind the button next to X in the header.
//
// Asked for on 2026-10-16: the chat left the first screen's second card for an
// icon by the X one that opens to write in. What this checks: the dot for
// messages not seen yet, and that opening clears it for good; on a wide screen
// a popover under the button that Escape and a press outside close, with focus
// back on the button, and that the sign-in dialog it opens does not close it;
// on a phone a sheet over the whole screen with the page held still; the same
// button in the inner pages' header; and nothing in the chat connects before
// somebody opens it.
import { launch, BASE } from '../lib/browser.mjs';
import { mockCard } from '../lib/cta-mock.mjs';
import { mockBubbles, mockChat } from '../lib/home-mock.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

async function open(path, viewport = { width: 1440, height: 900 }, { newestId = 42, seen = null, ctx: given = null } = {}) {
  const ctx = given ?? await b.newContext({ viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  if (!given) {
    await mockCard(ctx, 'openEmpty');
    await mockBubbles(ctx);
    await ctx.route('**/lottery/archive**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ lottery_type: 'dex', window_days: 30, items: [] }) }));
    if (seen !== null) await ctx.addInitScript((value) => localStorage.setItem('pumpling.chat.seen', String(value)), seen);
  }
  await mockChat(ctx, { newestId });
  const p = await ctx.newPage();
  const errors = [];
  const asked = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => { if (/\/chats\//.test(r.url())) asked.push(r.url()); });
  // The dev server's own live-reload socket is not the chat's.
  p.on('websocket', (ws) => { if (!ws.url().includes('ng-cli-ws')) asked.push(`ws ${ws.url()}`); });
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 }); break; }
    catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 60000 });
  await p.waitForSelector('.chat-launch', { timeout: 20000 });
  await p.waitForTimeout(1500);
  return { ctx, p, errors, asked };
}
const dot = (p) => p.locator('.chat-launch .chat-launch__dot').count();
async function settles(read, good, timeout = 5000) {
  const until = Date.now() + timeout;
  let value = await read();
  while (!good(value) && Date.now() < until) { await new Promise((r) => setTimeout(r, 100)); value = await read(); }
  return value;
}

// ------------------------------------------------------------ the dot, and the chat closed costs nothing
{
  const { ctx, p, errors, asked } = await open('/');
  ok(await dot(p) === 1, 'a visitor who has never opened the chat sees the dot on it');
  ok(asked.every((u) => /chats\/default|chats\/1\/messages\?limit=1/.test(u)), `closed, the chat asks only for its newest message, and opens no connection (${asked.map((u) => u.replace(/^.*\/chats/, '/chats')).join(', ')})`);
  const button = p.locator('.chat-launch');
  const said = (await button.innerText()).replace(/\s+/g, ' ').trim();
  ok(await button.getAttribute('aria-expanded') === 'false' && said === 'Open the chat, new messages', `the button says what it does and that there is something new ("${said}")`);
  await button.click();
  await p.waitForSelector('.chat-panel .message', { timeout: 10000 });
  ok(await dot(p) === 0, 'opening it clears the dot');
  ok(await p.evaluate(() => localStorage.getItem('pumpling.chat.seen')) === '42', 'and remembers the newest message as seen');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}
{
  const { ctx, p } = await open('/', { width: 1440, height: 900 }, { seen: 42 });
  ok(await dot(p) === 0, 'seen before, nothing new: no dot');
  await ctx.close();
}
{
  const { ctx, p } = await open('/', { width: 1440, height: 900 }, { seen: 42, newestId: 45 });
  ok(await dot(p) === 1, 'seen before, three new since: the dot again');
  await ctx.close();
}

// ------------------------------------------------------------ a popover on a wide screen
{
  const { ctx, p, errors } = await open('/');
  const button = p.locator('.chat-launch');
  await button.click();
  await p.waitForSelector('.chat-panel', { timeout: 5000 });
  await p.waitForTimeout(350); // the popover comes in from 6px above over 180ms
  const geometry = await p.evaluate(() => {
    const b = document.querySelector('.chat-launch').getBoundingClientRect();
    const panel = document.querySelector('.chat-panel').getBoundingClientRect();
    return { b: { bottom: b.bottom, right: b.right }, panel: { top: panel.top, right: panel.right, left: panel.left, bottom: panel.bottom, width: panel.width, height: panel.height }, vw: innerWidth, vh: innerHeight, focus: document.activeElement?.className ?? '' };
  });
  ok(Math.abs(geometry.panel.right - geometry.b.right) < 2 && geometry.panel.top >= geometry.b.bottom && geometry.panel.top - geometry.b.bottom < 20,
    `it opens under the button, its right edge on the button's (${Math.round(geometry.panel.top - geometry.b.bottom)}px below)`);
  ok(geometry.panel.left >= 0 && geometry.panel.bottom <= geometry.vh && geometry.panel.width <= 380 && geometry.panel.height >= 320, `inside the window, chat-sized (${Math.round(geometry.panel.width)}x${Math.round(geometry.panel.height)})`);
  ok(/chat-panel/.test(geometry.focus), `focus moves into it (${geometry.focus})`);
  ok(await button.getAttribute('aria-expanded') === 'true' && await p.locator('#chat-panel[role="dialog"]').count() === 1, 'the button says it is open, and the panel is a dialog it points to');
  ok(await p.locator('.chat-panel .message').count() === 6, 'with the messages in it');
  // A press inside does not close it.
  await p.locator('.chat-panel .messages').click({ position: { x: 40, y: 40 } });
  ok(await p.locator('.chat-panel').count() === 1, 'a press inside leaves it open');
  // Escape closes it, focus back on the button.
  await p.keyboard.press('Escape');
  await settles(() => p.locator('.chat-panel').count(), (n) => n === 0);
  ok(await p.locator('.chat-panel').count() === 0 && await p.evaluate(() => document.activeElement?.classList.contains('chat-launch')), 'Escape closes it, and focus is back on the button');
  // A press outside closes it, and focus stays where the press went.
  await button.click();
  await p.waitForSelector('.chat-panel', { timeout: 5000 });
  await p.waitForTimeout(300); // nobody presses outside within a frame of opening it
  await p.mouse.click(300, 160);
  await settles(() => p.locator('.chat-panel').count(), (n) => n === 0);
  ok(await p.locator('.chat-panel').count() === 0, 'a press outside closes it');
  // The button toggles.
  await button.click();
  await p.waitForSelector('.chat-panel', { timeout: 5000 });
  await p.waitForTimeout(300);
  await button.click();
  await settles(() => p.locator('.chat-panel').count(), (n) => n === 0);
  ok(await p.locator('.chat-panel').count() === 0, 'the button closes what it opened');
  // Signing in from the chat: the dialog opens over it, and the chat stays.
  await button.click();
  await p.waitForSelector('.chat-panel .composer-locked', { timeout: 5000 });
  await p.locator('.chat-panel .composer-locked').click();
  await p.waitForSelector('mat-dialog-container', { timeout: 10000 });
  await p.locator('mat-dialog-container').click({ position: { x: 20, y: 20 } });
  await p.waitForTimeout(300);
  ok(await p.locator('.chat-panel').count() === 1, 'the sign-in dialog the chat opens, and presses in it, leave the chat open');
  await p.keyboard.press('Escape');
  await settles(() => p.locator('mat-dialog-container').count(), (n) => n === 0);
  ok(await p.locator('.chat-panel').count() === 1, 'Escape closes the sign-in dialog first, the chat stays under it');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ a sheet on a phone
for (const [w, h] of [[390, 844], [320, 568]]) {
  const { ctx, p, errors } = await open('/', { width: w, height: h });
  await p.locator('.chat-launch').click();
  await p.waitForSelector('.chat-panel .message', { timeout: 10000 });
  await p.waitForTimeout(450); // the sheet slides up from below over 260ms
  const g = await p.evaluate(() => {
    const r = document.querySelector('.chat-panel').getBoundingClientRect();
    return { r: [r.left, r.top, r.width, r.height].map(Math.round), vw: innerWidth, vh: innerHeight, modal: document.querySelector('.chat-panel').getAttribute('aria-modal'), blocked: document.documentElement.classList.contains('cdk-global-scrollblock') };
  });
  ok(g.r[0] === 0 && g.r[1] === 0 && g.r[2] === g.vw && g.r[3] === g.vh, `${w}x${h}: the chat takes the whole screen (${g.r.join(',')})`);
  ok(g.modal === 'true' && g.blocked, `${w}x${h}: as a modal sheet, with the page behind it held still`);
  const composer = await p.evaluate(() => { const r = document.querySelector('.chat-panel .composer-locked').getBoundingClientRect(); return r.bottom <= innerHeight && r.top > 0; });
  ok(composer, `${w}x${h}: the place to type is on screen`);
  // Tab stays inside the sheet.
  let left = false;
  for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); if (!(await p.evaluate(() => !!document.activeElement?.closest('.chat-panel')))) left = true; }
  ok(!left, `${w}x${h}: Tab stays inside the sheet`);
  await p.locator('.chat-panel__close').click();
  await settles(() => p.locator('.chat-panel').count(), (n) => n === 0);
  ok(await p.locator('.chat-panel').count() === 0 && !(await p.evaluate(() => document.documentElement.classList.contains('cdk-global-scrollblock'))), `${w}x${h}: the close button closes it and lets the page scroll again`);
  ok(errors.length === 0, `${w}x${h}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// ------------------------------------------------------------ the inner pages' header too
{
  const { ctx, p, errors } = await open('/archive');
  ok(await p.locator('app-site-header .chat-launch').count() === 1, 'the archive\'s header has the chat button');
  await p.locator('app-site-header .chat-launch').click();
  await p.waitForSelector('.chat-panel .message', { timeout: 10000 });
  ok(true, 'and it opens the chat there');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'CHAT LAUNCHER ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
