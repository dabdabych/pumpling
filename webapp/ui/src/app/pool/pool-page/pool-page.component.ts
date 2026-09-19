import { animate, group, query, sequence, stagger, style, transition, trigger } from '@angular/animations';
import { AsyncPipe, DecimalPipe, PercentPipe } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostBinding, NgZone, OnDestroy, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { combineLatest, Observable, of, switchMap, timer } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import { LegalDialogComponent } from '../../shared/legal/legal-dialog.component';
import { SiteHeaderComponent } from '../../shared/site-header/site-header.component';
import { CommitDialogComponent, CommitDialogData } from '../commit-dialog/commit-dialog.component';
import { CommitOutcome, CommitService, SentCommit } from '../commit.service';
import { lamportsToSol } from '../lamports';
import { formatSol, PoolCoin, PoolSnapshot } from '../pool-state';
import { EMPTY_FEED, PurchaseCoin, PurchaseFeed, PurchaseItem, PurchasesService } from '../purchases.service';
import { chartChangePct, chartPath, CoinChart, CoinChartService } from '../coin-chart.service';
import { ShareKind, shareCardData } from '../share/share-card';
import { ShareDialogComponent } from '../share/share-dialog.component';
import { VerifyRoundDialogComponent } from '../../shared/verify-round/verify-round-dialog.component';
import { buildPoolView, PoolView } from '../pool-view';
import { PoolService } from '../pool.service';
import { MyCommitsService, MyRound } from '../../me/my-commits.service';
import { environment } from '../../../environments/environment';
import idl from '../../idl/lottery_v_1_0.json';

interface PageModel {
  snapshot: PoolSnapshot;
  view: PoolView;
  feed: PurchaseFeed;
  /** Coins whose total has just grown: the row is highlighted. */
  fresh: ReadonlySet<string>;
  /** How much has been bought of each coin during the buying. */
  boughtByMint: ReadonlyMap<string, PurchaseCoin>;
  /** My commits in this pool: the rows are highlighted by them. */
  mine: MyRound | null;
}

type ToastState = 'sending' | CommitOutcome;

interface Toast {
  state: ToastState;
  title: string;
  message: string;
  signature: string;
  /** What to suggest in a post: the coin and how much the person put in. */
  share?: { mint: string; sol: number };
}

/** The program address from the IDL: the same one used for a commit. */
const POOL_PROGRAM_ID = (idl as { address: string }).address;

/** The height of the chart tooltip: we decide by it whether to put it above or below the row. */
const HOVER_CARD_HEIGHT = 150;

/** How long to hold a new row's highlight, ms. */
const FRESH_MS = 2600;

/** The length of the buying window from the snapshot: the feed poll rate is computed from it. */
function buyWindowMs(snapshot: PoolSnapshot): number {
  if (snapshot.buysStartedAtMs !== null && snapshot.buysEndAtMs !== null) {
    return Math.max(60_000, snapshot.buysEndAtMs - snapshot.buysStartedAtMs);
  }
  return 65 * 60_000;
}

const TRACK = [
  { label: 'Open', note: '2 hours' },
  { label: 'Locked', note: 'draw' },
  { label: 'Buying', note: '1 hour' },
  { label: 'Done', note: 'next pool' }
];

/**
 * The pool page: the phase, the timer, how much SOL is behind which coins, and
 * after the draw how much goes into buying each one. Everything comes from
 * `/lottery/current` through PoolService; there is not one invented number on
 * the page. How much SOL has already been spent on purchases is not known to
 * the backend, and the page does not show it.
 */
@Component({
  selector: 'app-pool-page',
  standalone: true,
  imports: [AsyncPipe, DecimalPipe, PercentPipe, RouterLink, SiteHeaderComponent],
  templateUrl: './pool-page.component.html',
  styleUrls: ['./pool-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The phase changes with nobody touching it: the pool closed, the draw ran,
  // the buying started. Swapping the text and the timer instantly reads as a
  // page glitch, so a phase change comes through as a short transition. The
  // first render is not animated: the page has only just appeared as it is.
  animations: [
    // The title and the caption arrive one after the other rather than at once:
    // a phase changes in one movement from top to bottom. The delay comes in as
    // a parameter, so the order is set in the template next to the lines themselves.
    trigger('phaseSwap', [
      transition('void => *', []),
      transition('* => *', [
        style({ opacity: 0, transform: 'translateY(6px)' }),
        animate('300ms {{ delay }} cubic-bezier(0.2, 0.7, 0.3, 1)', style({ opacity: 1, transform: 'none' }))
      ], { params: { delay: '0ms' } })
    ]),
    // The state card: it comes through as a whole while the inner rows (the
    // clock, the caption, the bar) arrive in a cascade. Everything used to be
    // swapped in one frame, and the draw → buying transition read as a page glitch.
    trigger('cardSwap', [
      transition('void => *', []),
      transition('* => *', [
        group([
          sequence([
            style({ opacity: 0.4 }),
            animate('260ms cubic-bezier(0.2, 0.7, 0.3, 1)', style({ opacity: 1 }))
          ]),
          // Rows on their way out are removed at once. Otherwise they stay in
          // the flow while the transition plays, the card becomes twice as tall
          // for those fractions of a second and the page jerks — exactly what we
          // are avoiding.
          query(':leave', [style({ display: 'none' })], { optional: true }),
          query(':enter', [
            style({ opacity: 0, transform: 'translateY(10px)' }),
            stagger(55, animate('320ms 60ms cubic-bezier(0.2, 0.7, 0.3, 1)', style({ opacity: 1, transform: 'none' })))
          ], { optional: true })
        ])
      ])
    ]),
    // The purchase feed appears from below when the buying starts.
    trigger('sectionEnter', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(14px)' }),
        animate('380ms 120ms cubic-bezier(0.2, 0.7, 0.3, 1)', style({ opacity: 1, transform: 'none' }))
      ])
    ]),
    trigger('drawReveal', [
      transition('void => *', []),
      transition('* => *', [
        query('.coin-row__drawn', [
          style({ opacity: 0, transform: 'translateX(8px)' }),
          animate('320ms 80ms cubic-bezier(0.2, 0.7, 0.3, 1)', style({ opacity: 1, transform: 'none' }))
        ], { optional: true })
      ])
    ])
  ]
})
export class PoolPageComponent implements OnInit, OnDestroy {
  readonly track = TRACK;
  readonly model$: Observable<PageModel>;

  /** Animations are off wherever somebody asked for less motion. */
  @HostBinding('@.disabled') readonly animationsDisabled = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  toast: Toast | null = null;
  copiedMint: string | null = null;
  /** The coin from a `?coin=` link: we highlight its row when somebody arrives from a post. */
  highlightMint: string | null = null;
  /** The coin under the cursor and its chart: the tooltip only lives under a mouse. */
  hoveredMint: string | null = null;
  /** The tooltip had to go above the row: there was no space below. */
  hoveredAbove = false;
  hoveredChart: CoinChart | null = null;
  hoveredLoading = false;

  /** The program address: one for every pool, checkable in an explorer. */
  readonly programId = POOL_PROGRAM_ID;
  readonly explorerQuery = environment.solanaExplorerQuery;
  readonly brokenLogos = new Set<string>();

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private latest: PoolSnapshot | null = null;
  private destroyed = false;
  /** How much SOL stood behind a coin in the previous server answer. */
  private readonly lastSolByMint = new Map<string, number>();
  /** Until when to highlight a coin's row after a new commit. */
  private readonly freshUntil = new Map<string, number>();

  constructor(
    private readonly pool: PoolService,
    private readonly commits: CommitService,
    private readonly dialog: MatDialog,
    private readonly title: Title,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    private readonly route: ActivatedRoute,
    private readonly purchases: PurchasesService,
    private readonly charts: CoinChartService,
    private readonly myCommits: MyCommitsService
  ) {
    // The purchase feed is only needed where it exists: during the buying and
    // right after it. In the other phases the server is not asked about it at all.
    const feed$ = this.pool.snapshot$('dex').pipe(
      map((snapshot) => (
        snapshot.poolId !== null && (snapshot.phase === 'buying' || snapshot.phase === 'done')
          ? { poolId: snapshot.poolId, windowMs: buyWindowMs(snapshot) }
          : null
      )),
      distinctUntilChanged((a, b) => a?.poolId === b?.poolId && a?.windowMs === b?.windowMs),
      switchMap((request) => request ? this.purchases.feed$(request) : of(EMPTY_FEED))
    );

    this.model$ = combineLatest([
      this.pool.snapshot$('dex'),
      feed$,
      timer(0, 1000),
      this.myCommits.commits$()
    ]).pipe(
      map(([snapshot, feed]) => {
        this.trackFreshCoins(snapshot);
        this.latest = snapshot;
        const now = Date.now();
        const fresh = new Set(
          [...this.freshUntil.entries()].filter(([, until]) => until > now).map(([mint]) => mint)
        );
        return {
          snapshot,
          view: buildPoolView(snapshot, now, feed),
          feed,
          fresh,
          boughtByMint: new Map(feed.coins.map((coin) => [coin.mint, coin])),
          mine: this.myCommits.roundFor(snapshot.poolId)
        };
      })
    );
  }

  ngOnInit(): void {
    this.title.setTitle('Pool · pumpling');
    // My own commits: without them a person looks at a shared pool and does not
    // see themselves in it. We swallow the error silently — the pool page is not
    // about personal history.
    void this.myCommits.load().catch(() => undefined);
    // A link from a post leads to a particular coin: we highlight its row.
    const mint = this.route.snapshot.queryParamMap.get('coin');
    if (mint) {
      this.highlightMint = mint;
      this.zone.runOutsideAngular(() => setTimeout(() => this.scrollToHighlight(), 700));
    }
  }

  private scrollToHighlight(): void {
    const row = document.querySelector<HTMLElement>('.coin-row--highlight');
    if (!row) {
      return;
    }
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearToastTimer();
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
    }
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
    }
  }

  /**
   * Marks the coins that have just gained SOL: the row blinks and you can see
   * the pool is alive. We compare with the previous server answer rather than
   * the previous frame — frames come every second, answers less often.
   */
  private trackFreshCoins(snapshot: PoolSnapshot): void {
    if (snapshot.phase === 'loading') {
      return;
    }
    const now = Date.now();
    const seen = new Set<string>();
    for (const coin of snapshot.coins) {
      seen.add(coin.mint);
      const previous = this.lastSolByMint.get(coin.mint);
      this.lastSolByMint.set(coin.mint, coin.sol);
      if (previous === undefined) {
        // The first render of the page must not blink the whole list at once.
        if (this.lastSolByMint.size > snapshot.coins.length) {
          this.freshUntil.set(coin.mint, now + FRESH_MS);
        }
        continue;
      }
      if (coin.sol > previous + 1e-9) {
        this.freshUntil.set(coin.mint, now + FRESH_MS);
      }
    }
    for (const mint of [...this.lastSolByMint.keys()]) {
      if (!seen.has(mint)) {
        this.lastSolByMint.delete(mint);
        this.freshUntil.delete(mint);
      }
    }
  }

  /**
   * Hovering a coin row: we show what its price has done in the last few minutes.
   *
   * Mouse only: a phone has no hover, and a tap on a row has to stay a tap. The
   * request goes out after a delay — if the cursor simply passed by, there is no
   * reason to bother the server.
   */
  onCoinHover(coin: PoolCoin, row?: EventTarget | null): void {
    if (!this.canHover()) {
      return;
    }
    // There may not be room below — then the tooltip goes above the row.
    const element = row instanceof HTMLElement ? row : null;
    const bottom = element?.getBoundingClientRect().bottom ?? 0;
    this.hoveredAbove = bottom + HOVER_CARD_HEIGHT > window.innerHeight;
    this.hoveredMint = coin.mint;
    const ready = this.charts.cached(coin.mint);
    this.hoveredChart = ready;
    this.hoveredLoading = !ready;
    this.cdr.markForCheck();
    if (ready) {
      return;
    }

    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
    }
    this.hoverTimer = setTimeout(async () => {
      const mint = coin.mint;
      const chart = await this.charts.load(mint);
      if (this.hoveredMint !== mint || this.destroyed) {
        return;
      }
      this.hoveredChart = chart;
      this.hoveredLoading = false;
      this.cdr.markForCheck();
    }, 220);
  }

  onCoinLeave(coin: PoolCoin): void {
    if (this.hoveredMint !== coin.mint) {
      return;
    }
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hoveredMint = null;
    this.hoveredChart = null;
    this.hoveredLoading = false;
    this.cdr.markForCheck();
  }

  /** The path of the mini chart for the tooltip. */
  chartPath(chart: CoinChart): string {
    return chartPath(chart.points, 176, 48);
  }

  /** How far the price moved over the stretch shown. */
  chartChange(chart: CoinChart): number | null {
    return chartChangePct(chart.points);
  }

  /** "over 12 minutes" — the caption under the chart, honest for a brand new coin. */
  chartWindowLabel(chart: CoinChart): string {
    if (chart.minutes <= 1) {
      return 'first minutes of trading';
    }
    if (chart.minutes < 60) {
      return `last ${chart.minutes} min`;
    }
    return `last ${Math.round(chart.minutes / 60)}h`;
  }

  private canHover(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
  }

  /** $412K, $0.00041 — memecoin prices live at both ends of the scale. */
  usd(value: number): string {
    if (!Number.isFinite(value)) {
      return '—';
    }
    if (value >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
      return `$${(value / 1_000).toFixed(1)}K`;
    }
    if (value >= 1) {
      return `$${value.toFixed(2)}`;
    }
    return `$${value.toPrecision(2)}`;
  }

  /** "2 min ago" — the purchase feed uses relative time: that is how the pace shows. */
  timeAgo(atMs: number, nowMs: number = Date.now()): string {
    const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
    if (seconds < 45) {
      return 'just now';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ago`;
  }

  trackPurchase(_: number, item: PurchaseItem): string {
    return item.signature;
  }

  /** How much of a coin has been bought, 0..1; no data means null and no bar. */
  boughtShare(coin: PurchaseCoin | undefined): number | null {
    if (!coin || coin.targetSol <= 0) {
      return null;
    }
    return Math.max(0, Math.min(1, coin.boughtSol / coin.targetSol));
  }

  formatSol(value: number): string {
    return formatSol(value);
  }

  shortMint(mint: string): string {
    return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
  }

  initials(coin: PoolCoin): string {
    return coin.ticker.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  }

  showLogo(coin: PoolCoin): boolean {
    return !!coin.logoUrl && !this.brokenLogos.has(coin.logoUrl);
  }

  onLogoError(coin: PoolCoin): void {
    if (coin.logoUrl) {
      this.brokenLogos.add(coin.logoUrl);
      this.cdr.markForCheck();
    }
  }

  trackCoin(_: number, coin: PoolCoin): string {
    return coin.mint;
  }

  async copyMint(mint: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(mint);
    } catch {
      return;
    }
    this.copiedMint = mint;
    this.cdr.markForCheck();
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
    }
    this.copiedTimer = setTimeout(() => {
      this.copiedMint = null;
      this.cdr.markForCheck();
    }, 1600);
  }

  /** A card for a post: about the coin, about your own commit, or about the whole pool. */
  /** Round verification: a dialog with the commitment, the randomness and the algorithm. */
  openVerify(lotteryId: number): void {
    VerifyRoundDialogComponent.open(this.dialog, lotteryId);
  }

  openShare(kind: ShareKind, mint?: string, commitSol?: number): void {
    if (!this.latest) {
      return;
    }
    ShareDialogComponent.open(this.dialog, shareCardData(this.latest, { kind, mint, commitSol }));
  }

  openTerms(): void {
    LegalDialogComponent.open(this.dialog, 'terms');
  }

  openCommit(mint?: string): void {
    if (this.latest?.phase !== 'open') {
      return;
    }
    const ref = CommitDialogComponent.open(this.dialog, { market: 'dex', mint } satisfies CommitDialogData);
    ref.afterClosed().subscribe((sent: SentCommit | undefined) => {
      if (sent) {
        void this.followCommit(sent);
      }
    });
  }

  /** How much I committed behind this coin in the current pool. */
  mySol(model: PageModel, mint: string): number {
    return model.mine?.coins.find((coin) => coin.mint === mint)?.mySol ?? 0;
  }

  dismissToast(): void {
    this.clearToastTimer();
    this.toast = null;
    this.cdr.markForCheck();
  }

  explorerUrl(signature: string): string {
    return this.commits.explorerUrl(signature);
  }

  private async followCommit(sent: SentCommit): Promise<void> {
    this.showToast({
      state: 'sending',
      title: 'Commit sent',
      message: 'Waiting for Solana to confirm it. This usually takes a few seconds.',
      signature: sent.signature
    }, null);
    void this.pool.refresh();

    const outcome = await sent.settled;
    if (this.destroyed || this.toast?.signature !== sent.signature) {
      return;
    }
    const share = { mint: sent.mint, sol: lamportsToSol(sent.lamports) };
    await this.pool.refresh();
    // The history went stale at this exact moment: the commit is recorded against the account.
    void this.myCommits.refresh().catch(() => undefined);
    switch (outcome) {
      case 'recorded':
        this.showToast({ state: outcome, title: 'Your SOL is in the pool', message: 'Solana confirmed it, and it now counts toward the coin you named.', signature: sent.signature, share }, 20_000);
        break;
      case 'confirmed':
        this.showToast({ state: outcome, title: 'Solana confirmed it', message: 'It will show in the list within a minute.', signature: sent.signature, share }, 20_000);
        break;
      case 'unconfirmed':
        this.showToast({ state: outcome, title: 'Not confirmed yet', message: 'The transaction may still go through. Check it on Solscan before sending another one.', signature: sent.signature }, null);
        break;
    }
  }

  private showToast(toast: Toast, autoHideMs: number | null): void {
    this.clearToastTimer();
    this.toast = toast;
    this.cdr.markForCheck();
    if (autoHideMs !== null) {
      this.zone.runOutsideAngular(() => {
        this.toastTimer = setTimeout(() => this.zone.run(() => this.dismissToast()), autoHideMs);
      });
    }
  }

  private clearToastTimer(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }
}
