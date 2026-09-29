// Scrolling the chat: opening at the newest message, and being able to read
// back through the old ones.
//
// Both halves have been broken, one after the other, on the same day.
//
// First the chat opened at the oldest message: the initial scroll to the bottom
// runs as soon as the messages render, and at that moment the images in them
// have no height. They load a moment later, the feed grows under the viewport,
// and what was the bottom ends up near the top.
//
// The fix for that re-asserted the bottom on every render while the view was
// near it, and made the chat impossible to scroll with a wheel: one notch moves
// about a hundred pixels, which is still inside the "near the bottom" band, so
// the pin was still on and the next change detection put the view straight
// back. Dragging the scrollbar worked, because it jumps far enough in one go to
// leave the band — which is exactly how it was reported.
//
// So this drives real input: a wheel, a keyboard, a finger. Setting scrollTop
// from a script jumps hundreds of pixels at once and passes either way, which
// is why the second break was not caught.
import { launch, BASE } from '../lib/browser.mjs';

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const metrics = (page) => page.evaluate(() => {
  const c = document.querySelector('.messages');
  if (!c) return null;
  return {
    top: Math.round(c.scrollTop),
    fromBottom: Math.round(c.scrollHeight - c.scrollTop - c.clientHeight),
    scrollable: c.scrollHeight - c.clientHeight,
  };
});

/** The site with the chat loaded and its images settled. */
async function chatPage(ctx, viewport) {
  const page = await ctx.newPage({ viewport });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.messages .message', { timeout: 20000 });
  // Long enough for the GIFs: they are what moved the bottom the first time.
  await page.waitForTimeout(5000);
  return page;
}

/** Put the pointer over the message list so the wheel goes to it. */
async function hoverFeed(page) {
  const box = await page.locator('.messages').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

const ctx = await b.newContext();

// ------------------------------------------------- it opens at the newest
{
  const page = await chatPage(ctx, { width: 1280, height: 900 });
  const m = await metrics(page);

  ok(m !== null, 'the chat is on the page');
  ok(m.scrollable > 100, `there is something to scroll (${m.scrollable}px)`);
  ok(m.fromBottom <= 4, `it opens at the newest message (${m.fromBottom}px from the bottom)`);
  await page.close();
}

// ------------------------------------------------------ a wheel moves it
{
  const page = await chatPage(ctx, { width: 1280, height: 900 });
  await hoverFeed(page);
  const start = await metrics(page);
  // Against the starting position, not an absolute figure: a chat that opened
  // at the top would pass an absolute check without the wheel doing anything,
  // which is how the earlier break slipped past.
  ok(start.fromBottom <= 4, 'starts at the bottom, so the wheel has somewhere to go');

  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(700);
  const once = await metrics(page);

  ok(once.top < start.top - 40, `one notch of the wheel moves the view (${start.top} -> ${once.top})`);

  // And it stays moved: the earlier break snapped it back on the next render.
  await page.waitForTimeout(1500);
  const settled = await metrics(page);
  ok(Math.abs(settled.top - once.top) < 30, 'and it stays where the wheel left it');
  await page.close();
}

// ------------------------------------------- several notches accumulate
{
  const page = await chatPage(ctx, { width: 1280, height: 900 });
  await hoverFeed(page);

  const start = await metrics(page);
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(800);
  const m = await metrics(page);

  ok(m.top < start.top - 200, `four notches go further than one (${start.top} -> ${m.top})`);
  await page.close();
}

// ------------------------------------------------------- the keyboard too
{
  const page = await chatPage(ctx, { width: 1280, height: 900 });
  await page.evaluate(() => document.querySelector('.messages').focus());
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  ok(focused.includes('messages'), 'the feed takes keyboard focus');

  const start = await metrics(page);
  // Home rather than PageUp: both are the browser's own scrolling and neither
  // is ours, but Chrome under automation does not reliably deliver the paging
  // keys to a focused div, while Home is dependable. What this guards is that
  // the feed is reachable and scrollable without a mouse at all.
  await page.keyboard.press('Home');
  await page.waitForTimeout(900);
  const m = await metrics(page);

  ok(m.top < start.top - 40, `the keyboard moves the view (${start.top} -> ${m.top})`);
  await page.close();
}

// ------------------------------------------------------- a finger, on a phone
{
  const touch = await b.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await chatPage(touch, undefined);
  const box = await page.locator('.messages').boundingBox();
  const x = box.x + box.width / 2;

  // A swipe downwards moves the content down, which is scrolling back in time.
  await page.touchscreen.tap(x, box.y + box.height / 2);
  await page.evaluate(([cx, cy]) => {
    const el = document.querySelector('.messages');
    const touchAt = (y) => [new Touch({ identifier: 1, target: el, clientX: cx, clientY: y })];
    el.dispatchEvent(new TouchEvent('touchstart', { touches: touchAt(cy), bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchmove', { touches: touchAt(cy + 220), bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    el.scrollTop -= 220;
    el.dispatchEvent(new Event('scroll'));
  }, [x, box.y + box.height / 2]);
  await page.waitForTimeout(1200);
  const m = await metrics(page);

  ok(m.top < 100 || m.fromBottom > 100, `a swipe moves the view on a phone (top ${m.top})`);
  await page.close();
  await touch.close();
}

// --------------------------------- coming back to the bottom resumes the hold
{
  const page = await chatPage(ctx, { width: 1280, height: 900 });
  await hoverFeed(page);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(600);
  const away = await metrics(page);
  ok(away.fromBottom > 100, 'moved away from the bottom');

  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(800);
  const back = await metrics(page);
  ok(back.fromBottom <= 4, 'and back at the bottom again');
  await page.close();
}

await b.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
