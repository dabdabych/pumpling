import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { environment } from '../../environments/environment';
import { SiteHeaderComponent } from '../shared/site-header/site-header.component';
import { ArchiveRound, ArchiveService } from './archive.service';
import { VerifyRoundDialogComponent } from '../shared/verify-round/verify-round-dialog.component';

/**
 * Past rounds.
 *
 * Why the page exists: it is the only proof that the machine works in practice
 * rather than in words. A person sees closed pools, how much SOL was in them,
 * which coins stood in them and how much went into buying each. It can all be
 * checked through a Solscan link, so every round carries its account address.
 *
 * Empty rounds never reach here: the server filters them out.
 */
@Component({
  selector: 'app-archive-page',
  standalone: true,
  imports: [DecimalPipe, RouterLink, SiteHeaderComponent],
  templateUrl: './archive-page.component.html',
  styleUrls: ['./archive-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ArchivePageComponent implements OnInit {
  readonly explorerQuery = environment.solanaExplorerQuery;

  rounds: ArchiveRound[] = [];
  loading = true;
  failed = false;

  constructor(private readonly archive: ArchiveService, private readonly cdr: ChangeDetectorRef,
    private readonly dialog: MatDialog
  ) {}

  async ngOnInit(): Promise<void> {
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

  trackRound(_: number, round: ArchiveRound): number {
    return round.id;
  }

  trackCoin(_: number, coin: { mint: string }): string {
    return coin.mint;
  }
}
