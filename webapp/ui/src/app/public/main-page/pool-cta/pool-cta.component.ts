import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { combineLatest, from, Observable, timer } from 'rxjs';
import { distinctUntilChanged, filter, map, startWith, switchMap } from 'rxjs/operators';

import { PoolService } from '../../../pool/pool.service';
import { AnalyticsService } from '../../../shared/analytics/analytics.service';
import { DesignPreviewSharedModule } from '../../design-preview-shared.module';
import { CtaLink, CtaView, poolCta } from './pool-cta';
import { RecentBuysService } from './recent-buys.service';

/**
 * The Commit SOL card on the main page: the coins and candles, and over them,
 * in the clear middle the drawing leaves, what pressing the card does, where
 * the round is and one line on what that means. What it says in each phase is
 * `pool-cta.ts`.
 *
 * The whole card is one link, made the way Inclusive Components recommends for
 * cards (Heydon Pickering, "Cards"): the title is the link, and its `::after`
 * is stretched over the card. A screen reader hears the action alone, not the
 * countdown ticking inside it, and the whole drawing still takes the press.
 * Material calls the card itself a card's primary action for the same reason.
 *
 * On 2026-10-16 a panel with steps, a field and buttons stood here and covered
 * the drawing; Georgiy: a nightmare. The field for a coin's address lives in
 * the commit dialog, past pools in the header. The card leads to the pool page
 * without opening the dialog: the pool page's own Commit SOL does that.
 */
@Component({
  selector: 'app-pool-cta',
  standalone: true,
  imports: [AsyncPipe, RouterLink, DesignPreviewSharedModule],
  templateUrl: './pool-cta.component.html',
  styleUrls: ['./pool-cta.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PoolCtaComponent {
  readonly view$: Observable<CtaView>;

  constructor(
    private readonly pool: PoolService,
    private readonly recent: RecentBuysService,
    private readonly analytics: AnalyticsService
  ) {
    const snapshot$ = this.pool.snapshot$('dex');

    // How the last pool ended is asked for once, and again when a new pool
    // starts: that is when the archive has gained a round.
    const lastPool$ = snapshot$.pipe(
      filter((snapshot) => snapshot.phase !== 'loading'),
      map((snapshot) => snapshot.poolId),
      distinctUntilChanged(),
      switchMap((poolId) => from(this.recent.lastPool(poolId))),
      startWith(null)
    );

    this.view$ = combineLatest([snapshot$, lastPool$, timer(0, 1000)]).pipe(
      map(([snapshot, lastPool]) => poolCta({ snapshot, nowMs: Date.now(), lastPool }))
    );
  }

  route(link: CtaLink): string {
    return link.to === 'archive' ? '/archive' : '/pool';
  }

  query(link: CtaLink): Record<string, number> | null {
    return link.to === 'archive' ? { pool: link.pool } : null;
  }

  opened(view: CtaView): void {
    const taking = view.phase === 'open' || view.phase === 'opening';
    this.analytics.event(taking ? 'home_promote_click' : 'home_watch_click', { phase: view.phase, to: view.link.to });
  }
}
