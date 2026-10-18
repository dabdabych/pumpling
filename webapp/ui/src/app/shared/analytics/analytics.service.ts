import { Injectable } from '@angular/core';

type Params = Record<string, string | number | boolean>;

/**
 * Events for Google Analytics 4, for the funnel from the main page to a commit:
 * which of the card's actions people take, and how many of them get as far as
 * the commit dialog and a sent commit. Without this "more people click Commit
 * SOL" stays a feeling.
 *
 * `gtag` exists only where `index.html` loads it (the production domains);
 * anywhere else, the stand and local runs included, this does nothing. Events
 * carry no wallet, address or amount: only which control and in which phase.
 */
@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  event(name: string, params: Params = {}): void {
    const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
    if (typeof gtag !== 'function') {
      return;
    }
    try {
      gtag('event', name, params);
    } catch {
      // Analytics must never break the page.
    }
  }
}
