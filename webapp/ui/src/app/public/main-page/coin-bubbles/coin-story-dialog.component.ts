import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Inject, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { RouterLink } from '@angular/router';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';

import { formatSol } from '../../../pool/pool-state';
import { AnalyticsService } from '../../../shared/analytics/analytics.service';
import { BackedCoin } from './backed-coins.service';
import { boughtText, CoinStory, formatTinyPrice, storyMarks, updatedText, windowText } from './coin-story';
import { CoinStoryService } from './coin-story.service';

/**
 * How often, and how long apart, the window asks again while the chart is not
 * there yet: the server fetches a coin that just came in within a minute or
 * so (once a minute, within GeckoTerminal's ten calls).
 */
const WAIT_TRIES = 4;
const WAIT_RETRY_MS = 20_000;

export interface CoinStoryDialogData {
  coin: BackedCoin;
}

/**
 * A coin's stay in pumpling, opened from its bubble on the main page.
 *
 * Asked for on 2026-10-16: pressing a bubble opens the coin's chart from when
 * it came into a pool to when the pool had bought it, with its ticker, picture,
 * mint and when it took part; for a coin in several pools, the one where the
 * most SOL stood behind it. The candles are GeckoTerminal's, in SOL, and the
 * pool's own buys are arrows under the candles they fell in, so what the pool
 * did to the price is there to see. Before 2026-10-16 the bubble opened the
 * coin's trading page at once; that is the window's first button now.
 *
 * The chart library (TradingView Lightweight Charts) is loaded when the first
 * window opens, not with the page. Its own attribution logo stays on, as its
 * licence asks; GeckoTerminal's is the line under the chart.
 */
@Component({
  selector: 'app-coin-story-dialog',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './coin-story-dialog.component.html',
  styleUrls: ['./coin-story-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CoinStoryDialogComponent implements OnInit, OnDestroy {
  readonly coin: BackedCoin;
  story: CoinStory | null = null;
  state: 'loading' | 'ready' | 'failed' = 'loading';
  copied = false;
  pictureFailed = false;
  /** Tries left to ask again by itself while the chart is on its way. */
  waitTriesLeft = WAIT_TRIES;

  @ViewChild('chart') private chartRef?: ElementRef<HTMLElement>;
  private chart: IChartApi | null = null;
  private destroyed = false;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  static open(dialog: MatDialog, data: CoinStoryDialogData): MatDialogRef<CoinStoryDialogComponent> {
    const phone = window.matchMedia('(max-width: 599px)').matches;
    return dialog.open(CoinStoryDialogComponent, {
      data,
      // The same transparent Material surface and bottom sheet as the commit dialog (styles.scss).
      panelClass: ['auth-dialog-panel', phone ? 'auth-dialog-panel--sheet' : 'auth-dialog-panel--center'],
      backdropClass: 'auth-dialog-backdrop',
      width: phone ? '100vw' : 'min(720px, calc(100vw - 32px))',
      maxWidth: '100vw',
      position: phone ? { bottom: '0' } : { top: 'max(24px, 7vh)' },
      autoFocus: 'dialog',
      restoreFocus: true,
      ariaLabelledBy: 'coin-story-title'
    });
  }

  constructor(
    @Inject(MAT_DIALOG_DATA) data: CoinStoryDialogData,
    private readonly ref: MatDialogRef<CoinStoryDialogComponent>,
    private readonly stories: CoinStoryService,
    private readonly analytics: AnalyticsService,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone
  ) {
    this.coin = data.coin;
  }

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.chart?.remove();
    this.chart = null;
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
    }
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
    }
  }

  close(): void {
    this.ref.close();
  }

  async retry(): Promise<void> {
    this.state = 'loading';
    this.cdr.markForCheck();
    await this.load();
  }

  async copyMint(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.coin.mint);
    } catch {
      return;
    }
    this.copied = true;
    this.cdr.markForCheck();
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
    }
    this.copiedTimer = setTimeout(() => {
      this.copied = false;
      this.cdr.markForCheck();
    }, 1600);
  }

  traded(): void {
    this.analytics.event('coin_story_trade_click', { venue: this.coin.venue });
  }

  get symbol(): string {
    return this.story?.symbol ?? this.coin.symbol;
  }

  get initials(): string {
    return this.symbol.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase() || '?';
  }

  get picture(): string | null {
    return this.pictureFailed ? null : (this.story?.logoUrl ?? this.coin.logoUrl);
  }

  get shortMint(): string {
    return `${this.coin.mint.slice(0, 6)}…${this.coin.mint.slice(-6)}`;
  }

  get when(): string {
    const story = this.story;
    if (!story) {
      return '';
    }
    // The pool's last buy of it, or its close when it bought none: a finished
    // pool with no buys read "Oct 2 → Oct 18" on the stand, two weeks for two hours.
    return windowText(story.enteredAtMs, story.leftAtMs ?? Date.now(), !story.finished);
  }

  /** Which marks the chart carries: the key under it names only those (it named buys on a coin with none). */
  get marked(): { buy: boolean; in: boolean } {
    const marks = this.story ? storyMarks(this.story) : [];
    return { buy: marks.some((mark) => mark.kind === 'buy'), in: marks.some((mark) => mark.kind === 'in') };
  }

  /** ", updated 3 min ago" under a chart that is still being refreshed; nothing under a final one. */
  get updated(): string {
    const story = this.story;
    return story && !story.chartFinal && story.chartUpdatedAtMs ? `, ${updatedText(story.chartUpdatedAtMs, Date.now())}` : '';
  }

  get bought(): string {
    return this.story ? boughtText(this.story, formatSol) : '';
  }

  get committed(): string {
    return formatSol(this.story?.committedSol ?? 0);
  }

  /** What the chart shows, for a screen reader: the canvas says nothing itself. */
  get chartLabel(): string {
    const story = this.story;
    if (!story || story.candles.length === 0) {
      return '';
    }
    const first = story.candles[0];
    const last = story.candles[story.candles.length - 1];
    return `Price of $${story.symbol} in SOL over its stay, from ${formatTinyPrice(first.c)} to ${formatTinyPrice(last.c)}, `
      + `with ${story.buys.length} ${story.buys.length === 1 ? 'buy' : 'buys'} by the pool marked.`;
  }

  private async load(): Promise<void> {
    try {
      this.story = await this.stories.load(this.coin.mint);
      this.state = 'ready';
    } catch {
      this.state = 'failed';
    }
    if (this.destroyed) {
      return;
    }
    this.cdr.detectChanges();
    if (this.state === 'ready' && this.story && this.story.candles.length > 0) {
      await this.draw(this.story);
    }
    // A chart on its way (or busy) is usually there within a minute, so the
    // window asks again itself rather than leave it to the visitor.
    const waiting = this.story?.chartState === 'pending' || this.story?.chartState === 'busy';
    if (this.state === 'ready' && waiting && this.waitTriesLeft > 0) {
      this.waitTriesLeft -= 1;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        void this.load();
      }, WAIT_RETRY_MS);
    }
  }

  private async draw(story: CoinStory): Promise<void> {
    const host = this.chartRef?.nativeElement;
    if (!host) {
      return;
    }
    const lw = await import('lightweight-charts');
    if (this.destroyed) {
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.chart?.remove();
      const chart = lw.createChart(host, {
        autoSize: true,
        layout: {
          background: { type: lw.ColorType.Solid, color: '#FCFCFC' },
          textColor: '#020202',
          fontFamily: getComputedStyle(host).fontFamily,
          fontSize: 11
        },
        grid: { vertLines: { color: 'rgba(2, 2, 2, 0.06)' }, horzLines: { color: 'rgba(2, 2, 2, 0.06)' } },
        // Room under the candles for the buy arrows, kept by the scale itself:
        // left to fit the markers (their `autoScale`), it ran down to nearly
        // zero and a quarter of the chart stood empty.
        // Above the candles, room for the dot the coin came in on: at 0.1 it
        // sat on the edge and its "In" was cut off (the key under the chart
        // names the dot now, so it carries no text).
        rightPriceScale: { borderColor: '#020202', scaleMargins: { top: 0.16, bottom: 0.15 } },
        timeScale: { borderColor: '#020202', timeVisible: true, secondsVisible: false },
        localization: { priceFormatter: formatTinyPrice },
        crosshair: { mode: lw.CrosshairMode.Magnet },
        // The window scrolls, on a phone it is a sheet, and by default the
        // chart keeps a vertical swipe and the wheel for itself: a swipe begun
        // on it (300px of a 568px phone) did not move the sheet. Those go to
        // the window; a sideways drag still moves through time, two fingers
        // and the axes still zoom.
        handleScroll: { mouseWheel: false, vertTouchDrag: false, horzTouchDrag: true, pressedMouseMove: true },
        handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true }
      });
      // Brand colours: green up, purple down, black outlines as on the site's coins.
      const series = chart.addSeries(lw.CandlestickSeries, {
        upColor: '#8FFFAF',
        downColor: '#AF8FFF',
        borderUpColor: '#020202',
        borderDownColor: '#020202',
        wickUpColor: '#020202',
        wickDownColor: '#020202',
        priceFormat: { type: 'custom', formatter: formatTinyPrice, minMove: 1e-12 }
      });
      series.setData(story.candles.map((candle) => ({
        time: candle.t as UTCTimestamp,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c
      })));
      lw.createSeriesMarkers(series, storyMarks(story).map((mark) => mark.kind === 'in'
        ? { time: mark.t as UTCTimestamp, position: 'aboveBar' as const, shape: 'circle' as const, color: '#020202' }
        : { time: mark.t as UTCTimestamp, position: 'belowBar' as const, shape: 'arrowUp' as const, color: '#020202', text: mark.count > 1 ? String(mark.count) : '' }),
        { autoScale: false });
      chart.timeScale().fitContent();
      this.chart = chart;
    });
  }
}
