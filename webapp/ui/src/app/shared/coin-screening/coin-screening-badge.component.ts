import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { InfoPopoverComponent } from '../info-popover/info-popover.component';
import {
  CoinScreening,
  SCREENING_TITLE,
  ScreeningRow,
  badgeLabel,
  cardLabel,
  checkedLine,
  flagsLabel,
  screeningRows,
  sourceOf
} from './coin-screening';

/**
 * The coin check after a ticker: a magnifier, the same on every coin checked,
 * and the card with what the check read. How the card opens, where it goes and
 * how it closes is `InfoPopoverComponent`'s.
 */
@Component({
  selector: 'app-coin-screening-badge',
  standalone: true,
  imports: [InfoPopoverComponent],
  templateUrl: './coin-screening-badge.component.html',
  styleUrl: './coin-screening-badge.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CoinScreeningBadgeComponent {
  @Input({ required: true }) screening!: CoinScreening;
  @Input() ticker = '';
  /** Whether the card is up: the pool row hides its price card meanwhile. */
  @Output() openChange = new EventEmitter<boolean>();

  readonly title = SCREENING_TITLE;
  nowMs = Date.now();

  private readonly cdr = inject(ChangeDetectorRef);

  get label(): string {
    return badgeLabel(this.ticker);
  }

  get cardLabel(): string {
    return cardLabel(this.ticker);
  }

  get flags(): string | null {
    return flagsLabel(this.screening);
  }

  get rows(): ScreeningRow[] {
    return screeningRows(this.screening);
  }

  get checked(): string {
    return checkedLine(this.screening, this.nowMs);
  }

  get checkedIso(): string {
    return new Date(this.screening.checkedAtMs).toISOString();
  }

  get checkedExact(): string {
    return new Date(this.screening.checkedAtMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  get source(): { label: string; href: string | null } {
    return sourceOf(this.screening);
  }

  onOpenChange(open: boolean): void {
    if (open) {
      this.nowMs = Date.now();
      this.cdr.markForCheck();
    }
    this.openChange.emit(open);
  }
}
