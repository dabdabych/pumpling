import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Observable } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../shared/http-context-tokens';

/**
 * The purchase feed: what the buyer has bought and in which transactions.
 *
 * It is the only proof that the promise is being kept, so the feed lives on the
 * pool page for the whole buying phase. The polling adapts to the pace of the
 * purchases themselves: if four an hour are planned, asking the server every ten
 * seconds is pointless — a new one appears about every fifteen minutes. And the
 * other way round, in a dense window the feed has to keep up with the events.
 */

export interface PurchaseCoin {
  mint: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  targetSol: number;
  boughtSol: number;
  completed: number;
  planned: number;
  status: string;
  /** The mint's decimals; null for a round from before the buyer recorded them. */
  decimals: number | null;
  /** The coin's burn share, commit-weighted, in basis points. */
  burnBps: number;
  /** Where the coin's burn stands. Null when nobody behind the coin burns. */
  burn: CoinBurn | null;
}

/** Raw token units, as decimal strings. */
export interface CoinBurn {
  boughtRaw: string;
  owedRaw: string;
  burnedRaw: string;
  blockedReason: string | null;
  supplyAtStart: string | null;
  supplyAtEnd: string | null;
}

/** One delivery transaction: up to five wallets. */
export interface DeliveryItem {
  mint: string;
  name: string;
  symbol: string;
  signature: string;
  /** What arrived, summed over the wallets, raw units. */
  raw: string;
  decimals: number | null;
  recipients: string[];
  atMs: number;
}

export interface BurnItem {
  mint: string;
  name: string;
  symbol: string;
  signature: string;
  raw: string;
  decimals: number | null;
  atMs: number;
}

/** Unspent SOL returned at the end of the round: one transaction, one coin. */
export interface RefundItem {
  mint: string;
  name: string;
  symbol: string;
  signature: string;
  sol: number;
  recipients: string[];
  atMs: number;
}

export interface PurchaseItem {
  mint: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  sol: number;
  signature: string;
  venue: string | null;
  atMs: number;
}

/**
 * What the buyer is doing.
 *
 * `fallback` is the second pass: the main window is over and the coins it
 * could not buy in full are being bought again, for up to fifteen minutes. The
 * page shows that countdown instead of the main one and says what it is for —
 * otherwise the timer would sit at zero while purchases were still going out.
 */
export type BuyPhase = 'buying' | 'fallback' | 'finished';

export interface PurchaseFeed {
  /** false means the buyer has not started or is not answering: that is waiting, not zero purchases. */
  available: boolean;
  targetSol: number;
  boughtSol: number;
  completed: number;
  planned: number;
  finished: boolean;
  phase: BuyPhase;
  /** When the second pass runs out, ms. Null outside it. */
  fallbackEndsAtMs: number | null;
  coins: PurchaseCoin[];
  purchases: PurchaseItem[];
  /** Newest first. Deliveries and burns are on chain as much as purchases are. */
  deliveries: DeliveryItem[];
  burns: BurnItem[];
  refunds: RefundItem[];
}

export interface FeedRequest {
  poolId: number;
  /** The length of the buying window, ms: the expected purchase pace is computed from it. */
  windowMs: number;
}

export const EMPTY_FEED: PurchaseFeed = {
  available: false,
  targetSol: 0,
  boughtSol: 0,
  completed: 0,
  planned: 0,
  finished: false,
  phase: 'buying',
  fallbackEndsAtMs: null,
  coins: [],
  purchases: [],
  deliveries: [],
  burns: [],
  refunds: []
};

const MIN_DELAY_MS = 12_000;
const MAX_DELAY_MS = 120_000;
/** The buyer has not answered yet: we ask steadily, with no acceleration. */
const WAITING_DELAY_MS = 20_000;
/** The buying has ended — one rare request is enough in case of a late record. */
const FINISHED_DELAY_MS = 90_000;

@Injectable({ providedIn: 'root' })
export class PurchasesService {
  private readonly feeds = new Map<number, BehaviorSubject<PurchaseFeed>>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly subscribers = new Map<number, number>();
  /** How many answers in a row were unchanged: the polling slows down by this counter. */
  private readonly quiet = new Map<number, number>();

  constructor(private readonly http: HttpClient, private readonly zone: NgZone) {}

  /** A pool's feed; the polling runs while it is subscribed to. */
  feed$(request: FeedRequest): Observable<PurchaseFeed> {
    return new Observable<PurchaseFeed>((subscriber) => {
      const state = this.stateFor(request.poolId);
      this.subscribers.set(request.poolId, (this.subscribers.get(request.poolId) ?? 0) + 1);
      const inner = state.subscribe(subscriber);
      void this.fetch(request);
      return () => {
        inner.unsubscribe();
        const left = (this.subscribers.get(request.poolId) ?? 1) - 1;
        if (left > 0) {
          this.subscribers.set(request.poolId, left);
          return;
        }
        this.subscribers.delete(request.poolId);
        this.clearTimer(request.poolId);
      };
    }).pipe(distinctUntilChanged((a, b) => a === b));
  }

  /** Ask the server now — when the pool has just moved into buying, for instance. */
  refresh(request: FeedRequest): Promise<void> {
    return this.fetch(request);
  }

  /**
   * A finished round's feed, asked for once and not followed: the archive shows
   * rounds whose transactions no longer change. Errors reach the caller, which
   * says so rather than showing an empty round.
   */
  once(poolId: number): Promise<PurchaseFeed> {
    return this.load(poolId);
  }

  private stateFor(poolId: number): BehaviorSubject<PurchaseFeed> {
    let state = this.feeds.get(poolId);
    if (!state) {
      state = new BehaviorSubject<PurchaseFeed>(EMPTY_FEED);
      this.feeds.set(poolId, state);
    }
    return state;
  }

  private async fetch(request: FeedRequest): Promise<void> {
    const { poolId } = request;
    this.clearTimer(poolId);
    let next: PurchaseFeed = EMPTY_FEED;
    try {
      next = await this.load(poolId);
    } catch {
      // The network blinked: we leave on screen what is already there.
      next = this.stateFor(poolId).value;
    }

    const state = this.stateFor(poolId);
    const changed = !sameFeed(state.value, next);
    if (changed) {
      state.next(next);
      this.quiet.set(poolId, 0);
    } else {
      this.quiet.set(poolId, (this.quiet.get(poolId) ?? 0) + 1);
    }

    if (!this.subscribers.has(poolId)) {
      return;
    }
    if (document.hidden) {
      // In a hidden tab nobody is reading the feed; when it comes back we refresh at once.
      this.scheduleOnVisible(request);
      return;
    }
    this.schedule(request, next);
  }

  private async load(poolId: number): Promise<PurchaseFeed> {
    const body = await firstValueFrom(this.http.get<any>(
      `${environment.apiUrl}/lottery/${poolId}/purchases`,
      { context: new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true) }
    ));

    if (!body || typeof body !== 'object') {
      return EMPTY_FEED;
    }
    return {
      available: !!body.available,
      targetSol: num(body.target_sol),
      boughtSol: num(body.bought_sol),
      completed: num(body.completed_purchases),
      planned: num(body.planned_purchases),
      finished: !!body.finished,
      phase: toPhase(body.phase),
      fallbackEndsAtMs: toMs(body.fallback_ends_at),
      coins: Array.isArray(body.coins) ? body.coins.map(toCoin) : [],
      purchases: Array.isArray(body.purchases) ? body.purchases.map(toItem) : [],
      deliveries: Array.isArray(body.deliveries) ? body.deliveries.map(toDelivery).filter(isPresent) : [],
      burns: Array.isArray(body.burns) ? body.burns.map(toBurn).filter(isPresent) : [],
      refunds: Array.isArray(body.refunds) ? body.refunds.map(toRefund).filter(isPresent) : []
    };
  }

  private schedule(request: FeedRequest, feed: PurchaseFeed): void {
    const delay = this.delayFor(request, feed);
    this.zone.runOutsideAngular(() => {
      const timer = setTimeout(() => this.zone.run(() => void this.fetch(request)), delay);
      this.timers.set(request.poolId, timer);
    });
  }

  private scheduleOnVisible(request: FeedRequest): void {
    const onVisible = () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (this.subscribers.has(request.poolId) && !document.hidden) {
        void this.fetch(request);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
  }

  /** How often to ask: from the expected purchase pace, slowing down in silence. */
  private delayFor(request: FeedRequest, feed: PurchaseFeed): number {
    if (feed.phase === 'finished' || feed.finished) {
      return FINISHED_DELAY_MS;
    }
    // The second pass buys what is left, so "everything planned is done" is no
    // longer a reason to stop watching.
    if (feed.phase !== 'fallback' && feed.planned > 0 && feed.completed >= feed.planned) {
      return FINISHED_DELAY_MS;
    }
    if (!feed.available) {
      return WAITING_DELAY_MS;
    }
    const planned = Math.max(1, feed.planned);
    const expectedGapMs = Math.max(1, request.windowMs) / planned;
    const base = clamp(expectedGapMs / 2, MIN_DELAY_MS, MAX_DELAY_MS);
    const quiet = this.quiet.get(request.poolId) ?? 0;
    return clamp(base * Math.pow(1.5, Math.min(quiet, 3)), MIN_DELAY_MS, MAX_DELAY_MS);
  }

  private clearTimer(poolId: number): void {
    const timer = this.timers.get(poolId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(poolId);
    }
  }
}

function toCoin(raw: any): PurchaseCoin {
  return {
    mint: String(raw?.mint ?? ''),
    name: String(raw?.name ?? ''),
    symbol: String(raw?.symbol ?? ''),
    logoUrl: raw?.logo_url ? String(raw.logo_url) : null,
    targetSol: num(raw?.target_sol),
    boughtSol: num(raw?.bought_sol),
    completed: num(raw?.completed_purchases),
    planned: num(raw?.planned_purchases),
    status: String(raw?.status ?? 'pending'),
    decimals: toDecimals(raw?.decimals),
    burnBps: num(raw?.burn_bps),
    burn: toCoinBurn(raw?.burn)
  };
}

function toCoinBurn(raw: any): CoinBurn | null {
  const bought = rawAmount(raw?.bought_raw);
  const owed = rawAmount(raw?.owed_raw);
  const burned = rawAmount(raw?.burned_raw);
  if (bought === null || owed === null || burned === null) {
    return null;
  }
  return {
    boughtRaw: bought,
    owedRaw: owed,
    burnedRaw: burned,
    blockedReason: typeof raw?.blocked_reason === 'string' && raw.blocked_reason ? raw.blocked_reason : null,
    supplyAtStart: rawAmount(raw?.supply_at_start),
    supplyAtEnd: rawAmount(raw?.supply_at_end)
  };
}

function toDelivery(raw: any): DeliveryItem | null {
  const amount = rawAmount(raw?.raw_amount);
  const signature = String(raw?.signature ?? '');
  if (amount === null || !signature) {
    return null;
  }
  return {
    mint: String(raw?.mint ?? ''),
    name: String(raw?.name ?? ''),
    symbol: String(raw?.symbol ?? ''),
    signature,
    raw: amount,
    decimals: toDecimals(raw?.decimals),
    recipients: Array.isArray(raw?.recipients) ? raw.recipients.filter((r: unknown): r is string => typeof r === 'string') : [],
    atMs: Date.parse(String(raw?.at ?? '')) || Date.now()
  };
}

function toBurn(raw: any): BurnItem | null {
  const amount = rawAmount(raw?.raw_amount);
  const signature = String(raw?.signature ?? '');
  if (amount === null || !signature) {
    return null;
  }
  return {
    mint: String(raw?.mint ?? ''),
    name: String(raw?.name ?? ''),
    symbol: String(raw?.symbol ?? ''),
    signature,
    raw: amount,
    decimals: toDecimals(raw?.decimals),
    atMs: Date.parse(String(raw?.at ?? '')) || Date.now()
  };
}

function toRefund(raw: any): RefundItem | null {
  const signature = String(raw?.signature ?? '');
  const sol = num(raw?.sol_amount);
  if (!signature || !(sol > 0)) {
    return null;
  }
  return {
    mint: String(raw?.mint ?? ''),
    name: String(raw?.name ?? ''),
    symbol: String(raw?.symbol ?? ''),
    signature,
    sol,
    recipients: Array.isArray(raw?.recipients) ? raw.recipients.filter((r: unknown): r is string => typeof r === 'string') : [],
    atMs: Date.parse(String(raw?.at ?? '')) || Date.now()
  };
}

/** A raw token amount: digits only, as a string. */
function rawAmount(value: unknown): string | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

function toDecimals(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 18 ? value : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function toItem(raw: any): PurchaseItem {
  return {
    mint: String(raw?.mint ?? ''),
    name: String(raw?.name ?? ''),
    symbol: String(raw?.symbol ?? ''),
    logoUrl: raw?.logo_url ? String(raw.logo_url) : null,
    sol: num(raw?.sol_amount),
    signature: String(raw?.signature ?? ''),
    venue: raw?.venue ? String(raw.venue) : null,
    atMs: Date.parse(String(raw?.at ?? '')) || Date.now()
  };
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toPhase(raw: unknown): BuyPhase {
  return raw === 'fallback' || raw === 'finished' ? raw : 'buying';
}

/** An ISO time from the server, or null when there is none. */
function toMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** The feed has not changed — we do not hand out a new object, so the screen does not twitch. */
function sameFeed(a: PurchaseFeed, b: PurchaseFeed): boolean {
  return a.available === b.available
    && a.phase === b.phase
    && a.fallbackEndsAtMs === b.fallbackEndsAtMs
    && a.completed === b.completed
    && a.planned === b.planned
    && a.finished === b.finished
    && Math.abs(a.boughtSol - b.boughtSol) < 1e-9
    && Math.abs(a.targetSol - b.targetSol) < 1e-9
    && a.purchases.length === b.purchases.length
    && (a.purchases[0]?.signature ?? '') === (b.purchases[0]?.signature ?? '')
    // A delivery or a burn is news too: without these the feed stood still
    // while tokens were going out.
    && a.deliveries.length === b.deliveries.length
    && (a.deliveries[0]?.signature ?? '') === (b.deliveries[0]?.signature ?? '')
    && a.burns.length === b.burns.length
    && (a.burns[0]?.signature ?? '') === (b.burns[0]?.signature ?? '')
    && a.refunds.length === b.refunds.length
    && (a.refunds[0]?.signature ?? '') === (b.refunds[0]?.signature ?? '')
    && sameBurns(a.coins, b.coins);
}

/** The coins' burn figures: the verification window reads them from here. */
function sameBurns(a: PurchaseCoin[], b: PurchaseCoin[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((coin, index) => {
    const other = b[index];
    return coin.mint === other.mint
      && (coin.burn?.burnedRaw ?? '') === (other.burn?.burnedRaw ?? '')
      && (coin.burn?.owedRaw ?? '') === (other.burn?.owedRaw ?? '')
      && (coin.burn?.blockedReason ?? '') === (other.burn?.blockedReason ?? '');
  });
}
