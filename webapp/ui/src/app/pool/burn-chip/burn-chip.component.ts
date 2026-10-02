import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FlameComponent } from '../../shared/flame/flame.component';
import { InfoPopoverComponent } from '../../shared/info-popover/info-popover.component';
import { BurnCard, burnCard, burnChipLabel, burnChipText } from '../burn';

/**
 * "50% BURN" on a coin, and the card that says what it means: on a pool's row,
 * the coin's burn so far; on my page (`mine`), the burn I asked for. Opens like
 * the coin check, by `InfoPopoverComponent`.
 */
@Component({
  selector: 'app-burn-chip',
  standalone: true,
  imports: [FlameComponent, InfoPopoverComponent],
  templateUrl: './burn-chip.component.html',
  styleUrl: './burn-chip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BurnChipComponent {
  /** Basis points, SOL-weighted over the commits it stands for. */
  @Input({ required: true }) bps = 0;
  @Input() ticker = '';
  /** The chip is my own choice, on my page. */
  @Input() mine = false;
  /** The pool still takes commits: the coin's burn can still move. */
  @Input() live = false;
  @Output() openChange = new EventEmitter<boolean>();

  get chip(): string | null {
    return burnChipText(this.bps);
  }

  get label(): string {
    return burnChipLabel(this.bps) ?? '';
  }

  get card(): BurnCard | null {
    return burnCard(this.bps, this.ticker, { mine: this.mine, live: this.live });
  }
}
