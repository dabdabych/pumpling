/**
 * Step scrolling for the story on the main page: one gesture, exactly one step.
 *
 * Why not native scrolling with snap. After a swipe a trackpad keeps sending
 * decaying inertia events for another second. The page travels with them, the
 * scene settles between frames — some rows have appeared, some have not left —
 * and then snap drags it to the nearest label, sometimes skipping one.
 *
 * Why `preventDefault` is not enough. Chrome sends some wheel events as
 * non-cancelable: the continuation of a gesture and the inertia. They cannot be
 * cancelled and the browser moves the page itself, on top of the step. That is
 * what the under- and over-scrolling of the first engine rested on: it was only
 * tested with cancelable events.
 *
 * So while somebody is inside the story, native page scrolling is off
 * (`overflow: hidden` on the root). Only the engine moves the page, from stop
 * to stop, with a fixed tween. At rest there is no intermediate state.
 *
 * The browser does not report when fingers are lifted, so a gesture is
 * recognised from the events themselves, which is what `WheelIntent` does. One
 * touch is one step, however long its inertia runs. The third version of the
 * engine counted any rise in the force of a single event as a new swipe, and
 * the force jumps around even on steady inertia: one swipe often gave two steps.
 *
 * Below the story, in the footer, scrolling is ordinary.
 */

import { WheelIntent } from './wheel-intent';

export interface StoryScrollEngineOptions {
  /** The positions of the stops in scroll pixels, ascending. Recomputed on every step. */
  getStops(): number[];
  /** Where the driven stretch ends: below that the page scrolls by itself. */
  getEnd(): number;
  /** Where to take the scroll downwards from the last stop. */
  getExitTarget(): number;
  /** The scroll is already driven by somebody else — a menu transition. */
  isBusy(): boolean;
  /** The input is not ours: a dialog is open, scrolling is blocked. */
  isSuspended(): boolean;
  /** Take the scroll to a position. `done` is called on interruption too. */
  animateTo(top: number, done: () => void): void;
}

/**
 * How long after a native gesture event in the footer its scrolling can still
 * cross the story boundary. With headroom for event delivery delay.
 */
const NATIVE_TAIL_MS = 250;
/** A pause in scrolling after which a screen touch counts as finished. */
const SCROLL_IDLE_MS = 90;
/** A finger swipe on a touch screen. */
const TOUCH_THRESHOLD_PX = 40;
/** The tolerance when comparing a position with a stop. */
const STOP_EPSILON_PX = 4;

export class StoryScrollEngine {
  private animating = false;
  private readonly wheelIntent = new WheelIntent();
  /** A new gesture that arrived during a step — it runs after it. At most one. */
  private queuedDirection = 0;

  private locked = false;
  /**
   * The gesture landed on the last stop — while it lasts, the page stands
   * still. Otherwise the tail of that same swipe took us straight into the
   * footer and Quick start only flashed by. The next gesture scrolls the footer
   * as usual.
   */
  private holdAtEnd = false;
  private readonly root = document.documentElement;
  private previousOverflow = '';
  private previousGutter = '';

  /**
   * Until when a native gesture started in the footer is running. The browser
   * drives it, and its inertia would fly through the boundary into the story.
   * While it runs, the boundary is a wall.
   */
  private nativeFromBelowUntil = -Infinity;
  private touchFromBelow = false;
  private scrollIdleTimer = 0;

  private touchStartY: number | null = null;
  private touchStartedInScroller = false;

  constructor(private readonly options: StoryScrollEngineOptions) {}

  /**
   * A menu transition landed on the last stop: the rest of the current gesture
   * must not immediately take us into the footer.
   */
  holdAtStoryEnd(): void {
    this.holdAtEnd = true;
    this.updateLock();
  }

  /** A step is running: snapping must not pull anything during it. */
  get isAnimating(): boolean {
    return this.animating;
  }

  attach(): void {
    this.previousOverflow = this.root.style.overflow;
    this.previousGutter = this.root.style.scrollbarGutter;
    // We always keep the space for the scrollbar: otherwise it would disappear
    // when blocked and the page would jump sideways by its width.
    this.root.style.scrollbarGutter = 'stable';
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('touchstart', this.onTouchStart, { passive: true });
    window.addEventListener('touchmove', this.onTouchMove, { passive: false });
    window.addEventListener('touchend', this.onTouchEnd, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.updateLock();
  }

  detach(): void {
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('touchstart', this.onTouchStart);
    window.removeEventListener('touchmove', this.onTouchMove);
    window.removeEventListener('touchend', this.onTouchEnd);
    window.removeEventListener('scroll', this.onScroll);
    window.clearTimeout(this.scrollIdleTimer);
    this.root.style.overflow = this.previousOverflow;
    this.root.style.scrollbarGutter = this.previousGutter;
    this.locked = false;
  }

  // ------------------------------------------------------------------ wheel

  private readonly onWheel = (event: WheelEvent): void => {
    // A trackpad pinch arrives as a wheel with ctrlKey — that is zoom, not scrolling.
    if (event.ctrlKey) {
      return;
    }
    const dy = this.normalizeDelta(event.deltaY, event.deltaMode);
    const dx = this.normalizeDelta(event.deltaX, event.deltaMode);
    // Zero and horizontal events carry no movement along the story.
    if (dy === 0 || Math.abs(dx) > Math.abs(dy)) {
      return;
    }
    const now = event.timeStamp || performance.now();
    const direction = Math.sign(dy);
    // The detector sees every event, including the ones that go to the chat
    // feed or the footer. Otherwise the tail of a gesture started there would
    // look new here.
    const { intent, newStream } = this.wheelIntent.feed(now, dy);
    if (newStream) {
      this.nativeFromBelowUntil = -Infinity;
    }
    // Holding on the last stop lasts until the next gesture.
    if (intent !== 0 && this.holdAtEnd) {
      this.holdAtEnd = false;
      this.updateLock();
    }

    if (this.options.isSuspended() || this.canScrollInside(event.target, dy)) {
      return;
    }
    this.updateLock();
    if (!this.isEngaged(direction)) {
      if (direction < 0) {
        this.nativeFromBelowUntil = now + NATIVE_TAIL_MS;
      }
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    // A gesture started in the footer reached the story: its intent has already
    // been given to the footer, and the remaining events give no step.
    if (intent !== 0) {
      this.requestStep(intent);
    }
  };

  // --------------------------------------------------------------- keyboard

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || this.options.isSuspended()) {
      return;
    }
    if (this.isEditableOrActivatable(event.target, event.key)) {
      return;
    }
    let direction = 0;
    switch (event.key) {
      case 'ArrowDown':
      case 'PageDown':
        direction = 1;
        break;
      case 'ArrowUp':
      case 'PageUp':
        direction = -1;
        break;
      case ' ':
        direction = event.shiftKey ? -1 : 1;
        break;
      default:
        return;
    }
    this.updateLock();
    if (!this.isEngaged(direction)) {
      return;
    }
    event.preventDefault();
    // A held key does not flip through the story with a queue of steps.
    if (!event.repeat) {
      this.requestStep(direction);
    }
  };

  // ---------------------------------------------------------------- touch

  private readonly onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      this.touchStartY = null;
      return;
    }
    this.touchFromBelow = this.currentTop() > this.options.getEnd() + STOP_EPSILON_PX;
    this.touchStartY = event.touches[0].clientY;
    this.touchStartedInScroller = this.findScroller(event.target) !== null;
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    if (this.touchStartY === null || this.touchStartedInScroller || this.options.isSuspended()) {
      return;
    }
    const direction = Math.sign(this.touchStartY - event.touches[0].clientY);
    if (direction !== 0 && this.isEngaged(direction) && event.cancelable) {
      event.preventDefault();
    }
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    const startY = this.touchStartY;
    this.touchStartY = null;
    if (startY === null || this.touchStartedInScroller || this.options.isSuspended()) {
      return;
    }
    const distance = startY - event.changedTouches[0].clientY;
    const direction = Math.sign(distance);
    if (Math.abs(distance) < TOUCH_THRESHOLD_PX || !this.isEngaged(direction)) {
      return;
    }
    this.requestStep(direction);
  };

  // --------------------------------------------------- blocking and the wall

  private readonly onScroll = (): void => {
    if (this.touchFromBelow) {
      window.clearTimeout(this.scrollIdleTimer);
      this.scrollIdleTimer = window.setTimeout(() => {
        this.touchFromBelow = false;
        this.updateLock();
      }, SCROLL_IDLE_MS);
    }
    // A gesture from the footer crossed the story boundary: we put the page
    // exactly on the last stop. The scene there is the same as at the boundary,
    // but the position is exact, and the next gesture starts from a stop rather
    // than from the middle.
    if (!this.animating && !this.options.isBusy()) {
      const end = this.options.getEnd();
      const top = this.currentTop();
      const stops = this.options.getStops();
      const last = stops.length ? stops[stops.length - 1] : end;
      if (this.isNativeFromBelow() && top < end) {
        window.scrollTo({ top: last, behavior: 'instant' as ScrollBehavior });
      }
    }
    this.updateLock();
  };

  private isNativeFromBelow(): boolean {
    return this.touchFromBelow || performance.now() <= this.nativeFromBelowUntil;
  }

  /**
   * Native scrolling is off everywhere the engine drives the page: inside the
   * story and at its boundary, while a gesture from the footer is pushing
   * against it.
   */
  private updateLock(): void {
    const top = this.currentTop();
    const end = this.options.getEnd();
    // During a step and a menu transition too: on the last frame of a step
    // towards the end of the story the page is already at the boundary, and
    // without this the block was lifted before the step managed to switch the
    // hold on — the tail of a swipe took us into the footer.
    const shouldLock = top < end - STOP_EPSILON_PX || this.holdAtEnd || this.animating || this.options.isBusy();
    if (shouldLock === this.locked) {
      return;
    }
    this.locked = shouldLock;
    this.root.style.overflow = shouldLock ? 'hidden' : this.previousOverflow;
  }

  // ------------------------------------------------------------------- step

  private requestStep(direction: number): void {
    if (this.options.isBusy()) {
      return;
    }
    if (this.animating) {
      this.queuedDirection = direction;
      return;
    }
    this.step(direction);
  }

  private step(direction: number): void {
    const stops = this.options.getStops();
    const last = stops[stops.length - 1];
    let top = this.currentTop();
    // Between the last stop and the end of the pinning the scene is the same as
    // at the stop. A step up from there "to the last stop" would do nothing.
    if (direction < 0 && last !== undefined && top > last && top <= this.options.getEnd() + STOP_EPSILON_PX) {
      top = last;
    }
    let target: number | undefined;
    if (direction > 0) {
      target = stops.find((stop) => stop > top + STOP_EPSILON_PX) ?? this.options.getExitTarget();
    } else {
      target = [...stops].reverse().find((stop) => stop < top - STOP_EPSILON_PX);
    }
    if (target === undefined || Math.abs(target - this.currentTop()) <= STOP_EPSILON_PX) {
      return;
    }
    this.animating = true;
    if (Math.abs(target - this.options.getEnd()) <= STOP_EPSILON_PX) {
      this.holdAtEnd = true;
    }
    this.updateLock();
    this.options.animateTo(target, () => {
      this.animating = false;
      this.updateLock();
      const queued = this.queuedDirection;
      this.queuedDirection = 0;
      // A menu transition interrupted the step — we do not run the queue after it.
      if (queued !== 0 && !this.options.isBusy()) {
        this.step(queued);
      }
    });
  }

  /**
   * Whether this input is ours. The whole story up to the end of the pinning
   * is. Below that, in the footer, scrolling is ordinary until somebody comes
   * back to the boundary and pulls up.
   */
  private isEngaged(direction: number): boolean {
    if (this.locked) {
      return true;
    }
    const top = this.currentTop();
    const end = this.options.getEnd();
    if (top < end - STOP_EPSILON_PX) {
      return true;
    }
    return direction < 0 && top <= end + STOP_EPSILON_PX;
  }

  private currentTop(): number {
    return window.scrollY || this.root.scrollTop || 0;
  }

  private normalizeDelta(delta: number, mode: number): number {
    if (mode === 1) {
      return delta * 16;
    }
    if (mode === 2) {
      return delta * window.innerHeight;
    }
    return delta;
  }

  /**
   * A wheel over its own scrollable area — the chat feed — has to scroll that
   * and not the story. Once it hits its edge, the gesture goes to the story.
   */
  private canScrollInside(target: EventTarget | null, dy: number): boolean {
    let node = target instanceof Element ? target : null;
    while (node && node !== document.body && node !== this.root) {
      if (this.isScrollable(node)) {
        const atTop = node.scrollTop <= 0;
        const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
        if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  private findScroller(target: EventTarget | null): Element | null {
    let node = target instanceof Element ? target : null;
    while (node && node !== document.body && node !== this.root) {
      if (this.isScrollable(node)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  private isScrollable(node: Element): boolean {
    if (node.scrollHeight <= node.clientHeight + 1) {
      return false;
    }
    const overflowY = getComputedStyle(node).overflowY;
    return overflowY === 'auto' || overflowY === 'scroll';
  }

  /**
   * An input, a button, a link: space types or presses there and the arrows
   * move the caret. We must not take those keys away.
   */
  private isEditableOrActivatable(target: EventTarget | null, key: string): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]')) {
      return true;
    }
    return key === ' ' && !!target.closest('button, a, [role="button"], summary');
  }
}
