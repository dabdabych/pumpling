import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { Store } from '@ngrx/store';
import { JwtHelperService } from '@auth0/angular-jwt';
import { interval, Subscription } from 'rxjs';
import gsap from 'gsap';

import { AuthDialogService } from '../../auth/auth-dialog.service';
import { WalletService } from '../../shared/wallet.service';
import { holdSplash, isSplashActive, onSplashExit, releaseSplash } from '../../shared/splash';
import { signOut } from '../../store/actions/auth';
import { authSelector } from '../../store/selectors/auth';
import { IAppState } from '../../store/state/app.state';
import { WALLET_LINKED_ADDRESS_STORAGE_KEY } from '../../shared/wallet-link';

type HeadlinePhase = 'decoding' | 'hold' | 'encoding' | 'bridge';

/**
 * The header phrases are the ones from the main page in dev. A line is
 * "decrypted" out of hexadecimal noise, holds, is "encrypted" back and moves on
 * to the next.
 */
const HEADLINE_PHRASES = [
  'Get your coin noticed',
  'No followers needed',
  'A buy nobody can cancel',
  'Hype you can verify'
] as const;

const HASH_CHARS = '0123456789abcdef';
/**
 * The step is half as long and there are twice as many as on the main page: the
 * total duration is the same, but the line changes in small portions and reads
 * smoothly, without jerking.
 */
const HASH_STEP_DELAY = 48;
const HASH_HOLD_DELAY = 1500;
const HASH_TRANSITION_STEPS = 32;
const HASH_BRIDGE_STEPS = 20;
const HASH_HOLD_TICKS = Math.round(HASH_HOLD_DELAY / HASH_STEP_DELAY);


/**
 * The placeholder until launch: a marquee, the mascot, a title and a shared chat.
 *
 * Sign-in and sign-up come as a dialog over the page (AuthDialogService), by the
 * same flow as on the main page: nobody has to leave the page to sign in. The
 * /sign-in and /sign-up pages show the same flow for direct links.
 */
@Component({
  selector: 'app-coming-soon',
  templateUrl: './coming-soon.component.html',
  styleUrls: ['./coming-soon.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false
})
export class ComingSoonComponent implements OnInit, AfterViewInit, OnDestroy {
  headlineText = '';
  headlinePhase: HeadlinePhase = 'decoding';

  /**
   * The longest phrase. Drawn invisible to reserve the width: otherwise a
   * centred line twitches left and right on every character change.
   */
  readonly widestPhrase = HEADLINE_PHRASES.reduce(
    (longest, phrase) => (phrase.length > longest.length ? phrase : longest),
    ''
  );

  isAuthenticated = false;
  walletBusy = false;

  /** Signed in with a wallet: on sign-out it also has to be disconnected. */
  private walletLinked = false;
  private headlinePhraseIndex = 0;
  private headlineStep = 0;
  private headlineHoldTicks = 0;
  private headlineAnimation: Subscription | null = null;
  private authSubscription: Subscription | null = null;
  /** The page holds the splash until the mascot marks are ready. */
  private holdingSplash = false;
  private splashExitCleanup?: () => void;

  constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private walletService: WalletService,
    private store: Store<IAppState>,
    private jwtHelper: JwtHelperService,
    private authDialog: AuthDialogService,
    private host: ElementRef<HTMLElement>,
    private zone: NgZone
  ) {
    if (isSplashActive()) {
      holdSplash();
      this.holdingSplash = true;
    }
  }

  ngOnInit(): void {
    this.headlineText = this.buildHashTransition(HEADLINE_PHRASES[this.headlinePhraseIndex], 0, false);
    this.headlineAnimation = interval(HASH_STEP_DELAY).subscribe(() => this.advanceHeadline());

    this.authSubscription = this.store.select(authSelector).subscribe((isAuthenticated) => {
      this.isAuthenticated = isAuthenticated && this.hasValidAuthToken();
      // the token may have gone stale while the tab was closed — then we clear the session
      if (isAuthenticated && !this.isAuthenticated) {
        this.clearAuthSession();
        this.store.dispatch(signOut());
      }
      this.changeDetectorRef.markForCheck();
    });

    void this.restoreWalletSession();
  }

  ngAfterViewInit(): void {
    if (!this.holdingSplash) {
      return;
    }
    this.splashExitCleanup = onSplashExit(() => this.zone.runOutsideAngular(() => this.playEntrance()));
    void this.releaseSplashWhenReady();
  }

  ngOnDestroy(): void {
    this.headlineAnimation?.unsubscribe();
    this.authSubscription?.unsubscribe();
    // We left the page before it released the splash — release it ourselves.
    this.releaseHeldSplash();
    this.splashExitCleanup?.();
  }

  openSignIn(): void {
    this.authDialog.open({ mode: 'sign-in' });
  }

  async signOut(): Promise<void> {
    this.walletBusy = true;
    this.changeDetectorRef.markForCheck();
    try {
      if (this.walletLinked) {
        await this.walletService.disconnect().catch(() => undefined);
      }
    } finally {
      this.clearAuthSession();
      this.store.dispatch(signOut());
      this.walletLinked = false;
      this.walletBusy = false;
      this.changeDetectorRef.markForCheck();
    }
  }

  /**
   * Releases the splash once the mascot marks are decoded: otherwise you would
   * see them appear from under the departing splash. We wait no longer than a
   * second and a half — a slow network must not hold the page.
   */
  private async releaseSplashWhenReady(): Promise<void> {
    const images = Array.from(this.host.nativeElement.querySelectorAll<HTMLImageElement>('app-mascot-logo img'));
    await Promise.race([
      Promise.all(images.map((image) => image.decode().catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
    this.releaseHeldSplash();
  }

  private releaseHeldSplash(): void {
    if (this.holdingSplash) {
      this.holdingSplash = false;
      releaseSplash();
    }
  }

  /**
   * The page comes through while the splash mark flies into the header: the
   * mascot, the title with its subtitle, then the chat. Like the main page's first screen.
   */
  private playEntrance(): void {
    const root = this.host.nativeElement;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const mascot = root.querySelector('.soon-mascot');
    const text = Array.from(root.querySelectorAll('.soon-copy > *'));
    const chat = root.querySelector('.soon-chat');
    const clearProps = 'opacity,visibility,transform';
    const entrance = gsap.timeline({ defaults: { ease: 'power3.out' } });
    if (mascot) {
      entrance.from(mascot, { autoAlpha: 0, scale: 0.8, duration: 0.55, ease: 'back.out(1.8)', clearProps }, 0.12);
    }
    if (text.length) {
      entrance.from(text, { autoAlpha: 0, y: 20, duration: 0.6, stagger: 0.08, clearProps }, 0.16);
    }
    if (chat) {
      entrance.from(chat, { autoAlpha: 0, y: 26, duration: 0.65, clearProps }, 0.28);
    }
  }

  /** The sign-in may have happened on /sign-in — we find out whether it used a wallet. */
  private async restoreWalletSession(): Promise<void> {
    const linked = localStorage.getItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
    if (!linked || !this.hasValidAuthToken()) {
      return;
    }
    const connected = await this.walletService.checkConnection().catch(() => null);
    this.walletLinked = connected === linked;
  }

  private hasValidAuthToken(): boolean {
    const token = localStorage.getItem('jwt');
    return !!token && !this.jwtHelper.isTokenExpired(token);
  }

  private clearAuthSession(): void {
    localStorage.removeItem('jwt');
    localStorage.removeItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
  }

  // ------------------------------------------------------- the running title

  private advanceHeadline(): void {
    const phrase = HEADLINE_PHRASES[this.headlinePhraseIndex];

    if (this.headlinePhase === 'decoding') {
      this.headlineStep += 1;

      if (this.headlineStep >= HASH_TRANSITION_STEPS) {
        this.headlineText = phrase;
        this.headlinePhase = 'hold';
        this.headlineHoldTicks = 0;
      } else {
        this.headlineText = this.buildHashTransition(phrase, this.headlineStep, false);
      }

      this.changeDetectorRef.markForCheck();
      return;
    }

    if (this.headlinePhase === 'hold') {
      this.headlineHoldTicks += 1;

      if (this.headlineHoldTicks >= HASH_HOLD_TICKS) {
        this.headlinePhase = 'encoding';
        this.headlineStep = 0;
        this.headlineHoldTicks = 0;
      }

      this.headlineText = phrase;
      this.changeDetectorRef.markForCheck();
      return;
    }

    if (this.headlinePhase === 'bridge') {
      const nextPhraseIndex = (this.headlinePhraseIndex + 1) % HEADLINE_PHRASES.length;
      const nextPhrase = HEADLINE_PHRASES[nextPhraseIndex];
      this.headlineStep += 1;

      if (this.headlineStep >= HASH_BRIDGE_STEPS) {
        this.headlinePhraseIndex = nextPhraseIndex;
        this.headlinePhase = 'decoding';
        this.headlineStep = 0;
        this.headlineText = this.buildHashTransition(nextPhrase, 0, false);
      } else {
        this.headlineText = this.buildHashBridge(phrase, nextPhrase, this.headlineStep);
      }

      this.changeDetectorRef.markForCheck();
      return;
    }

    this.headlineStep += 1;

    if (this.headlineStep >= HASH_TRANSITION_STEPS) {
      const nextPhraseIndex = (this.headlinePhraseIndex + 1) % HEADLINE_PHRASES.length;

      // The first frame of the transition straight away: otherwise a fully
      // encrypted phrase froze for one step.
      this.headlinePhase = 'bridge';
      this.headlineStep = 0;
      this.headlineText = this.buildHashBridge(phrase, HEADLINE_PHRASES[nextPhraseIndex], 0);
      this.changeDetectorRef.markForCheck();
      return;
    }

    this.headlineText = this.buildHashTransition(phrase, this.headlineStep, true);
    this.changeDetectorRef.markForCheck();
  }

  private buildHashTransition(phrase: string, step: number, encoding: boolean): string {
    const visibleCount = Math.round((phrase.length * step) / HASH_TRANSITION_STEPS);
    const pivot = encoding ? phrase.length - visibleCount : visibleCount;

    return phrase
      .split('')
      .map((char, index) => (char === ' ' ? ' ' : index < pivot ? char : this.randomHashChar()))
      .join('');
  }

  private buildHashBridge(fromPhrase: string, toPhrase: string, step: number): string {
    const ratio = step / HASH_BRIDGE_STEPS;
    const easedRatio = 1 - Math.pow(1 - ratio, 2);
    const nextLength = Math.round(fromPhrase.length + (toPhrase.length - fromPhrase.length) * easedRatio);
    const spacingTemplate = easedRatio < 0.5 ? fromPhrase : toPhrase;

    return Array.from({ length: nextLength }, (_, index) =>
      spacingTemplate[index] === ' ' ? ' ' : this.randomHashChar()
    ).join('');
  }

  private randomHashChar(): string {
    return HASH_CHARS[Math.floor(Math.random() * HASH_CHARS.length)];
  }
}
