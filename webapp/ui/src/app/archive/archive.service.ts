import { HttpContext } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Api } from '../api-client/api';
import { getLotteryArchiveLotteryArchiveGet } from '../api-client/fn/lottery/get-lottery-archive-lottery-archive-get';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../shared/http-context-tokens';

/**
 * The history of past rounds.
 *
 * The server does not return empty rounds: while there are few participants a
 * round still opens every few hours, and without that filter the history would be
 * a list of zeros. The default window is a week, here we ask for a month: there
 * are not many rounds yet and seeing something matters more.
 */

export interface ArchiveCoin {
  rank: number;
  mint: string;
  name: string;
  ticker: string;
  /** How much SOL stood behind the coin. */
  sol: number;
  /** How much SOL went into buying it after the draw; null means there was no draw. */
  boughtSol: number | null;
}

export interface ArchiveRound {
  id: number;
  status: string;
  poolAccount: string | null;
  endedAtMs: number;
  totalSol: number;
  coins: ArchiveCoin[];
}

const WINDOW_DAYS = 30;

@Injectable({ providedIn: 'root' })
export class ArchiveService {
  constructor(private readonly api: Api) {}

  async load(): Promise<ArchiveRound[]> {
    const response = await firstValueFrom(
      this.api.invoke(
        getLotteryArchiveLotteryArchiveGet,
        { lottery_type: 'dex', window_days: WINDOW_DAYS },
        new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true)
      )
    );
    const items = Array.isArray(response?.items) ? response.items : [];
    return items
      .map((item) => ({
        id: Number(item.id) || 0,
        status: String(item.status ?? ''),
        poolAccount: item.lottery_pda ? String(item.lottery_pda) : null,
        endedAtMs: Date.parse(String(item.ended_at ?? '')) || 0,
        totalSol: num(item.total_pool_sol),
        coins: (item.entries ?? []).map((entry) => ({
          rank: Number(entry.rank) || 0,
          mint: String(entry.mint ?? ''),
          name: String(entry.name ?? ''),
          ticker: String(entry.ticker ?? '').replace(/^\$/, ''),
          sol: num(entry.total_solana_bet),
          boughtSol: entry.won_sol === null || entry.won_sol === undefined ? null : num(entry.won_sol)
        }))
      }))
      // The server returns newest first, but we will not rely on that.
      .sort((a, b) => b.endedAtMs - a.endedAtMs);
  }
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
