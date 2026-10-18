import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';

import { formatSol } from '../../../pool/pool-state';
import { AnalyticsService } from '../../../shared/analytics/analytics.service';
import { BACKED_LATEST, BACKED_MIN_SOL, BackedCoin, BackedCoinsService } from './backed-coins.service';
import { layoutBubbles } from './bubble-layout';
import { CoinStoryDialogComponent } from './coin-story-dialog.component';

/** At most this many bubbles: the ten latest coins (the server sends no more). */
const MAX_BUBBLES = BACKED_LATEST;
/** The list is asked for again this often while the page is in front. */
const REFRESH_MS = 5 * 60_000;
/** After a failed ask, the next one. */
const RETRY_MS = 30_000;
/** The SOL badge shows from this radius: below it the ticker alone fits. */
const SOL_FROM_R = 46;

interface DrawnBubble {
  coin: BackedCoin;
  rank: number;
  x: number;
  y: number;
  r: number;
  /** The gentle float: each bubble its own way and pace, so they do not move as one. */
  floatX: number;
  floatY: number;
  floatSeconds: number;
  floatDelay: number;
  initials: string;
  /** The labels' size: they sit inside the bubble, so they grow with it. */
  labelPx: number;
  tint: string;
  showSol: boolean;
  label: string;
}

const TINTS = ['var(--qres-purple)', 'var(--qres-green)', 'var(--qres-cyan)', '#FFD86B'];

/**
 * The ten coins committed to most lately with at least 1 SOL behind each, as
 * bubbles: the bigger the bubble, the more SOL behind the coin, the biggest
 * twice the smallest across at most. Each one opens the coin's window: its
 * chart over its stay in pumpling and the way to trade it.
 *
 * Asked for on 2026-10-16, in place of the chat on the first screen, after
 * massive.gg's bubbles: a visitor who has never heard of us sees real coins
 * that have been through the pools, and can open any of them. The chat moved to
 * the header (`ChatLauncherComponent`).
 *
 * Positions are `bubble-layout.ts`, recomputed whenever the card changes size.
 * A bubble is a plain link in a list, biggest first, so the keyboard and a
 * screen reader get the same order the eye does; hovering or focusing one says
 * what it is underneath, where a tooltip could only fall off the card.
 */
@Component({
  selector: 'app-coin-bubbles',
  standalone: true,
  templateUrl: './coin-bubbles.component.html',
  styleUrls: ['./coin-bubbles.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CoinBubblesComponent implements OnInit, OnDestroy {
  readonly minSol = BACKED_MIN_SOL;
  state: 'loading' | 'ready' | 'failed' = 'loading';
  bubbles: DrawnBubble[] = [];
  /** Coins that did not fit the card at a readable size. */
  hidden = 0;
  active: DrawnBubble | null = null;
  /** Whether the device has a mouse: "click" or "tap" in the hint. */
  readonly pointer = typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches ? 'Click' : 'Tap';

  @ViewChild('field', { static: true }) private field!: ElementRef<HTMLElement>;
  private coins: BackedCoin[] = [];
  private failedImages = new Set<string>();
  private sizes: ResizeObserver | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private size = { width: 0, height: 0 };
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && this.timer === null) {
      void this.fetch();
    }
  };

  constructor(
    private readonly backed: BackedCoinsService,
    private readonly analytics: AnalyticsService,
    private readonly dialog: MatDialog,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone
  ) {}

  ngOnInit(): void {
    if (typeof ResizeObserver === 'function') {
      this.zone.runOutsideAngular(() => {
        this.sizes = new ResizeObserver(() => this.schedule());
        this.sizes.observe(this.field.nativeElement);
      });
    }
    document.addEventListener('visibilitychange', this.onVisible);
    void this.fetch();
  }

  ngOnDestroy(): void {
    this.sizes?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
  }

  show(bubble: DrawnBubble | null): void {
    if (this.active !== bubble) {
      this.active = bubble;
      this.cdr.markForCheck();
    }
  }

  /** The coin's window: its chart over its stay in pumpling, and the way to trade it. */
  openStory(bubble: DrawnBubble): void {
    this.analytics.event('home_bubble_click', { venue: bubble.coin.venue, rank: bubble.rank });
    CoinStoryDialogComponent.open(this.dialog, { coin: bubble.coin });
  }

  imageFailed(bubble: DrawnBubble): void {
    this.failedImages.add(bubble.coin.mint);
    this.cdr.markForCheck();
  }

  hasImage(bubble: DrawnBubble): boolean {
    return !!bubble.coin.logoUrl && !this.failedImages.has(bubble.coin.mint);
  }

  sol(value: number): string {
    return formatSol(value);
  }

  pools(count: number): string {
    return `${count} ${count === 1 ? 'pool' : 'pools'}`;
  }

  trackBubble(_index: number, bubble: DrawnBubble): string {
    return bubble.coin.mint;
  }

  private async fetch(): Promise<void> {
    this.timer = null;
    try {
      this.coins = await this.backed.load();
      this.state = 'ready';
      this.later(REFRESH_MS);
    } catch {
      // Coins drawn before stay drawn; an empty card says so plainly.
      this.state = this.coins.length > 0 ? 'ready' : 'failed';
      this.later(RETRY_MS);
    }
    this.layout();
  }

  /** The next ask, only while the page is in front: a tab in the background asks again when it comes back. */
  private later(ms: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (document.visibilityState === 'visible') {
        void this.fetch();
      }
    }, ms);
  }

  private schedule(): void {
    if (this.frame) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const { clientWidth: width, clientHeight: height } = this.field.nativeElement;
      if (width !== this.size.width || height !== this.size.height) {
        this.size = { width, height };
        this.zone.run(() => this.layout());
      }
    });
  }

  private layout(): void {
    const { clientWidth: width, clientHeight: height } = this.field.nativeElement;
    this.size = { width, height };
    const coins = this.coins.slice(0, MAX_BUBBLES);
    const placed = layoutBubbles(coins.map((coin) => ({ key: coin.mint, value: coin.sol })), { width, height });
    const byMint = new Map(coins.map((coin, index) => [coin.mint, { coin, rank: index + 1 }]));
    this.bubbles = placed.map((spot, index) => {
      const { coin, rank } = byMint.get(spot.key)!;
      const seed = hash(coin.mint);
      return {
        coin,
        rank,
        x: spot.x,
        y: spot.y,
        r: spot.r,
        floatX: ((seed % 7) - 3) * 0.6,
        floatY: (((seed >> 3) % 7) - 3) * 0.6,
        floatSeconds: 5 + (seed % 4),
        floatDelay: -((seed >> 5) % 6),
        initials: coin.symbol.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase() || '?',
        labelPx: labelSize(spot.r, coin.symbol.length + 1),
        tint: TINTS[seed % TINTS.length],
        showSol: spot.r >= SOL_FROM_R,
        label: `$${coin.symbol}, ${coin.name}: ${formatSol(coin.sol)} SOL from ${this.pools(coin.pools)}. Opens its chart in pumpling.`
      };
    });
    this.hidden = this.coins.length - this.bubbles.length;
    // The bubble under the pointer is a new object after a new layout: keep it by coin.
    const activeMint = this.active?.coin.mint;
    this.active = activeMint ? this.bubbles.find((bubble) => bubble.coin.mint === activeMint) ?? null : null;
    this.cdr.markForCheck();
  }
}

/**
 * The ticker's size inside a bubble: it grows with the bubble up to 12px, and a
 * long ticker gets smaller until it fits whole (86% of the bubble, less the
 * label's padding and border; bold capitals run about 0.7em each). Under 8px
 * it stops shrinking and ends in an ellipsis: at 1024x600 "$PUMPLING" was cut
 * in the biggest bubble while a smaller font held it whole.
 */
function labelSize(r: number, characters: number): number {
  const bySize = Math.min(12, r * 0.26);
  const toFit = (2 * r * 0.86 - 11) / (characters * 0.7);
  return Math.round(Math.max(8, Math.min(bySize, toFit)) * 10) / 10;
}

/** A small stable number from a mint, for the float and the tint. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
