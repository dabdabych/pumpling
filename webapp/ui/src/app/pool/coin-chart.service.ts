import { HttpContext, HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../shared/http-context-tokens';

/**
 * The coin's chart over the last few minutes, for the tooltip on a row hover.
 *
 * We ask only on hover and only once per coin: the answer lives in the tab's
 * memory while it is fresh. The server caches anyway, but an extra request from
 * the browser on every mouse movement is a bad habit that quickly runs into the
 * source's limits.
 */

export interface CoinChartPoint {
  t: number;
  p: number;
}

export interface CoinChart {
  available: boolean;
  points: CoinChartPoint[];
  minutes: number;
  venue: string | null;
  priceUsd: number | null;
  changePct: number | null;
}

const EMPTY: CoinChart = { available: false, points: [], minutes: 0, venue: null, priceUsd: null, changePct: null };
/** The same as the server holds: beyond that it is worth asking again. */
const FRESH_MS = 45_000;

@Injectable({ providedIn: 'root' })
export class CoinChartService {
  private readonly cache = new Map<string, { at: number; chart: CoinChart }>();
  private readonly inFlight = new Map<string, Promise<CoinChart>>();

  constructor(private readonly http: HttpClient) {}

  /** The ready chart, if it is already loaded: the tooltip draws at once. */
  cached(mint: string): CoinChart | null {
    const entry = this.cache.get(mint);
    return entry && Date.now() - entry.at < FRESH_MS ? entry.chart : null;
  }

  async load(mint: string): Promise<CoinChart> {
    const ready = this.cached(mint);
    if (ready) {
      return ready;
    }
    const pending = this.inFlight.get(mint);
    if (pending) {
      return pending;
    }

    const request = this.fetch(mint).then((chart) => {
      this.cache.set(mint, { at: Date.now(), chart });
      this.inFlight.delete(mint);
      return chart;
    }).catch(() => {
      this.inFlight.delete(mint);
      // We do not remember a network failure: the next hover tries again.
      return EMPTY;
    });
    this.inFlight.set(mint, request);
    return request;
  }

  private async fetch(mint: string): Promise<CoinChart> {
    const body = await firstValueFrom(this.http.get<any>(
      `${environment.apiUrl}/lottery/coin/${mint}/chart`,
      { context: new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true) }
    ));
    if (!body || typeof body !== 'object') {
      return EMPTY;
    }
    return {
      available: !!body.available,
      points: Array.isArray(body.points)
        ? body.points.map((point: any) => ({ t: Number(point?.t) || 0, p: Number(point?.p) || 0 })).filter((point: CoinChartPoint) => point.p > 0)
        : [],
      minutes: Number(body.minutes) || 0,
      venue: body.venue ? String(body.venue) : null,
      priceUsd: Number.isFinite(body.price_usd) ? Number(body.price_usd) : null,
      changePct: Number.isFinite(body.change_pct) ? Number(body.change_pct) : null
    };
  }
}

/**
 * The path for the mini chart: the points are normalised by their own minimum
 * and maximum, otherwise a coin worth fractions of a cent would lie flat on the
 * floor. Smoothed with cubic Béziers — straight segments at this scale look like
 * a cardiogram.
 */
export function chartPath(points: CoinChartPoint[], width: number, height: number): string {
  if (points.length < 2) {
    return '';
  }
  const prices = points.map((point) => point.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || max || 1;
  const padding = height * 0.12;
  const usable = height - padding * 2;

  const coords = points.map((point, index) => ({
    x: (index / (points.length - 1)) * width,
    y: padding + usable - ((point.p - min) / span) * usable
  }));

  // We keep the control points inside the drawing area. On a sharp price jump
  // Catmull-Rom throws them above the maximum and below the minimum, the curve
  // runs past the picture and is clipped by the edge of the svg. The clamp is on
  // y: overshoot on x is impossible, the points are evenly spaced.
  const top = padding;
  const bottom = padding + usable;
  const clampY = (value: number) => Math.min(bottom, Math.max(top, value));

  let path = `M${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    path += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return path;
}

/** Whether the price rose or fell over the stretch shown, in percent. */
export function chartChangePct(points: CoinChartPoint[]): number | null {
  if (points.length < 2) {
    return null;
  }
  const first = points[0].p;
  const last = points[points.length - 1].p;
  if (!(first > 0)) {
    return null;
  }
  return ((last - first) / first) * 100;
}
