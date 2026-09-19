import { ChangeDetectionStrategy, Component } from '@angular/core';

interface DexToken {
  readonly src: string;
  readonly x: number;
  readonly y: number;
  readonly tiltDeg: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly scale: number;
  readonly enterDelayMs: number;
  readonly durationMs: number;
}

@Component({
  selector: 'app-dex-card-animation',
  templateUrl: './dex-card-animation.component.html',
  styleUrls: ['./dex-card-animation.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class DexCardAnimationComponent {
  readonly tokens: DexToken[] = [
    {
      src: '/assets/design-preview/dogeupd.svg',
      x: 16.1,
      y: 15.8,
      tiltDeg: -13,
      driftX: 10,
      driftY: -12,
      scale: 0.98,
      enterDelayMs: 60,
      durationMs: 3000
    },
    {
      src: '/assets/design-preview/pepeupd.svg',
      // Moved into the corner: the card became shorter than the window, and at
      // the old 79.1/18.6 the coin touched the word "hype" at the extreme of its
      // wobble on 1366×768.
      x: 83,
      y: 14,
      tiltDeg: 11,
      driftX: -12,
      driftY: 12,
      scale: 1.12,
      enterDelayMs: 140,
      durationMs: 3180
    },
    {
      src: '/assets/design-preview/fartupd.svg',
      x: 83.3,
      // Lowered under the "Enter the hype" line: at the old 58.5 the coin covered
      // the word "hype". It comes closest to the timer line at 390px and 1024×768,
      // about 17–20px at the extreme of the wobble.
      y: 75,
      tiltDeg: -8,
      driftX: 8,
      driftY: -10,
      scale: 1.03,
      enterDelayMs: 220,
      durationMs: 3340
    },
    {
      src: '/assets/design-preview/spxupd.svg',
      x: 57.3,
      y: 81.4,
      tiltDeg: 14,
      driftX: -10,
      driftY: 10,
      scale: 0.98,
      enterDelayMs: 300,
      durationMs: 3500
    },
    {
      src: '/assets/design-preview/flokiupd.svg',
      // At the old 19.3/65.5 the coin ran into the timer line at 1024×768 and on
      // a phone. Here the gap is no less than 17px at every size.
      x: 17,
      y: 72,
      tiltDeg: 7,
      driftX: 9,
      driftY: 11,
      scale: 1.08,
      enterDelayMs: 380,
      durationMs: 3660
    }
  ];
}
