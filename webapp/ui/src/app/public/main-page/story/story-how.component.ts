import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy, QueryList, ViewChild, ViewChildren } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';

import { MOCHI, StoryBuy, StoryCommit, TOAD, ZAPZ } from './story-how-data';
import {
  BUY_TARGET_SOL,
  buyFrame,
  buyRowAge,
  buyRows,
  clockText,
  COMMIT_EVERY_MS,
  DRAW_AFTER,
  DRAW_BEFORE,
  feedFrame,
  payoutDurationMs,
  payoutFrame,
  PRICE_POINTS,
  PRICE_TICK_MS,
  priceAt,
  priceAxis,
  priceFrame,
  priceHead,
  priceScaleWindow,
  priceSeries
} from './story-how-scenes';

/**
 * "How it works": one round through five phases — the pool is open, everything
 * is visible, the pool is locked, an hour of buying, tokens to participants. A
 * round scale in real time runs across the top, and on the right the same pool
 * card changes its contents. The numbers run through: the pool grows from 13 to
 * 73 SOL, the draw gives 47 / 28 / 22 out of 97 SOL after the 3% fee — the
 * shares move in both directions.
 *
 * The phases appear under the story timeline on the main page, through
 * `data-how-*` attributes. Inside the active phase the card lives on its own:
 * the commit feed runs, the timer ticks, the price crawls, the draw spins,
 * candles accumulate and tokens go out. That way the section reads as a working
 * product rather than five pictures.
 *
 * The frames are computed by `story-how-scenes.ts`, pure functions with no DOM.
 * Here there is only starting, stopping and writing values to the screen:
 * numbers and paths are written straight into the elements, outside the Angular
 * zone, so sixty frames a second do not become sixty change detection runs.
 */
/** How often we rewrite the price number, ms. */
const PRICE_TEXT_EVERY_MS = 320;

/** The space on the right for the "now" dot, in pixels. */
const PRICE_DOT_ROOM = 7;

/** The coin price at the start of the series: the series counts from one and we show dollars. */
const PRICE_BASE_USD = 0.0000182;

@Component({
  selector: 'app-story-how',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './story-how.component.html',
  styleUrls: ['./story-how.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StoryHowComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** The story is driven by the timeline: a visibility observer is only needed without one. */
  private timelineDrives = false;

  /** Which phase is on screen: 1..5, null means the section is not visible. */
  @Input() activeStep: number | null = null;

  @ViewChild('poolTotal') private poolTotalRef?: ElementRef<HTMLElement>;
  @ViewChild('poolClock') private poolClockRef?: ElementRef<HTMLElement>;
  @ViewChild('poolFill') private poolFillRef?: ElementRef<HTMLElement>;
  @ViewChild('priceLine') private priceLineRef?: ElementRef<SVGPathElement>;
  @ViewChild('priceArea') private priceAreaRef?: ElementRef<SVGPathElement>;
  @ViewChild('priceDot') private priceDotRef?: ElementRef<SVGCircleElement>;
  @ViewChild('priceValue') private priceValueRef?: ElementRef<HTMLElement>;
  @ViewChild('priceSvg') private priceSvgRef?: ElementRef<SVGSVGElement>;
  @ViewChild('boughtValue') private boughtValueRef?: ElementRef<HTMLElement>;
  @ViewChild('boughtBar') private boughtBarRef?: ElementRef<HTMLElement>;
  @ViewChildren('payoutBar') private payoutBars?: QueryList<ElementRef<HTMLElement>>;
  @ViewChildren('payoutTokens') private payoutTokens?: QueryList<ElementRef<HTMLElement>>;

  readonly nodes = [
    { label: 'Open', at: 0 },
    { label: 'Public', at: 100 / 3 },
    { label: 'Locked', at: 200 / 3 },
    { label: 'Buying', at: 250 / 3 },
    { label: 'Sent', at: 100 }
  ];

  readonly board = [
    { coin: MOCHI, sol: 50 },
    { coin: TOAD, sol: 30 },
    { coin: ZAPZ, sol: 20 }
  ];

  readonly shares = [
    { coin: MOCHI, before: DRAW_BEFORE[0], after: DRAW_AFTER[0] },
    { coin: TOAD, before: DRAW_BEFORE[1], after: DRAW_AFTER[1] },
    { coin: ZAPZ, before: DRAW_BEFORE[2], after: DRAW_AFTER[2] }
  ];


  readonly payouts = [
    { wallet: '7xQ…p2', sol: 30, tokens: 1_440_000, share: 60 },
    { wallet: 'Bn4…zK', sol: 15, tokens: 720_000, share: 30 },
    { wallet: '3Fh…9w', sol: 5, tokens: 240_000, share: 10 }
  ];

  /** The price candles on the buying card: a growing series, as from a run of purchases. */
  readonly candles = [
    { open: 56, close: 50 },
    { open: 50, close: 52 },
    { open: 52, close: 44 },
    { open: 44, close: 39 },
    { open: 39, close: 41 },
    { open: 41, close: 32 },
    { open: 32, close: 26 },
    { open: 26, close: 19 },
    { open: 19, close: 22 },
    { open: 22, close: 11 }
  ].map((candle, index) => ({
    ...candle,
    x: 8 + index * 25,
    top: Math.min(candle.open, candle.close),
    height: Math.max(3, Math.abs(candle.open - candle.close)),
    up: candle.close < candle.open
  }));

  readonly mochi = MOCHI;
  readonly buyTarget = BUY_TARGET_SOL;
  /** The round's coins: the buying covers all three, and that is visible in the card header. */
  readonly buyingCoins = [MOCHI, TOAD, ZAPZ];
  readonly buyRowAge = buyRowAge;

  // --- the state of the live scenes that Angular draws
  poolId = 128;
  poolLocked = false;
  /** The starting state is an already filled card: on a phone and in reduced
   *  motion the scene is not animated, and empty lists would look like broken
   *  layout. */
  feedRows: StoryCommit[] = feedFrame(0).rows;
  buyFeed: StoryBuy[] = buyRows(0);
  visibleCandles = 4;

  /** The scene on screen when the section is not driven by the timeline. */
  private visibleStep: number | null = null;
  private observer?: IntersectionObserver;
  private frameId = 0;
  private startedAt = 0;
  private runningStep: number | null = null;
  /** The amounts shown on screen: they catch up with a step over a couple of frames, without a jerk. */
  private shownPoolSol = 0;
  private shownBoughtSol = 0;
  private lastTickAt = 0;
  /** The ready price series: the points are not recomputed every frame, a frame only shifts them. */
  private priceValues: number[] = [];
  /** The chart frame size in pixels: the viewBox is fitted to it, otherwise the
   *  round "now" dot would stretch into an oval. */
  private priceBox = { width: 320, height: 56 };
  private priceResize?: ResizeObserver;
  private priceWroteAt = -1e9;
  private rowResize?: ResizeObserver;
  private feedLists: HTMLElement[] = [];
  /** The chart scale bounds: they travel behind the visible window so the line does not breathe. */
  private priceMin = 0;
  private priceMax = 1;
  private readonly reducedMotion = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    private readonly host: ElementRef<HTMLElement>
  ) {}

  ngOnChanges(): void {
    if (this.activeStep !== null) {
      // The story is driven by the timeline: from now on visibility decides nothing.
      this.timelineDrives = true;
    }
    this.applyStep(this.activeStep ?? (this.timelineDrives ? null : this.visibleStep));
  }

  ngAfterViewInit(): void {
    this.watchPriceBox();
    this.watchRowHeight();
    // On a phone and in reduced motion there is no story timeline: the sections
    // simply lie in the page flow. Then visibility drives the scene — otherwise
    // the cards would stand dead.
    if (typeof IntersectionObserver !== 'function') {
      return;
    }
    const scenes = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-how-scene]'));
    if (scenes.length === 0) {
      return;
    }
    // We keep a fresh visibility fraction for every scene and pick the most
    // visible one each time. Handling the events one by one is not possible:
    // one batch contains several records about the same scene, and the one that
    // arrived last used to switch off the scene already chosen — on a phone the
    // card just stood dead.
    const ratios = new Map<HTMLElement, number>();
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        ratios.set(entry.target as HTMLElement, entry.isIntersecting ? entry.intersectionRatio : 0);
      }
      let best: number | null = null;
      let bestRatio = 0.45;
      for (const [element, ratio] of ratios) {
        // Hidden phases also "intersect the screen": in the layout they stay
        // where they are, they are simply invisible. Without this check the
        // scene would run in the parts of the story where the section is off screen.
        if (ratio > bestRatio && getComputedStyle(element).visibility !== 'hidden') {
          best = Number(element.dataset['howScene']);
          bestRatio = ratio;
        }
      }
      this.visibleStep = best;
      // While the timeline drives the story, visibility does not interfere.
      // Otherwise a scene would come alive where the section has already left
      // the screen: the timeline hides the phases at the end of its animation
      // and the observer never learns about it.
      if (this.activeStep === null && !this.timelineDrives) {
        this.zone.run(() => this.applyStep(this.visibleStep));
      }
    }, { threshold: [0, 0.25, 0.45, 0.6, 0.8, 1] });
    this.zone.runOutsideAngular(() => scenes.forEach((scene) => this.observer?.observe(scene)));
  }

  private applyStep(step: number | null): void {
    if (step === this.runningStep) {
      return;
    }
    this.stop();
    this.runningStep = step;
    if (step !== null) {
      this.start();
    }
  }

  ngOnDestroy(): void {
    this.stop();
    this.observer?.disconnect();
    this.priceResize?.disconnect();
    this.rowResize?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Tokens in a delivery row: 1.44M, 720K. */
  formatTokens(value: number): string {
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
      return `${Math.round(value / 1_000)}K`;
    }
    return String(Math.round(value));
  }


  // ---------------------------------------------------------------- the engine

  private start(): void {
    if (this.reducedMotion) {
      // Reduced motion: we show the scene in its finished form and stay quiet.
      this.measureRows();
      this.renderStatic();
      return;
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    // The scene has just appeared: the card has its size, so this is the moment
    // to measure the row again.
    this.measureRows();
    this.startedAt = performance.now();
    this.resetSceneState();
    this.zone.runOutsideAngular(() => {
      this.frameId = requestAnimationFrame(this.tick);
    });
  }

  private stop(): void {
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.stop();
      return;
    }
    if (this.runningStep !== null && !this.frameId && !this.reducedMotion) {
      // Back in the tab: we continue from the same place in the script.
      this.zone.runOutsideAngular(() => {
        this.frameId = requestAnimationFrame(this.tick);
      });
    }
  };

  /**
   * The number shown catches up with a step: the target changes in a jump while
   * the value on screen travels there over several frames. That way every event
   * is visible without the number twitching.
   */
  private approach(shown: number, target: number, deltaMs: number, overMs = 450): number {
    if (Math.abs(target - shown) < 0.0005) {
      return target;
    }
    // It travels in roughly `overMs`, whatever the frame rate.
    const factor = 1 - Math.pow(0.02, deltaMs / overMs);
    return shown + (target - shown) * factor;
  }

  private readonly tick = (now: number): void => {
    const elapsed = now - this.startedAt;
    // The upper limit stops it "eating" a whole step in one frame when the
    // browser has stalled: the travel still stretches over several frames.
    const deltaMs = this.lastTickAt ? Math.min(40, now - this.lastTickAt) : 16;
    this.lastTickAt = now;
    switch (this.runningStep) {
      case 1:
        this.renderFeed(elapsed, deltaMs);
        break;
      case 2:
        this.renderPrice(elapsed, deltaMs);
        break;
      case 4:
        this.renderBuys(elapsed, deltaMs);
        break;
      case 5:
        this.renderPayouts(elapsed);
        break;
    }
    this.frameId = requestAnimationFrame(this.tick);
  };

  private resetSceneState(): void {
    this.feedRows = feedFrame(0).rows;
    this.buyFeed = buyRows(0);
    this.visibleCandles = 0;
    this.poolLocked = false;
    this.shownPoolSol = feedFrame(0).totalSol;
    this.shownBoughtSol = buyFrame(0, this.candles.length).boughtSol;
    this.lastTickAt = 0;
    // A price series for the whole scene: half an hour of running, nobody watches longer.
    this.resetPriceSeries();
    this.priceWroteAt = -1e9;
    this.cdr.markForCheck();
  }

  /** The scene without motion: the same thing, in its final state. */
  private renderStatic(): void {
    const frame = feedFrame(COMMIT_EVERY_MS * 12);
    this.poolId = frame.poolId;
    this.feedRows = frame.rows;
    this.buyFeed = buyRows(0);
    this.visibleCandles = this.candles.length;
    this.cdr.markForCheck();
    queueMicrotask(() => {
      this.write(this.poolTotalRef, frame.totalSol.toFixed(1));
      this.write(this.poolClockRef, clockText(frame.secondsLeft));
      this.setWidth(this.poolFillRef, (frame.totalSol / 111) * 100);
      this.drawFinishedPrice();
      this.write(this.boughtValueRef, String(BUY_TARGET_SOL));
      this.setWidth(this.boughtBarRef, 100);
      this.payoutBars?.forEach((bar, index) => this.setWidth(bar, this.payouts[index].share));
      this.payoutTokens?.forEach((node, index) => this.write(node, this.formatTokens(this.payouts[index].tokens)));
    });
  }

  // 1. The commit feed: the pool fills, the timer runs, then the pool locks
  //    and the next one opens — the circle closes without a jerk.
  private renderFeed(elapsed: number, deltaMs: number): void {
    const frame = feedFrame(elapsed);
    this.shownPoolSol = this.approach(this.shownPoolSol, frame.totalSol, deltaMs);
    this.write(this.poolTotalRef, this.shownPoolSol.toFixed(1));
    this.write(this.poolClockRef, frame.locked ? 'closed' : clockText(frame.secondsLeft));
    this.setWidth(this.poolFillRef, (this.shownPoolSol / 111) * 100);

    const rowsChanged = frame.rows.length !== this.feedRows.length
      || frame.rows.some((row, index) => row !== this.feedRows[index]);
    if (rowsChanged || frame.poolId !== this.poolId || frame.locked !== this.poolLocked) {
      this.zone.run(() => {
        this.feedRows = frame.rows;
        this.poolId = frame.poolId;
        this.poolLocked = frame.locked;
        this.cdr.markForCheck();
      });
    }
  }

  // 2. Price: the line is drawn left to right and rises in the frame, and once
  //    it hits the right edge it travels left, like a live chart.
  private renderPrice(elapsed: number, deltaMs: number): void {
    const line = this.priceLineRef?.nativeElement;
    if (!line || this.priceValues.length === 0) {
      return;
    }
    const head = Math.min(this.priceValues.length - 2, priceHead(elapsed));

    // The scale is computed over the whole frame rather than the drawn part.
    // While the line is being drawn the target does not change, which is why the
    // price is visibly rising inside the frame. After that the target travels
    // with the window and the scale catches up with a lag, as on an exchange.
    const axis = priceAxis(priceScaleWindow(this.priceValues, head));
    // It widens fast and narrows lazily. Room for a sharp jolt is needed at
    // once, or the line lies along the frame edge and the growth turns into a
    // shelf. And narrowing slowly is what makes the rise visible: the frame
    // moves after the price with a delay, as on an exchange.
    this.priceMin = this.approach(this.priceMin, axis.min, deltaMs, axis.min < this.priceMin ? 260 : 1100);
    this.priceMax = this.approach(this.priceMax, axis.max, deltaMs, axis.max > this.priceMax ? 260 : 1100);

    // We leave the right edge to the "now" point: otherwise the dot is half cut
    // off by the chart frame.
    const { width, height } = this.priceBox;
    const frame = priceFrame(this.priceValues, head, this.priceMin, this.priceMax, width - PRICE_DOT_ROOM, height);
    line.setAttribute('d', frame.line);
    this.priceAreaRef?.nativeElement.setAttribute('d', frame.area);

    const dot = this.priceDotRef?.nativeElement;
    if (dot) {
      dot.setAttribute('cx', frame.dotX.toFixed(2));
      dot.setAttribute('cy', frame.dotY.toFixed(2));
    }
    // We update the number a few times a second rather than every frame. At
    // sixty frames the last digit turns into a flicker that hurts to look at,
    // and the quote gets no more accurate for it.
    if (elapsed - this.priceWroteAt >= PRICE_TEXT_EVERY_MS) {
      this.priceWroteAt = elapsed;
      this.write(this.priceValueRef, this.priceText(priceAt(this.priceValues, head)));
    }
  }

  /** A price series for the whole scene: half an hour of running, nobody watches longer. */
  private resetPriceSeries(): void {
    if (this.priceValues.length === 0) {
      this.priceValues = priceSeries(20260918, 2000);
    }
    const axis = priceAxis(priceScaleWindow(this.priceValues, priceHead(0)));
    this.priceMin = axis.min;
    this.priceMax = axis.max;
  }

  /** A nominal coin price: the series starts at one and we show dollars. */
  private priceText(value: number): string {
    return `$${(PRICE_BASE_USD * value).toFixed(7)}`;
  }

  /** The price in its finished form: the frame is full and the dot is at the right edge. */
  private drawFinishedPrice(): void {
    this.resetPriceSeries();
    this.priceWroteAt = -1e9;
    this.renderPrice(PRICE_TICK_MS * (PRICE_POINTS - 1), 6000);
  }

  /**
   * The feed row height goes into the `--row-h` variable.
   *
   * The styles hold the list to exactly three visible rows by it and unroll a
   * new row from zero. It cannot be computed in CSS: the row is set in em,
   * changes with the card's scale and depends on the font.
   *
   * Measuring once is not enough: before its own font loads the row is shorter,
   * and the list would then not line up with the rows. So we measure when the
   * scene appears, after the fonts are ready, and when the section resizes.
   */
  private watchRowHeight(): void {
    this.feedLists = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('[data-how-feed]'));
    if (this.feedLists.length === 0) {
      return;
    }
    this.measureRows();
    document.fonts?.ready.then(() => this.measureRows()).catch(() => undefined);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    // We watch the whole section: the rows in the feed change constantly and
    // the card's scale depends on the window size. Scaling by the timeline does
    // not count — it is a transform and does not affect layout.
    this.rowResize = new ResizeObserver(() => this.measureRows());
    this.rowResize.observe(this.host.nativeElement);
  }

  private measureRows(): void {
    for (const list of this.feedLists) {
      // We skip the first row: at that moment it may be unrolling.
      // We take the tallest of the rest — on a narrow screen a row wraps.
      const rows = Array.from(list.children).slice(1) as HTMLElement[];
      // A fractional height rather than offsetHeight: that one rounds to a
      // pixel, and over three rows a couple of pixels accumulate — the list
      // stops lining up with the rows.
      const height = rows.reduce((tallest, row) => Math.max(tallest, row.getBoundingClientRect().height), 0);
      // We measure the step rather than compute it: the gap between rows is set
      // in em, and the em of a row and of the list differ, so the list height
      // would drift away from the rows.
      const step = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : height;
      const roundedHeight = Math.round(height * 100) / 100;
      const roundedStep = Math.round(step * 100) / 100;
      if (roundedHeight < 8 || roundedStep < 8) {
        continue;
      }
      if (list.style.getPropertyValue('--row-h') !== `${roundedHeight}px`) {
        list.style.setProperty('--row-h', `${roundedHeight}px`);
      }
      if (list.style.getPropertyValue('--row-step') !== `${roundedStep}px`) {
        list.style.setProperty('--row-step', `${roundedStep}px`);
      }
    }
  }

  /** We measure the chart frame in pixels and set the viewBox to match. */
  private watchPriceBox(): void {
    const svg = this.priceSvgRef?.nativeElement;
    if (!svg || typeof ResizeObserver === 'undefined') {
      return;
    }
    const apply = () => {
      // clientWidth specifically, not getBoundingClientRect: the card is scaled
      // by the story timeline, and the rect would return the size with that
      // scale applied. The viewBox has to match the layout, or the "now" dot
      // becomes an oval.
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (width < 8 || height < 8 || (width === this.priceBox.width && height === this.priceBox.height)) {
        return;
      }
      this.priceBox = { width, height };
      svg.setAttribute('viewBox', `0 0 ${this.priceBox.width} ${this.priceBox.height}`);
      if (!this.frameId) {
        // The scene is not running: we redraw for the new frame, otherwise the
        // line would stay built for the old width.
        this.drawFinishedPrice();
      }
    };
    apply();
    this.priceResize = new ResizeObserver(apply);
    this.priceResize.observe(svg);
  }

  // 4. The hour of buying: candles accumulate and the bought counter grows.
  private renderBuys(elapsed: number, deltaMs: number): void {
    const frame = buyFrame(elapsed, this.candles.length);
    this.shownBoughtSol = this.approach(this.shownBoughtSol, frame.boughtSol, deltaMs);
    this.write(this.boughtValueRef, this.shownBoughtSol.toFixed(1));
    this.setWidth(this.boughtBarRef, (this.shownBoughtSol / BUY_TARGET_SOL) * 100);

    const rows = buyRows(elapsed);
    const rowsChanged = rows.some((row, index) => row !== this.buyFeed[index]);
    if (frame.candles !== this.visibleCandles || rowsChanged) {
      this.zone.run(() => {
        this.visibleCandles = frame.candles;
        this.buyFeed = rows;
        this.cdr.markForCheck();
      });
    }
  }

  // 5. Delivery: the bars grow to their share and the token counters catch up.
  private renderPayouts(elapsed: number): void {
    const frame = payoutFrame(elapsed, this.payouts.length);
    if (elapsed > payoutDurationMs(this.payouts.length)) {
      // Delivery is a one-off event: it plays out and freezes until the next arrival.
      this.stop();
    }
    this.payoutBars?.forEach((bar, index) => {
      this.setWidth(bar, this.payouts[index].share * frame.fill[index]);
      bar.nativeElement.parentElement?.classList.toggle('is-sent', frame.sent[index]);
    });
    this.payoutTokens?.forEach((node, index) => {
      this.write(node, this.formatTokens(this.payouts[index].tokens * frame.fill[index]));
    });
  }

  private write(ref: ElementRef<HTMLElement> | undefined, text: string): void {
    const node = ref?.nativeElement;
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  }

  private setWidth(ref: ElementRef<HTMLElement> | undefined, percent: number): void {
    const node = ref?.nativeElement;
    if (node) {
      node.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(2)}%`;
    }
  }
}
