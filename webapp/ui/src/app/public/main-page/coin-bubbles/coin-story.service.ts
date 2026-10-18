import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../../../shared/http-context-tokens';
import { CoinStory, toStory } from './coin-story';

/** A coin's window is asked again after this long, unless its chart is final and will never change. */
const FRESH_MS = 60_000;

/** A coin's stay in pumpling, for the window from its bubble (`GET /lottery/coins/<mint>/story`). */
@Injectable({ providedIn: 'root' })
export class CoinStoryService {
  private readonly cached = new Map<string, { at: number; story: CoinStory }>();

  constructor(private readonly http: HttpClient) {}

  async load(mint: string): Promise<CoinStory> {
    const kept = this.cached.get(mint);
    if (kept && (kept.story.chartFinal || Date.now() - kept.at < FRESH_MS)) {
      return kept.story;
    }
    const body = await firstValueFrom(this.http.get<unknown>(
      `${environment.apiUrl}/lottery/coins/${encodeURIComponent(mint)}/story`,
      { context: new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true) }
    ));
    const story = toStory(body);
    if (!story) {
      throw new Error('The coin window came back unreadable.');
    }
    // A chart on its way, busy or failed is asked again the next time, not a minute later.
    if (story.chartState === 'ready' || story.chartState === 'none') {
      this.cached.set(mint, { at: Date.now(), story });
    } else {
      this.cached.delete(mint);
    }
    return story;
  }
}
