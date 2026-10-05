import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  NgZone,
  OnDestroy,
  ViewChild
} from '@angular/core';

import { environment } from '../../../environments/environment';
import { FlameComponent } from '../../shared/flame/flame.component';
import { FeedRow, recipientsShort, recipientsText } from '../feed-rows';
import { formatSol } from '../pool-state';

/** How a row says when it happened. */
export type TxFeedTime = 'relative' | 'clock';

/**
 * A round's transactions in a window of their own: purchases, deliveries,
 * burns and refunds, newest first, each one linking to its transaction.
 *
 * The pool page shows it while a round buys and right after; the archive shows
 * it for every finished round. They differ in one thing, how a row tells the
 * time. On the pool page it is relative ("2 min ago"), which is how the pace of
 * the buying shows. In the archive it is the clock: "3 days ago" on every row of
 * a finished round would say nothing.
 *
 * An hour of buying is a few hundred rows, so the window scrolls inside itself
 * and draws its own bar (the styles say why).
 */
@Component({
  selector: 'app-tx-feed',
  standalone: true,
  imports: [FlameComponent],
  templateUrl: './tx-feed.component.html',
  styleUrls: ['./tx-feed.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TxFeedComponent implements OnDestroy {
  /** The rows, newest first (`buildFeedRows`). */
  @Input({ required: true }) rows: FeedRow[] = [];
  @Input() time: TxFeedTime = 'relative';
  /** The clock relative times are measured from; the pool page passes its once-a-second tick. */
  @Input() nowMs = 0;
  /** The id of the heading that names the window, for screen readers. */
  @Input({ required: true }) labelledBy = '';

  /** The drawn scrollbar: how tall the thumb is, and where. */
  thumb: { size: number; at: number } | null = null;

  private node: HTMLElement | null = null;
  private frame = 0;
  private sizes: ResizeObserver | null = null;
  private dragEnd: (() => void) | null = null;

  constructor(private readonly cdr: ChangeDetectorRef, private readonly zone: NgZone) {}

  /**
   * A setter rather than a plain `@ViewChild`: the window is measured again
   * whenever it appears, and the observer measures it again whenever a row is
   * added to it.
   */
  @ViewChild('feed')
  set feed(ref: ElementRef<HTMLElement> | undefined) {
    this.sizes?.disconnect();
    this.sizes = null;
    this.node = ref?.nativeElement ?? null;
    if (!this.node) {
      this.thumb = null;
      return;
    }
    if (typeof ResizeObserver === 'function') {
      this.sizes = new ResizeObserver(() => this.scheduleMeasure());
      this.sizes.observe(this.node);
      const list = this.node.firstElementChild;
      if (list) {
        this.sizes.observe(list);
      }
    }
    this.scheduleMeasure();
  }

  ngOnDestroy(): void {
    this.sizes?.disconnect();
    this.endDrag();
    if (this.frame) {
      cancelAnimationFrame(this.frame);
    }
  }

  onScroll(): void {
    this.scheduleMeasure();
  }

  /** The thumb drags the rows the way a scrollbar is expected to. */
  startDrag(event: PointerEvent): void {
    const node = this.node;
    const thumb = event.currentTarget as HTMLElement;
    const rail = thumb.parentElement;
    if (!node || !rail) {
      return;
    }
    event.preventDefault();
    const railBox = rail.getBoundingClientRect();
    const thumbBox = thumb.getBoundingClientRect();
    // Where inside the thumb it was taken hold of, so it does not jump under
    // the cursor on the first move.
    const grab = event.clientY - thumbBox.top;
    const travel = railBox.height - thumbBox.height;
    const room = node.scrollHeight - node.clientHeight;
    const move = (moved: PointerEvent) => {
      const at = Math.min(Math.max(moved.clientY - railBox.top - grab, 0), travel);
      node.scrollTop = travel > 0 ? (at / travel) * room : 0;
    };
    const stop = () => this.endDrag();
    this.endDrag();
    this.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      this.dragEnd = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
    });
  }

  when(row: FeedRow): string {
    return this.time === 'clock' ? clockTime(row.atMs) : timeAgo(row.atMs, this.nowMs || Date.now());
  }

  formatSol(value: number): string {
    return formatSol(value);
  }

  recipientsText(row: FeedRow): string {
    return recipientsText(row);
  }

  recipientsShort(row: FeedRow): string {
    return recipientsShort(row);
  }

  explorerUrl(signature: string): string {
    return `https://solscan.io/tx/${signature}${environment.solanaExplorerQuery || ''}`;
  }

  shortSignature(signature: string): string {
    return signature.length > 12 ? `${signature.slice(0, 4)}…${signature.slice(-4)}` : signature;
  }

  trackRow(_: number, row: FeedRow): string {
    return row.key;
  }

  private endDrag(): void {
    this.dragEnd?.();
    this.dragEnd = null;
  }

  /**
   * Measuring reads the layout, so it happens once a frame at most and never
   * inside the change detection that put the window there.
   */
  private scheduleMeasure(): void {
    if (this.frame || typeof requestAnimationFrame !== 'function') {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.measure();
      this.cdr.markForCheck();
    });
  }

  private measure(): void {
    const node = this.node;
    if (!node) {
      this.thumb = null;
      return;
    }
    const room = node.scrollHeight - node.clientHeight;
    // Nothing to scroll: no bar either, so a short feed keeps its plain look.
    if (room < 8) {
      this.thumb = null;
      return;
    }
    const size = Math.max(10, Math.min(100, (node.clientHeight / node.scrollHeight) * 100));
    this.thumb = { size, at: (node.scrollTop / room) * (100 - size) };
  }
}

/** "2 min ago": on the pool page the feed uses relative time, that is how the pace shows. */
export function timeAgo(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

/** "21:47", local time: a finished round is read against the clock. */
export function clockTime(atMs: number): string {
  if (!Number.isFinite(atMs) || atMs <= 0) {
    return '';
  }
  return new Date(atMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
