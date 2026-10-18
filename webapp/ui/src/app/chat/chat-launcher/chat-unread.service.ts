import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Observable } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import { environment } from '../../../environments/environment';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../../shared/http-context-tokens';

/** How often the newest message is asked for while the page is in front. */
const POLL_MS = 60_000;
const SEEN_KEY = 'pumpling.chat.seen';

/**
 * Whether the chat has a message this visitor has not seen: the dot on the
 * header's chat button.
 *
 * The chat moved from the first screen into the header on 2026-10-16, and a
 * closed chat says nothing about itself. One small request a minute, for the
 * newest message alone, and only while the page is in front; the chat's own
 * connection opens only when somebody opens it. What was seen is kept in the
 * browser: a dot is a convenience, and losing it costs nothing.
 */
@Injectable({ providedIn: 'root' })
export class ChatUnreadService implements OnDestroy {
  private readonly newest$ = new BehaviorSubject<number>(0);
  private readonly seen$ = new BehaviorSubject<number>(readSeen());
  private chatId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchers = 0;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') {
      void this.poll();
    }
  };

  readonly unread$: Observable<boolean> = this.newest$.pipe(
    map((newest) => newest > this.seen$.value),
    distinctUntilChanged()
  );

  constructor(private readonly http: HttpClient, private readonly zone: NgZone) {}

  /** A header that shows the dot starts the polling; the last one to go stops it. */
  watch(): () => void {
    this.watchers++;
    if (this.watchers === 1) {
      void this.poll();
      this.zone.runOutsideAngular(() => {
        this.timer = setInterval(() => {
          if (document.visibilityState === 'visible') {
            void this.poll();
          }
        }, POLL_MS);
      });
      document.addEventListener('visibilitychange', this.onVisible);
    }
    return () => {
      this.watchers = Math.max(0, this.watchers - 1);
      if (this.watchers === 0) {
        this.stop();
      }
    };
  }

  /** The chat is open: everything up to the newest message has been seen. */
  markSeen(): void {
    const newest = this.newest$.value;
    if (newest > this.seen$.value) {
      this.seen$.next(newest);
      writeSeen(newest);
    }
    // Re-emit, so the dot recomputes against the new mark.
    this.newest$.next(newest);
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  private async poll(): Promise<void> {
    const context = new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true);
    try {
      if (this.chatId === null) {
        const chat = await firstValueFrom(this.http.get<{ id?: number }>(`${environment.apiUrl}/chats/default`, { context }));
        this.chatId = Number(chat?.id) || null;
        if (this.chatId === null) {
          return;
        }
      }
      const page = await firstValueFrom(this.http.get<{ items?: Array<{ id?: number }> }>(
        `${environment.apiUrl}/chats/${this.chatId}/messages`,
        { params: { limit: 1 }, context }
      ));
      const newest = Number(page?.items?.[page.items.length - 1]?.id) || 0;
      if (newest !== this.newest$.value) {
        this.zone.run(() => this.newest$.next(newest));
      }
    } catch {
      // No dot is the right answer when the chat cannot be reached.
    }
  }
}

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(value: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(value));
  } catch {
    // A private window: the dot comes back next visit, nothing worse.
  }
}
