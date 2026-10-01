/**
 * The live Quick start rows under a mouse and under a finger.
 *
 * Mouse. Over the "Pick any memecoin" and "Get your tokens" rows the system
 * cursor is hidden and an ANY or Let's go plate travels with the mouse. The plate
 * lands straight where the mouse is: a row often arrives under a stationary mouse
 * — by scrolling or by a menu transition — and the browser sends only the enter,
 * with no movement. The coordinates used to come from movement, and the plate
 * landed in the top left corner of the screen. If the row travels out from under
 * a stationary mouse the plate fades: Chrome reports that itself, while Safari and
 * Firefox only do when the mouse moves.
 *
 * Finger. There is no cursor, so there are no plates. Hover effects stuck on a
 * phone after a tap: the plate hung over the page and travelled with the screen,
 * and the coins fell endlessly. So hover is mouse only (`@media (hover: hover)`
 * in the styles, and Tailwind 4 puts every `hover:` and `group-hover:` under the
 * same query). Under a finger the rows show their mouse-over looks as a walk
 * through the steps: once Quick start is on screen and the page has come to
 * rest, 01 plays for a few seconds, then 02, and so on to 05, one at a time.
 * The coins fall, Add SOL turns into COMMIT SOL, Share the pool into Post it on
 * X, the clock comes out, Get your tokens goes black. Taking the list off the
 * screen stops the walk; bringing it back starts it again from 01.
 *
 * Why at rest and as a whole. The first version played each row by itself as
 * it crossed a line on the screen. A real swipe carries the page on with its
 * momentum, so the rows went off as they flew past, several at once and in
 * whatever order the page moved, and a row that never left the screen did not
 * play at all. Measured with touch swipes on 2026-10-01.
 *
 * Two differences from the mouse: the first title stays put (under a mouse it
 * makes way for the ANY plate, and there is no plate here), and the line under
 * Add SOL turns light with its row. The look is the row's `qres-quick-play`
 * class (`qres-coin-hover--burst` for the coins), styled next to each hover rule.
 *
 * On the long page (phones) "on screen" is measured. In the pinned story
 * (768px and wider: tablets, most phones on their side) the rows sit on screen
 * the whole time, only hidden, so the page calls `setShown` when Quick start
 * becomes the step on show.
 *
 * The listeners are attached outside Angular: mouse movement must not trigger
 * change detection for the whole page.
 */

/** The plate's offset from the cursor tip, px: to the right and slightly above. */
const BUBBLE_OFFSETS: Record<string, [number, number]> = {
  any: [18, -28],
  go: [18, -30]
};

/**
 * How long each row holds its look in the walk, ms: long enough to read the
 * step and see its motion. Add SOL's mark makes two passes in it (2 × 1.34s
 * with a 0.1s pause between them, `bindSolCommitHover` in the page).
 */
const STEP_MS = 3500;

/** The coins fade this long when their step ends, ms: `.qres-coin-hover--fading` in the styles. */
const COIN_FADE_MS = 400;

/** The page counts as at rest this long after its last scroll event, ms. Momentum keeps sending them. */
const REST_MS = 180;

/**
 * The list counts as on screen when its first row is whole below the header
 * and this share of it is in view, of as much of it as the screen can hold.
 */
const START_SHARE = 0.8;

/** Below this share in view the list has been taken away: the walk stops and may start again. */
const LEAVE_SHARE = 0.4;

export interface QuickStartHooks {
  /** How much of the top of the screen the header covers, px. */
  coveredTop?(): number;
  /** A row's step begins: whatever it animates from script starts here. */
  playRow?(row: HTMLElement): void;
  /** Its step ends, or the walk stops. */
  stopRow?(row: HTMLElement): void;
}

export interface QuickStartPointer {
  /** The pinned story: Quick start became the step on show, or stopped being it. */
  setShown(shown: boolean): void;
  dispose(): void;
}

export function bindQuickStartPointer(root: HTMLElement, hooks: QuickStartHooks = {}): QuickStartPointer {
  const cleanups: Array<() => void> = [];

  root.querySelectorAll<HTMLElement>('[data-qres-cursor]').forEach((row) => {
    const name = row.dataset['qresCursor'] ?? '';
    const bubble = root.querySelector<HTMLElement>(`[data-qres-cursor-bubble="${name}"]`);
    if (!bubble) {
      return;
    }
    const [dx, dy] = BUBBLE_OFFSETS[name] ?? [18, -28];
    let x = 0;
    let y = 0;
    let frame = 0;
    let visible = false;

    const place = () => {
      frame = 0;
      bubble.style.transform = `translate3d(${x + dx}px, ${y + dy}px, 0)`;
    };
    const isMouse = (event: PointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';
    const show = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      place();
      if (!visible) {
        visible = true;
        bubble.classList.add('is-visible');
      }
    };
    const hide = () => {
      if (!visible) {
        return;
      }
      visible = false;
      bubble.classList.remove('is-visible');
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const onEnter = (event: PointerEvent) => {
      if (isMouse(event)) {
        show(event);
      }
    };
    const onMove = (event: PointerEvent) => {
      if (!isMouse(event)) {
        return;
      }
      if (!visible) {
        show(event);
        return;
      }
      x = event.clientX;
      y = event.clientY;
      if (!frame) {
        frame = requestAnimationFrame(place);
      }
    };
    const onScroll = () => {
      if (!visible) {
        return;
      }
      const hit = document.elementFromPoint(x, y);
      if (!hit || !row.contains(hit)) {
        hide();
      }
    };

    row.addEventListener('pointerenter', onEnter);
    row.addEventListener('pointermove', onMove);
    row.addEventListener('pointerleave', hide);
    window.addEventListener('scroll', onScroll, { passive: true });
    cleanups.push(() => {
      row.removeEventListener('pointerenter', onEnter);
      row.removeEventListener('pointermove', onMove);
      row.removeEventListener('pointerleave', hide);
      window.removeEventListener('scroll', onScroll);
      hide();
    });
  });

  // Finger. Never under a mouse (the hover does it there), never in reduced motion.
  const noHover = window.matchMedia('(hover: none)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fingerOnly = () => noHover.matches && !reducedMotion.matches;
  const staticLayout = () => root.classList.contains('qres-story--static');
  const list = root.querySelector<HTMLElement>('.qres-quick-list');
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-qres-quick-item]'));
  const isCoinRow = (row: HTMLElement) => row.classList.contains('qres-coin-hover');

  // The walk: the row on show, or -1 when it is not running.
  let step = -1;
  let stepTimer = 0;
  // Starts once per visit: taking the list away arms it again.
  let armed = true;
  let fadeTimer = 0;

  const dropCoins = () => {
    window.clearTimeout(fadeTimer);
    fadeTimer = 0;
    rows.filter(isCoinRow).forEach((row) => row.classList.remove('qres-coin-hover--burst', 'qres-coin-hover--fading'));
  };

  const lightUp = (row: HTMLElement) => {
    if (isCoinRow(row)) {
      dropCoins();
      row.classList.add('qres-coin-hover--burst');
    } else {
      row.classList.add('qres-quick-play');
      hooks.playRow?.(row);
    }
  };

  // The coins fade rather than vanish mid-fall; everything else goes back the
  // way it came, by the transitions it already has.
  const putOut = (row: HTMLElement) => {
    if (isCoinRow(row)) {
      row.classList.add('qres-coin-hover--fading');
      fadeTimer = window.setTimeout(dropCoins, COIN_FADE_MS);
    } else {
      row.classList.remove('qres-quick-play');
      hooks.stopRow?.(row);
    }
  };

  const advance = () => {
    if (step >= 0) {
      putOut(rows[step]);
    }
    step += 1;
    if (step >= rows.length) {
      step = -1;
      return;
    }
    lightUp(rows[step]);
    stepTimer = window.setTimeout(advance, STEP_MS);
  };

  const start = () => {
    if (step >= 0 || rows.length === 0) {
      return;
    }
    armed = false;
    advance();
  };

  const stop = () => {
    window.clearTimeout(stepTimer);
    if (step >= 0 && !isCoinRow(rows[step])) {
      rows[step].classList.remove('qres-quick-play');
      hooks.stopRow?.(rows[step]);
    }
    step = -1;
    dropCoins();
    armed = true;
  };

  // The long page: how much of the list is in view, below the header.
  const inView = () => {
    if (!list || rows.length === 0) {
      return { share: 0, firstWhole: false };
    }
    const top = Math.max(0, hooks.coveredTop?.() ?? 0);
    const bottom = window.innerHeight;
    const box = list.getBoundingClientRect();
    const first = rows[0].getBoundingClientRect();
    const seen = Math.max(0, Math.min(box.bottom, bottom) - Math.max(box.top, top));
    const room = Math.min(box.height, bottom - top);
    return {
      share: room > 0 ? seen / room : 0,
      // A pixel's grace either way for rounding.
      firstWhole: first.top >= top - 1 && first.bottom <= bottom + 1
    };
  };

  const watching = () => fingerOnly() && staticLayout();
  let restTimer = 0;
  let frame = 0;

  // At rest: start if the list is on screen, or arm again if it was taken away.
  const atRest = () => {
    restTimer = 0;
    if (!watching()) {
      return;
    }
    const view = inView();
    if (view.share < LEAVE_SHARE) {
      if (!armed) {
        stop();
      }
    } else if (armed && view.share >= START_SHARE && view.firstWhole) {
      start();
    }
  };

  // Taking the list away stops the walk at once, without waiting for rest:
  // a row playing out of sight would be the next one missed.
  const onScroll = () => {
    if (!watching()) {
      return;
    }
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!armed && inView().share < LEAVE_SHARE) {
          stop();
        }
      });
    }
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(atRest, REST_MS);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  // The page can open already at Quick start (a link to it, a restored scroll).
  restTimer = window.setTimeout(atRest, REST_MS);

  cleanups.push(() => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    window.clearTimeout(restTimer);
    cancelAnimationFrame(frame);
    window.clearTimeout(stepTimer);
    step = -1;
    dropCoins();
    rows.forEach((row) => row.classList.remove('qres-quick-play'));
  });

  // The pinned story says itself when Quick start is the step on show.
  let shown = false;

  return {
    setShown(next: boolean) {
      if (!next) {
        shown = false;
        // Also a walk left from the long page when the device turned.
        if (step >= 0 || !armed) {
          stop();
        }
        return;
      }
      if (shown) {
        return;
      }
      shown = true;
      if (fingerOnly() && !staticLayout()) {
        start();
      }
    },
    dispose() {
      cleanups.forEach((cleanup) => cleanup());
    }
  };
}
