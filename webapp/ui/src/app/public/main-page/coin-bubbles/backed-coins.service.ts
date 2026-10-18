import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../../../shared/http-context-tokens';

/** A coin people have backed with SOL, across every pool, and where it trades. */
export interface BackedCoin {
  mint: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  sol: number;
  pools: number;
  tradeUrl: string;
  /** "pump.fun" or "DexScreener". */
  venue: string;
}

/** The least SOL a coin needs to be drawn, all its pools together. */
export const BACKED_MIN_SOL = 1;
/** The coins committed to most lately, this many (Georgiy, 2026-10-16). */
export const BACKED_LATEST = 10;
/** The server keeps its answer a minute; asking more often gets the same one. */
const FRESH_MS = 60_000;

/**
 * The coins for the bubbles on the main page (`GET /lottery/coins/backed`):
 * the ten committed to most lately, with 1 SOL and up behind each.
 *
 * Only an `https` link from the server is followed: the card opens it in a new
 * tab, and a coin's data passes through what strangers wrote about their coin.
 */
@Injectable({ providedIn: 'root' })
export class BackedCoinsService {
  private cached: { at: number; value: BackedCoin[] } | null = null;
  private inFlight: Promise<BackedCoin[]> | null = null;

  constructor(private readonly http: HttpClient) {}

  load(): Promise<BackedCoin[]> {
    if (this.cached && Date.now() - this.cached.at < FRESH_MS) {
      return Promise.resolve(this.cached.value);
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = firstValueFrom(this.http.get<{ items?: unknown[] }>(
      `${environment.apiUrl}/lottery/coins/backed`,
      { params: { min_sol: BACKED_MIN_SOL, limit: BACKED_LATEST, sort: 'recent' }, context: new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true) }
    ))
      .then((body) => {
        const value = (Array.isArray(body?.items) ? body.items : []).map(toCoin).filter((coin): coin is BackedCoin => coin !== null);
        this.cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

function toCoin(raw: unknown): BackedCoin | null {
  const item = (raw ?? {}) as Record<string, unknown>;
  const mint = String(item['mint'] ?? '').trim();
  const sol = Number(item['sol']);
  const tradeUrl = safeHttps(item['trade_url']);
  if (!mint || !Number.isFinite(sol) || sol <= 0 || !tradeUrl) {
    return null;
  }
  return {
    mint,
    name: String(item['name'] ?? '').trim() || mint.slice(0, 6),
    // Some coins carry the dollar in their ticker ("$SWORDPUMP"); the site adds its own.
    symbol: String(item['symbol'] ?? '').trim().replace(/^\$+/, '') || mint.slice(0, 4).toUpperCase(),
    logoUrl: safeHttps(item['logo_url']),
    sol,
    pools: Math.max(1, Number(item['pools']) || 1),
    tradeUrl,
    venue: String(item['venue'] ?? '').trim() || 'DexScreener'
  };
}

function safeHttps(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
