import { HttpContext } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject, combineLatest, firstValueFrom, merge, Observable, timer } from 'rxjs';
import { distinctUntilChanged, map, share, shareReplay } from 'rxjs/operators';

import { Api } from '../api-client/api';
import { getCurrentLotteryLotteryCurrentGet } from '../api-client/fn/lottery/get-current-lottery-lottery-current-get';
import { LotteryListResponse } from '../api-client/models/lottery-list-response';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../shared/http-context-tokens';
import { buildPoolSnapshot, emptyPoolSnapshot, PoolMarket, PoolPhase, PoolSnapshot } from './pool-state';

/**
 * One `/lottery/current` poll for the whole app. The main page and the pool page
 * used to poll it each on their own and every second, and the answer is heavy:
 * the backend gathers per-coin statistics and computes the draw totals on every
 * request.
 *
 * The polling runs while somebody is subscribed to the pool state and adapts to
 * the phase: more often near a deadline, less often in a long wait, and not at
 * all in a hidden tab. The timers on screen tick from the local clock rather than
 * from requests: the server is there to tell us something new, not to count seconds.
 */
@Injectable({ providedIn: 'root' })
export class PoolService implements OnDestroy {
  /** undefined means no answer yet; null means there was one, but it failed and there is no earlier data. */
  private readonly body$ = new BehaviorSubject<LotteryListResponse | null | undefined>(undefined);
  /**
   * A shared clock. The last value is handed out immediately: otherwise a new
   * subscriber — a commit dialog that has just opened, say — would wait up to a
   * second for the first tick and treat the pool as closed all that time.
   */
  private readonly now$ = timer(0, 1000).pipe(map(() => Date.now()), shareReplay({ bufferSize: 1, refCount: true }));
  private readonly polling$: Observable<never>;

  /** The markets somebody is currently watching, and how many subscribers each has. */
  private readonly watching = new Map<PoolMarket, number>();
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private failures = 0;
  private active = false;
  /** How many answers in a row changed nothing: in a long quiet spell we ask less often. */
  private quiet = 0;

  constructor(private readonly api: Api, private readonly zone: NgZone) {
    this.polling$ = new Observable<never>(() => {
      this.start();
      return () => this.stop();
    }).pipe(share());
  }

  /** A market's pool state; while it is subscribed to, the polling runs. */
  snapshot$(market: PoolMarket = 'dex'): Observable<PoolSnapshot> {
    const snapshots = combineLatest([this.body$, this.now$]).pipe(
      map(([body, now]) => body === undefined
        ? emptyPoolSnapshot(market, 'loading')
        : buildPoolSnapshot(body, market, now))
    );
    // The poll rate is set by the phase of the market currently on screen.
    // Working it out across every market would mean keeping a fast poll going
    // because of a pool nobody can see.
    const watched = new Observable<never>(() => {
      this.watching.set(market, (this.watching.get(market) ?? 0) + 1);
      return () => {
        const left = (this.watching.get(market) ?? 1) - 1;
        if (left > 0) {
          this.watching.set(market, left);
        } else {
          this.watching.delete(market);
        }
      };
    });
    return merge(watched, this.polling$, snapshots).pipe(
      distinctUntilChanged((previous, next) => JSON.stringify(previous) === JSON.stringify(next))
    );
  }

  /** Ask the server now — right after a commit, for instance. */
  refresh(): Promise<void> {
    return this.fetch();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private start(): void {
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    void this.fetch();
  }

  private stop(): void {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearTimer();
  }

  private readonly onVisibilityChange = (): void => {
    if (!this.active) {
      return;
    }
    if (document.hidden) {
      this.clearTimer();
      return;
    }
    // Back in the tab: the data may be hours stale.
    void this.fetch();
  };

  private fetch(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.clearTimer();
    this.inFlight = (async () => {
      try {
        const body = await firstValueFrom(this.api.invoke(
          getCurrentLotteryLotteryCurrentGet,
          {},
          new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true)
        ));
        this.failures = 0;
        const next = body ?? null;
        this.quiet = sameBody(this.body$.value, next) ? this.quiet + 1 : 0;
        this.body$.next(next);
      } catch {
        this.failures += 1;
        // A network failure must not erase what is already on screen.
        if (this.body$.value === undefined) {
          this.body$.next(null);
        }
      } finally {
        this.inFlight = null;
        this.scheduleNext();
      }
    })();
    return this.inFlight;
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.active || document.hidden) {
      return;
    }
    const delay = this.nextDelayMs(Date.now());
    // The timer runs outside the Angular zone: on its own it changes nothing on
    // screen, and change detection is triggered by the server's answer.
    this.zone.runOutsideAngular(() => {
      this.timerId = setTimeout(() => this.zone.run(() => void this.fetch()), delay);
    });
  }

  private nextDelayMs(now: number): number {
    if (this.failures > 0) {
      return Math.min(30_000, 5_000 * 2 ** (this.failures - 1));
    }
    const body = this.body$.value;
    const markets = this.watching.size > 0 ? [...this.watching.keys()] : (['dex'] as PoolMarket[]);
    const snapshots = markets.map((market) => buildPoolSnapshot(body, market, now));
    const delays = snapshots.map((snapshot) => delayForSnapshot(snapshot, now));
    const delay = Math.min(...delays);
    if (snapshots.some((snapshot) => KEEPS_PACE.has(snapshot.phase))) {
      return delay;
    }
    // We wait out the changeover with fast polling, but if the pool never turns
    // up we stretch the pause: there is no point sitting at four seconds for hours.
    const slowdown = Math.min(4, Math.max(0, this.quiet - 5));
    return Math.min(30_000, delay * Math.pow(1.6, slowdown));
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}

/** The answer has not changed — we can ask less often. */
function sameBody(a: LotteryListResponse | null | undefined, b: LotteryListResponse | null): boolean {
  if (a === undefined || a === null || b === null) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Phases where we do not slow the poll rate down, even if the answer stays the same for a while.
 *
 * The draw runs for a minute and the result arrives in a single answer: slowed to
 * twenty seconds, the page would show the winners a whole drama late. An open
 * pool is the same story with commits. Slowing down stays where there is nothing
 * to wait for: the changeover, waiting for a new pool, the launch announcement.
 */
const KEEPS_PACE = new Set<PoolPhase>(['open', 'locked', 'buying']);

/** How often to ask the server in this phase, ms. */
export function delayForSnapshot(snapshot: PoolSnapshot, now: number): number {
  const soon = (atMs: number | null, withinMs: number) => atMs !== null && atMs - now <= withinMs;
  switch (snapshot.phase) {
    case 'open':
      // Other people's commits appear in the list within a few seconds; near the
      // close more often, so we do not show an open pool the server has already locked.
      return soon(snapshot.closesAtMs, 15_000) ? 2_000 : 5_000;
    case 'opening':
    case 'locked':
      return 3_000;
    case 'buying':
      return soon(snapshot.buysEndAtMs, 30_000) ? 3_000 : 15_000;
    case 'launch':
      return soon(snapshot.launchAtMs, 60_000) ? 5_000 : 30_000;
    case 'waiting':
    case 'done':
      // The changeover: the worker opens a new pool within a few seconds, and all
      // that time a person is looking at "opening". We ask more often so the page
      // switches by itself, with no reload.
      return 4_000;
    default:
      return 10_000;
  }
}
