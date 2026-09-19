import { AfterViewInit, Component, ElementRef, Input, NgZone, OnDestroy, ViewChild } from '@angular/core';
import gsap from 'gsap';

type Act = 'hop' | 'shine' | 'phone' | 'paper';

/** How long to wait between actions, ms: random within that range. */
const IDLE_MIN_MS = 5000;
const IDLE_MAX_MS = 7000;
const FIRST_ACT_MS = 2500;

/**
 * A mascot that comes alive. On hover it hops, which is how the mark in the
 * header behaves. With `idle` it also hops on its own now and then, catches a
 * glint on its glasses, pulls out a phone with a chart or reads a newspaper —
 * which is how the mascot by the title on the first screen behaves. The actions
 * are short, once every 5–7 seconds: the mascot has to read as alive, but the
 * marquee is right there and long scenes would compete with it for attention. The
 * same action never repeats twice in a row.
 *
 * It stays quiet when the tab is hidden, when the mascot has left the screen and
 * in reduced motion.
 */
@Component({
  selector: 'app-mascot-logo',
  standalone: true,
  templateUrl: './mascot-logo.component.html',
  styleUrls: ['./mascot-logo.component.scss']
})
export class MascotLogoComponent implements AfterViewInit, OnDestroy {
  /** The side in pixels. Without it the mascot fills its element and the page sets the size. */
  @Input() size: number | null = null;
  @Input() src = 'assets/images/pumpling-mascot.png';
  /** It comes alive on its own now and then, with no hover. */
  @Input() idle = false;

  @ViewChild('root') rootRef?: ElementRef<HTMLElement>;
  @ViewChild('body') bodyRef?: ElementRef<HTMLElement>;
  @ViewChild('shine') shineRef?: ElementRef<HTMLElement>;
  @ViewChild('phone') phoneRef?: ElementRef<SVGElement>;
  @ViewChild('paper') paperRef?: ElementRef<SVGElement>;

  private timerId = 0;
  private current?: gsap.core.Timeline;
  private lastAct: Act | null = null;
  private readonly reducedMotion = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly zone: NgZone) {}

  ngAfterViewInit(): void {
    if (this.reducedMotion || !this.idle) {
      return;
    }
    this.zone.runOutsideAngular(() => this.schedule(FIRST_ACT_MS));
  }

  ngOnDestroy(): void {
    window.clearTimeout(this.timerId);
    this.current?.kill();
  }

  /** Hover means an immediate hop, if nothing is playing. */
  onHover(): void {
    if (this.reducedMotion || this.current?.isActive()) {
      return;
    }
    this.zone.runOutsideAngular(() => this.play('hop'));
  }

  private schedule(delay: number): void {
    window.clearTimeout(this.timerId);
    this.timerId = window.setTimeout(() => {
      if (this.canAct()) {
        this.play(this.pickAct());
      }
      this.schedule(IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS));
    }, delay);
  }

  /** Do not play to an empty room: the tab is hidden or the header was taken up. */
  private canAct(): boolean {
    const root = this.rootRef?.nativeElement;
    if (!root || document.hidden || this.current?.isActive()) {
      return false;
    }
    const rect = root.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.width === 0) {
      return false;
    }
    for (let node: HTMLElement | null = root; node; node = node.parentElement) {
      if (+getComputedStyle(node).opacity < 0.5) {
        return false;
      }
    }
    return true;
  }

  private pickAct(): Act {
    const acts: Act[] = ['hop', 'shine', 'phone', 'paper'];
    const options = acts.filter((act) => act !== this.lastAct);
    return options[Math.floor(Math.random() * options.length)];
  }

  private play(act: Act): void {
    const body = this.bodyRef?.nativeElement;
    const shine = this.shineRef?.nativeElement;
    const phone = this.phoneRef?.nativeElement;
    const paper = this.paperRef?.nativeElement;
    if (!body || !shine || !phone || !paper) {
      return;
    }
    this.current?.kill();
    // The offsets are drawn for a 40px mascot and scale with it.
    const u = (this.rootRef?.nativeElement.offsetWidth || 40) / 40;
    // An interrupted action leaves the props and the tilt halfway — every new
    // one starts from a clean frame.
    gsap.set(body, { clearProps: 'transform' });
    gsap.set([phone, paper], { autoAlpha: 0 });
    gsap.set(shine, { backgroundPosition: '160% 0' });
    this.lastAct = act;
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
    this.current = tl;

    switch (act) {
      case 'hop':
        // A squash before the hop, a stretch in flight, a squash on landing.
        tl.to(body, { scaleY: 0.86, scaleX: 1.1, y: 1 * u, duration: 0.12, ease: 'power1.in' })
          .to(body, { scaleY: 1.08, scaleX: 0.94, y: -7 * u, duration: 0.2 })
          .to(body, { scaleY: 1, scaleX: 1, y: 0, duration: 0.18, ease: 'power2.in' })
          .to(body, { scaleY: 0.9, scaleX: 1.08, duration: 0.08 })
          .to(body, { scaleY: 1, scaleX: 1, duration: 0.24, ease: 'back.out(3)' });
        break;

      case 'shine':
        tl.fromTo(shine, { backgroundPosition: '160% 0' }, { backgroundPosition: '-60% 0', duration: 0.7, ease: 'power1.inOut' })
          .to(body, { rotation: -4, duration: 0.18 }, 0.1)
          .to(body, { rotation: 0, duration: 0.3, ease: 'back.out(2)' }, 0.45);
        break;

      case 'phone':
        // The phone slides out from the bottom right and the mascot glances at the screen.
        tl.fromTo(phone, { autoAlpha: 0, y: 14 * u, rotation: 24 }, { autoAlpha: 1, y: 0, rotation: 10, duration: 0.3, ease: 'back.out(1.8)' })
          .to(body, { rotation: 7, x: 1 * u, duration: 0.24 }, 0.12)
          .to(phone, { y: -1.5 * u, duration: 0.18, yoyo: true, repeat: 3, ease: 'sine.inOut' }, 0.5)
          .to(body, { rotation: 0, x: 0, duration: 0.28, ease: 'back.out(2)' }, 1.5)
          .to(phone, { autoAlpha: 0, y: 14 * u, rotation: 24, duration: 0.24, ease: 'power2.in' }, 1.55);
        break;

      case 'paper':
        // The newspaper rises in front of the mascot and it peers over the top.
        tl.fromTo(paper, { autoAlpha: 0, y: 16 * u, scaleX: 0.3 }, { autoAlpha: 1, y: 0, scaleX: 1, duration: 0.32, ease: 'back.out(1.6)' })
          .to(body, { y: 2 * u, duration: 0.2 }, 0.1)
          .to(paper, { rotation: -3, duration: 0.3, yoyo: true, repeat: 2, ease: 'sine.inOut' }, 0.45)
          .to(body, { y: 0, duration: 0.24, ease: 'back.out(2)' }, 1.55)
          .to(paper, { autoAlpha: 0, y: 16 * u, scaleX: 0.3, duration: 0.26, ease: 'power2.in' }, 1.55);
        break;
    }
  }
}
