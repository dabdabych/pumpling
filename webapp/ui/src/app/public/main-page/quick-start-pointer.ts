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
 * and the coins fell endlessly. Now hover is mouse only (`@media (hover: hover)`
 * in the styles) and on a phone the coins fall once, when the row appears on screen.
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
 * How long one shower of coins lasts on a phone, ms: the latest coin starts at
 * 4.6 × 0.35 ≈ 1.6s and falls until 6.5s.
 */
const COIN_BURST_MS = 8300;

export function bindQuickStartPointer(root: HTMLElement): () => void {
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

  const coinRow = root.querySelector<HTMLElement>('.qres-coin-hover');
  if (coinRow && typeof IntersectionObserver !== 'undefined') {
    const noHover = window.matchMedia('(hover: none)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer = 0;
    const observer = new IntersectionObserver((entries) => {
      const entered = entries.some((entry) => entry.isIntersecting);
      // Only on an ordinary long page: in the pinned story the row is
      // geometrically on screen the whole time, just hidden until its step.
      const staticLayout = root.classList.contains('qres-story--static');
      if (!entered || !noHover.matches || reducedMotion.matches || !staticLayout || timer) {
        return;
      }
      coinRow.classList.add('qres-coin-hover--burst');
      timer = window.setTimeout(() => {
        coinRow.classList.remove('qres-coin-hover--burst');
        timer = 0;
      }, COIN_BURST_MS);
    }, { threshold: 0.6 });
    observer.observe(coinRow);
    cleanups.push(() => {
      observer.disconnect();
      window.clearTimeout(timer);
      coinRow.classList.remove('qres-coin-hover--burst');
    });
  }

  return () => cleanups.forEach((cleanup) => cleanup());
}
