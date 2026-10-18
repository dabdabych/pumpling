import { Injectable } from '@angular/core';

import { ArchiveService } from '../../../archive/archive.service';
import { PurchasesService } from '../../../pool/purchases.service';
import { CtaLastPool } from './pool-cta';

/** Finished pools to look through for one with purchases. */
const LOOK_BACK = 3;
/** A finished pool does not change; the list of them does, about every hour and a half. */
const FRESH_MS = 5 * 60_000;

/**
 * How the last pool that bought something ended, for the main page's card
 * between pools: "Last pool: 21 SOL → 52 public buys", and the way to it in the
 * archive. Asked once on the main page and again only when a new pool has
 * started, so a visit costs the archive and one finished pool's feed.
 */
@Injectable({ providedIn: 'root' })
export class RecentBuysService {
  private cached: { at: number; forPool: number | null; value: CtaLastPool | null } | null = null;
  private inFlight: Promise<CtaLastPool | null> | null = null;

  constructor(private readonly archive: ArchiveService, private readonly purchases: PurchasesService) {}

  /** `currentPool` is the pool on now: when it changes, the archive has a new round in it. */
  async lastPool(currentPool: number | null): Promise<CtaLastPool | null> {
    const cached = this.cached;
    if (cached && cached.forPool === currentPool && Date.now() - cached.at < FRESH_MS) {
      return cached.value;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.fetch()
      .then((value) => {
        this.cached = { at: Date.now(), forPool: currentPool, value };
        return value;
      })
      // Nothing is better than something wrong: the card says the general line instead.
      .catch(() => cached?.value ?? null)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetch(): Promise<CtaLastPool | null> {
    const rounds = await this.archive.load();
    for (const round of rounds.slice(0, LOOK_BACK)) {
      const feed = await this.purchases.once(round.id);
      if (feed.purchases.length > 0) {
        return { id: round.id, totalSol: round.totalSol, buys: feed.purchases.length };
      }
    }
    return null;
  }
}
