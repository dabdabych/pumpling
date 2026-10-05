import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { environment } from '../../environments/environment';
import { SiteHeaderComponent } from '../shared/site-header/site-header.component';
import { ArchiveRound, ArchiveService } from './archive.service';
import { VerifyRoundDialogComponent } from '../shared/verify-round/verify-round-dialog.component';
import { MyCommitsService } from '../me/my-commits.service';
import { buildFeedRows, FeedRow } from '../pool/feed-rows';
import { PurchaseFeed, PurchasesService } from '../pool/purchases.service';
import { TxFeedComponent } from '../pool/tx-feed/tx-feed.component';

/** A round's transactions, as the archive holds them once asked for. */
interface TxPanel {
  state: 'loading' | 'ready' | 'failed';
  feed: PurchaseFeed | null;
}

/** What an open round's panel shows. */
export interface TxView {
  state: TxPanel['state'];
  rows: FeedRow[];
  /** "52 buys · 11 deliveries · 10 burns · 1 refund". */
  summary: string;
  /** Every transaction the round made; above `rows.length` when the feed is capped. */
  total: number;
}

/**
 * Past rounds.
 *
 * Why the page exists: it is the only proof that the machine works in practice
 * rather than in words. A person sees closed pools, how much SOL was in them,
 * which coins stood in them and how much went into buying each. It can all be
 * checked through a Solscan link, so every round carries its account address.
 *
 * Empty rounds never reach here: the server filters them out.
 *
 * Each round opens to its transactions, the same feed the pool page shows while
 * it buys: every purchase, delivery, burn and refund, each linking to its
 * transaction. They are asked for when a round is first opened, once: a
 * finished round's transactions do not change, and a month of rounds asked for
 * up front would be a request per round for rows nobody may look at.
 */
@Component({
  selector: 'app-archive-page',
  standalone: true,
  imports: [DecimalPipe, RouterLink, SiteHeaderComponent, TxFeedComponent],
  templateUrl: './archive-page.component.html',
  styleUrls: ['./archive-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ArchivePageComponent implements OnInit {
  readonly explorerQuery = environment.solanaExplorerQuery;

  rounds: ArchiveRound[] = [];
  loading = true;
  failed = false;

  /** The rounds whose transactions are open; any number at once. */
  private readonly open = new Set<number>();
  private readonly panels = new Map<number, TxPanel>();
  /** Built once per feed and set of my wallets, not on every change detection. */
  private readonly views = new Map<number, { feed: PurchaseFeed; wallets: readonly string[]; view: TxView }>();

  constructor(private readonly archive: ArchiveService, private readonly cdr: ChangeDetectorRef,
    private readonly dialog: MatDialog,
    private readonly purchases: PurchasesService,
    private readonly myCommits: MyCommitsService,
    destroyRef: DestroyRef
  ) {
    // My own commits mark the deliveries and refunds that reached me ("to you"),
    // as on the pool page. Signed out, there are none and nothing is marked.
    this.myCommits.commits$().pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.cdr.markForCheck());
  }

  async ngOnInit(): Promise<void> {
    void this.myCommits.load().catch(() => undefined);
    try {
      this.rounds = await this.archive.load();
    } catch {
      // The network blinked or the server stayed silent: we show an honest error
      // rather than an empty page that reads as "there were no rounds".
      this.failed = true;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  /** 18 Sep, 14:20 — a short date with no year: the archive is recent. */
  endedAt(round: ArchiveRound): string {
    if (!round.endedAtMs) {
      return '';
    }
    return new Date(round.endedAtMs).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /** How many coins in the round got bought. */
  boughtCount(round: ArchiveRound): number {
    return round.coins.filter((coin) => (coin.boughtSol ?? 0) > 0).length;
  }

  shortMint(mint: string): string {
    return mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
  }

  /** Round verification: the commitment, the randomness, the algorithm. */
  openVerify(lotteryId: number): void {
    VerifyRoundDialogComponent.open(this.dialog, lotteryId);
  }

  isOpen(roundId: number): boolean {
    return this.open.has(roundId);
  }

  /** Open or close a round's transactions; the first opening asks for them. */
  toggle(roundId: number): void {
    if (this.open.delete(roundId)) {
      return;
    }
    this.open.add(roundId);
    const panel = this.panels.get(roundId);
    if (!panel || panel.state === 'failed') {
      void this.loadTransactions(roundId);
    }
  }

  retry(roundId: number): void {
    void this.loadTransactions(roundId);
  }

  txView(roundId: number): TxView {
    const panel = this.panels.get(roundId);
    if (!panel || panel.state !== 'ready' || !panel.feed) {
      return { state: panel?.state ?? 'loading', rows: [], summary: '', total: 0 };
    }
    const wallets = this.myCommits.roundFor(roundId)?.wallets ?? [];
    const cached = this.views.get(roundId);
    if (cached && cached.feed === panel.feed && cached.wallets === wallets) {
      return cached.view;
    }
    const view = transactionsView(panel.feed, wallets);
    this.views.set(roundId, { feed: panel.feed, wallets, view });
    return view;
  }

  private async loadTransactions(roundId: number): Promise<void> {
    if (this.panels.get(roundId)?.state === 'loading') {
      return;
    }
    this.panels.set(roundId, { state: 'loading', feed: null });
    this.cdr.markForCheck();
    try {
      const feed = await this.purchases.once(roundId);
      this.panels.set(roundId, { state: 'ready', feed });
    } catch {
      // Said as it is: "no transactions" would be a claim about the round.
      this.panels.set(roundId, { state: 'failed', feed: null });
    } finally {
      this.cdr.markForCheck();
    }
  }

  trackRound(_: number, round: ArchiveRound): number {
    return round.id;
  }

  trackCoin(_: number, coin: { mint: string }): string {
    return coin.mint;
  }
}

/** The rows and the line above them, for one finished round. */
export function transactionsView(feed: PurchaseFeed, wallets: readonly string[]): TxView {
  const rows = buildFeedRows(feed, wallets);
  const parts: Array<[number, string, string]> = [
    [feed.purchases.length, 'buy', 'buys'],
    [feed.deliveries.length, 'delivery', 'deliveries'],
    [feed.burns.length, 'burn', 'burns'],
    [feed.refunds.length, 'refund', 'refunds']
  ];
  const summary = parts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`)
    .join(' · ');
  const total = parts.reduce((sum, [count]) => sum + count, 0);
  return { state: 'ready', rows, summary, total };
}
