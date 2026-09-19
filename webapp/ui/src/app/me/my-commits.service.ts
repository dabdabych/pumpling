import { HttpContext } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Observable } from 'rxjs';

import { Api } from '../api-client/api';
import { getMyCommitsLotteryMyCommitsGet } from '../api-client/fn/lottery/get-my-commits-lottery-my-commits-get';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../shared/http-context-tokens';

/**
 * My commits: where I took part and how much I put in.
 *
 * The data is needed in two places at once — on the pool page, to highlight my
 * rows, and on the personal page. So the answer lives in the service: two screens
 * must not ask the server separately, and after a new commit a `refresh()` is enough.
 */

export interface MyCoin {
  mint: string;
  name: string;
  ticker: string;
  logoUrl: string | null;
  /** How much I put in. */
  mySol: number;
  myCommits: number;
  /** How much stands behind the coin from everyone together. */
  poolSol: number;
  /** How much went into the buying after the draw; null means there was no draw. */
  drawnSol: number | null;
  signatures: string[];
}

export interface MyRound {
  lotteryId: number;
  status: string;
  createdAtMs: number;
  endedAtMs: number;
  mySol: number;
  poolSol: number;
  wallets: string[];
  coins: MyCoin[];
}

export interface MyCommits {
  totalSol: number;
  rounds: MyRound[];
  /** The answer arrived: an empty history and "we never asked" are different things. */
  loaded: boolean;
  /** Not signed in: there is no history to show, but there is no error either. */
  signedOut: boolean;
}

export const EMPTY_COMMITS: MyCommits = { totalSol: 0, rounds: [], loaded: false, signedOut: false };

@Injectable({ providedIn: 'root' })
export class MyCommitsService {
  private readonly state = new BehaviorSubject<MyCommits>(EMPTY_COMMITS);
  private inFlight: Promise<MyCommits> | null = null;

  constructor(private readonly api: Api) {}

  /** The current state: subscribers get it at once, with no new request. */
  commits$(): Observable<MyCommits> {
    return this.state.asObservable();
  }

  get value(): MyCommits {
    return this.state.value;
  }

  /** Loads the history if it is not there yet. */
  async load(): Promise<MyCommits> {
    if (this.state.value.loaded) {
      return this.state.value;
    }
    return this.refresh();
  }

  /** Asks the server again: a commit changes the history. */
  async refresh(): Promise<MyCommits> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.fetch()
      .then((commits) => {
        this.state.next(commits);
        return commits;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** My commits in a particular pool: for highlighting rows on the pool page. */
  roundFor(lotteryId: number | null): MyRound | null {
    if (lotteryId === null) {
      return null;
    }
    return this.state.value.rounds.find((round) => round.lotteryId === lotteryId) ?? null;
  }

  /** Forget the history: on sign-out it belongs to somebody else. */
  clear(): void {
    this.state.next(EMPTY_COMMITS);
  }

  private async fetch(): Promise<MyCommits> {
    try {
      const response = await firstValueFrom(
        this.api.invoke(
          getMyCommitsLotteryMyCommitsGet,
          {},
          new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true)
        )
      );
      return {
        totalSol: num(response?.total_sol),
        loaded: true,
        signedOut: false,
        rounds: (response?.rounds ?? []).map((round) => ({
          lotteryId: Number(round.lottery_id) || 0,
          status: String(round.status ?? ''),
          createdAtMs: Date.parse(String(round.created_at ?? '')) || 0,
          endedAtMs: Date.parse(String(round.end_date ?? '')) || 0,
          mySol: num(round.my_sol),
          poolSol: num(round.pool_sol),
          wallets: (round.wallets ?? []).map((wallet) => String(wallet)),
          coins: (round.coins ?? []).map((coin) => ({
            mint: String(coin.mint ?? ''),
            name: String(coin.name ?? ''),
            ticker: String(coin.ticker ?? '').replace(/^\$/, ''),
            logoUrl: coin.logo_url ? String(coin.logo_url) : null,
            mySol: num(coin.my_sol),
            myCommits: Number(coin.my_commits) || 0,
            poolSol: num(coin.pool_sol),
            drawnSol: coin.drawn_sol === null || coin.drawn_sol === undefined ? null : num(coin.drawn_sol),
            signatures: (coin.signatures ?? []).map((signature) => String(signature))
          }))
        }))
      };
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 401 || status === 403) {
        // Not signed in: that is not a failure, there is simply nothing to show.
        return { ...EMPTY_COMMITS, loaded: true, signedOut: true };
      }
      throw error;
    }
  }
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
