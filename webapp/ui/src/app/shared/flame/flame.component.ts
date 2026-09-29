import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/**
 * The burn's mark: a black outline, a purple body, a white tongue. The same
 * drawing language as the mascot and the coins, and it still reads at 14px.
 *
 * `inverted` is for a black backing (an active card): the outline turns white
 * and the tongue black, so the shape stays a flame and not a blot.
 *
 * Decorative: it is always next to words that say the same thing, so it is
 * hidden from screen readers.
 */
@Component({
  selector: 'app-flame',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg class="flame" viewBox="0 0 24 24" [attr.width]="size" [attr.height]="size" aria-hidden="true" focusable="false">
      <path d="M12 1.8c.6 3.1 3 4.9 4.7 7.2 1.3 1.8 2 3.6 2 5.6A6.7 6.7 0 0 1 5.3 14.6c0-2.4 1.1-4.3 2.6-5.8.2 1.5.9 2.6 1.9 3.2-.4-3.9 1-7.5 2.2-10.2z"
            [attr.fill]="'var(--qres-purple, #AF8FFF)'" [attr.stroke]="inverted ? 'var(--qres-white, #FCFCFC)' : 'var(--qres-black, #020202)'"
            stroke-width="1.6" stroke-linejoin="round" />
      <path d="M12.2 11.4c.3 1.4 1.4 2.2 2.1 3.2.5.7.8 1.4.8 2.2a3.1 3.1 0 0 1-6.2 0c0-1.1.5-2 1.2-2.6.1.6.4 1.1.9 1.4-.2-1.6.4-3.1 1.2-4.2z"
            [attr.fill]="inverted ? 'var(--qres-black, #020202)' : 'var(--qres-white, #FCFCFC)'"
            [attr.stroke]="inverted ? 'var(--qres-white, #FCFCFC)' : 'var(--qres-black, #020202)'"
            stroke-width="1.3" stroke-linejoin="round" />
    </svg>
  `,
  styles: [`
    :host { display: inline-flex; flex: none; line-height: 0; vertical-align: -0.15em; }
    .flame { display: block; overflow: visible; }
  `]
})
export class FlameComponent {
  @Input() size = 14;
  @Input() inverted = false;
}
