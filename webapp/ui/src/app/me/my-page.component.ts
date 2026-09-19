import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { environment } from '../../environments/environment';
import { AuthDialogService } from '../auth/auth-dialog.service';
import { SiteHeaderComponent } from '../shared/site-header/site-header.component';
import { MyCommits, MyCommitsService, MyRound } from './my-commits.service';

/**
 * My commits.
 *
 * Why the page exists: a person handed over SOL and until this screen could not
 * see that they had taken part at all. Here are their commits by round, their
 * share in each coin, the transaction signatures and the wallet the bought tokens
 * will arrive at.
 *
 * What is deliberately absent: how many tokens arrived. We do not know that —
 * the tokens go straight to the wallet and Solscan tells the truth about them.
 * Inventing a number for the sake of looks is not on: it is a promise we never made.
 */
@Component({
  selector: 'app-my-page',
  standalone: true,
  imports: [DecimalPipe, RouterLink, SiteHeaderComponent],
  templateUrl: './my-page.component.html',
  styleUrls: ['./my-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MyPageComponent implements OnInit {
  readonly explorerQuery = environment.solanaExplorerQuery;

  commits: MyCommits | null = null;
  loading = true;
  failed = false;

  constructor(
    private readonly service: MyCommitsService,
    private readonly authDialog: AuthDialogService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.commits = await this.service.refresh();
    } catch {
      this.failed = true;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }

  signIn(): void {
    this.authDialog.open({ mode: 'sign-in' });
  }

  /** The round is still running: too early to sum it up. */
  isLive(round: MyRound): boolean {
    return !['closed', 'completed'].includes(round.status);
  }

  roundDate(round: MyRound): string {
    const stamp = round.endedAtMs || round.createdAtMs;
    if (!stamp) {
      return '';
    }
    return new Date(stamp).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /** My share in the coin: without it the amount says nothing. */
  sharePct(mySol: number, poolSol: number): number {
    return poolSol > 0 ? (mySol / poolSol) * 100 : 0;
  }

  short(value: string): string {
    return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
  }

  trackRound(_: number, round: MyRound): number {
    return round.lotteryId;
  }

  trackCoin(_: number, coin: { mint: string }): string {
    return coin.mint;
  }
}
