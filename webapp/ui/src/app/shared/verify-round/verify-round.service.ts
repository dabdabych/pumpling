import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../http-context-tokens';

/**
 * The data for verifying a round.
 *
 * The same fields `/lottery/{id}/verification` returns. The page computes
 * nothing itself: the backend does, and anyone who wants to recomputes it all
 * themselves from the instructions in the public repository. Our job is to show
 * the sources of the verification and not make people hunt for them.
 */
export interface RoundVerification {
  lottery_id: number;
  lottery_type: string;
  status: string;
  network: string;
  program_id: string | null;
  lottery_account: string | null;
  vault_account: string | null;
  admin_account: string | null;
  weights_hash_onchain: string | null;
  weights_payload: string | null;
  weights_hash_recomputed: string | null;
  weights_match: boolean | null;
  randomness_source: 'vrf' | 'emergency' | 'pending' | string;
  randomness_account: string | null;
  vrf_seed: string | null;
  vrf_algorithm_hash: string | null;
  algorithm_source: string;
  winner_results: Array<{ mint: string; wins: number; target_sol?: number }>;
}

@Injectable({ providedIn: 'root' })
export class VerifyRoundService {
  private readonly cache = new Map<number, RoundVerification>();

  constructor(private readonly http: HttpClient) {}

  /** The address of the machine-readable data: we show it too, so it can be fetched by script. */
  jsonUrl(lotteryId: number): string {
    return `${environment.apiUrl}/lottery/${lotteryId}/verification`;
  }

  /** Where to go for the instructions on recomputing all this by hand. */
  get docsUrl(): string {
    return environment.verifyDocsUrl;
  }

  async load(lotteryId: number): Promise<RoundVerification> {
    const cached = this.cache.get(lotteryId);
    if (cached) {
      return cached;
    }
    const data = await firstValueFrom(this.http.get<RoundVerification>(
      this.jsonUrl(lotteryId),
      { context: new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true) }
    ));
    this.cache.set(lotteryId, data);
    return data;
  }
}
