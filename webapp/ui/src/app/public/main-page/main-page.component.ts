import { animate, style, transition, trigger } from '@angular/animations';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Inject, NgZone, OnDestroy, OnInit, QueryList, ViewChild, ViewChildren } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Store } from '@ngrx/store';
import { combineLatest, interval, Observable, Subscription, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { WalletService } from '../../shared/wallet.service';
import { environment } from '../../../environments/environment';
import { signIn, signOut } from '../../store/actions/auth';
import { IAppState } from '../../store/state/app.state';
import { authSelector } from '../../store/selectors/auth';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { AuthDialogService } from '../../auth/auth-dialog.service';
import { StoryScrollEngine } from './story-scroll-engine';
import { bindQuickStartPointer } from './quick-start-pointer';
import { holdSplash, isSplashActive, onSplashExit, releaseSplash } from '../../shared/splash';
import { PoolService } from '../../pool/pool.service';
import { PoolPhase } from '../../pool/pool-state';
import { poolCardLine } from '../../pool/pool-view';
import { SignOutConfirm, SystemDialog } from '../../shared/system-dialog';
import { JwtHelperService } from '@auth0/angular-jwt';
import { WALLET_LINKED_ADDRESS_STORAGE_KEY } from '../../shared/wallet-link';

type GuideModal = 'quick-start' | 'how-it-works' | 'faq' | 'vision' | 'terms' | 'privacy-policy' | null;
type HeadlinePhase = 'decoding' | 'hold' | 'encoding' | 'bridge';
type NavSection = 'guides' | 'vision' | 'archives';

// Short phrases about what the product gives you. No betting, no gambling:
// "predict" and "pump it" read as a casino and as a pump and dump.
const HEADLINE_PHRASES = [
  'Get your coin noticed',
  'No followers needed',
  'A buy nobody can cancel',
  'Hype you can verify'
] as const;

const HASH_CHARS = '0123456789abcdef';
/**
 * The step is half as long and there are twice as many: the total duration is
 * the same, but the line changes in small portions and reads smoothly, without
 * jerking. The values are kept in sync with the `ComingSoonComponent`
 * placeholder — it is the same line in the header.
 */
const HASH_STEP_DELAY = 48;
const HASH_HOLD_DELAY = 1500;
const HASH_TRANSITION_STEPS = 32;
const HASH_BRIDGE_STEPS = 20;
const HASH_HOLD_TICKS = Math.round(HASH_HOLD_DELAY / HASH_STEP_DELAY);
/** How long a story step from one stop to the next takes. */
const STORY_STEP_DURATION_S = 0.7;

// ===================== qres scroll-story data (designer redesign) =====================
const QRES_TRUTH_LINE = [
  'any Solana memecoin',
  'a new pool every 3 hours',
  'one hour of public buys',
  'every buy on-chain',
  '3% fee'
];


/** Where the sections sit when the story is laid out as an ordinary page. */
const STORY_SECTION_SELECTORS: ReadonlyArray<[string, string]> = [
  ['hero', '#qres-hero'],
  ['what', '[aria-label="what is it?"]'],
  ['how', '[aria-label="how it works"]'],
  ['quick', '[aria-label="quick start"]']
];

const QRES_COIN_PALETTE = [
  { fill: '#FFD36A', stroke: '#F4A900' },
  { fill: '#8FFFAF', stroke: '#2DD96F' },
  { fill: '#FFB25F', stroke: '#FF7A1A' },
  { fill: '#7DE7FF', stroke: '#25BDE5' },
  { fill: '#FF9AD5', stroke: '#F05CAB' },
  { fill: '#AF8FFF', stroke: '#7F5BFF' }
];


const QRES_COIN_MARKS: string[] = [
  '<path d="M20 36c5 7 18 7 24 0" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="25" r="3.5" fill="var(--qres-black)"/><circle cx="40" cy="25" r="3.5" fill="var(--qres-black)"/>',
  '<path d="M19 22h26M19 32h20M19 42h26" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><circle cx="48" cy="32" r="4" fill="var(--qres-black)"/>',
  '<path d="M32 16v32M21 24h17a9 9 0 0 1 0 18H21" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/>',
  '<path d="M18 40 31 18l15 28" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 36h16" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/>',
  '<path d="M17 34c6-15 23-17 30-4" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><path d="M21 43c6 5 18 5 24-2" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/>',
  '<circle cx="25" cy="27" r="5" fill="none" stroke="var(--qres-black)" stroke-width="4"/><circle cx="40" cy="37" r="5" fill="none" stroke="var(--qres-black)" stroke-width="4"/><path d="M21 45 45 19" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/>',
  '<path d="M17 32h30" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><path d="M32 17v30" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="32" r="7" fill="var(--qres-white)" stroke="var(--qres-black)" stroke-width="3"/>',
  '<path d="M20 44c4-18 20-18 24 0" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><path d="M23 23c6-5 12-5 18 0" fill="none" stroke="var(--qres-black)" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="33" r="4" fill="var(--qres-black)"/>'
];
function quickCoinMarkSvg(variant: number): string {
  const mark = QRES_COIN_MARKS[variant % 8] ?? '';
  return (
    '<svg viewBox="0 0 64 64" class="h-full w-full">' +
    '<circle cx="32" cy="32" r="29" fill="var(--qres-coin-fill)" stroke="var(--qres-coin-border)" stroke-width="4"/>' +
    '<circle cx="32" cy="32" r="22" fill="none" stroke="var(--qres-black)" stroke-width="2.5" opacity="0.28"/>' +
    mark +
    '</svg>'
  );
}

@Component({
  selector: 'app-main-page',
  templateUrl: './main-page.component.html',
  styleUrls: ['./main-page.component.scss'],
  standalone: false,
  // The pool moves to the next phase by itself, and the caption on the card
  // changes with nobody touching it. It fades back in so the change is visible
  // without twitching: the animation is tied to the phase, not to ticking seconds.
  animations: [
    trigger('lineSwap', [
      transition('void => *', []),
      transition('* => *', [
        style({ opacity: 0 }),
        animate('320ms ease', style({ opacity: 1 }))
      ])
    ])
  ]
})
export class MainPageComponent implements OnInit, AfterViewInit, OnDestroy {
  // --- qres scroll-story refs (designer redesign, phase 2) ---
  @ViewChild('root') rootRef!: ElementRef<HTMLElement>;
  @ViewChild('hero') heroRef!: ElementRef<HTMLElement>;
  @ViewChild('firstCard') firstCardRef!: ElementRef<HTMLElement>;
  @ViewChild('secondCard') secondCardRef!: ElementRef<HTMLElement>;
  @ViewChild('nextScreen') nextScreenRef!: ElementRef<HTMLElement>;
  @ViewChild('scrollCue') scrollCueRef!: ElementRef<HTMLElement>;
  @ViewChild('heroHeadline') heroHeadlineRef!: ElementRef<HTMLElement>;
  @ViewChild('sectionHeader') sectionHeaderRef!: ElementRef<HTMLElement>;
  @ViewChild('sectionDot') sectionDotRef!: ElementRef<HTMLElement>;
  @ViewChild('sectionTitle') sectionTitleRef!: ElementRef<HTMLElement>;
  @ViewChild('sectionLine') sectionLineRef!: ElementRef<HTMLElement>;
  @ViewChild('sectionCopy') sectionCopyRef!: ElementRef<HTMLElement>;
  @ViewChild('siteHeader') siteHeaderRef?: ElementRef<HTMLElement>;
  @ViewChild('navTrack') navTrackRef?: ElementRef<HTMLElement>;
  @ViewChild('navMarker') navMarkerRef?: ElementRef<HTMLElement>;
  @ViewChildren('navItem') navItemRefs?: QueryList<ElementRef<HTMLElement>>;

  private gsapContext?: gsap.Context;
  private storyMedia?: gsap.MatchMedia;
  private storyTimeline?: gsap.core.Timeline;

  /** The Solana program address for the footer. Empty means a dash there. */
  readonly programId: string = '';
  /** The cluster in a Solscan link: without it a stand opens mainnet. */
  readonly explorerQuery = environment.solanaExplorerQuery;
  /** The repository for the footer, a full URL. Empty means a dash there. */
  readonly githubUrl: string = '';

  /** Which story section is on screen — it is highlighted in the menu. */
  activeSection = 'hero';

  /**
   * Where the current menu transition leads. While it runs, `activeSection`
   * passes through intermediate timeline labels, and a "you are here" mark
   * would stumble on every one. So the menu looks straight at the target.
   */
  navTargetLabel: string | null = null;

  /** Measurements of the menu items against the line under them, by section label. */
  private navItemBoxes: Record<string, { x: number; width: number }> = {};

  /** The mark moves smoothly. Off until the first layout and while it recalculates. */
  navMarkerAnimated = false;

  private navResizeObserver?: ResizeObserver;
  private headerResizeObserver?: ResizeObserver;
  private navMarkerFrame = 0;
  private sectionScrollTrackingCleanup?: () => void;
  private storyScrollEngine?: StoryScrollEngine;


  /** A programmatic transition from a button is running. */
  private navigatingToSection = false;

  /** Where exactly the current transition leads — snapping pulls only here for that time. */
  private navTargetProgress = 0;

  /** Reduced motion is on: the story is unrolled as an ordinary page. */
  reducedMotionLayout = false;

  /** The proxy we tween the scroll position through. */
  private readonly sectionScrollProxy = { top: 0 };

  /** The deferred lowering of the flag after a transition. */
  private sectionNavRelease?: gsap.core.Tween;

  /** The current transition between sections, so a new click can interrupt it. */
  private storyTransition?: gsap.core.Timeline;

  /** The header is hidden: driven explicitly from the transition, not from the section change. */
  headerHidden = false;

  /**
   * The sections for the menu strip. The labels are the ones from the story
   * timeline. The five "how it works" scenes are not separate items — to a
   * person that is one section.
   */
  readonly storySections: ReadonlyArray<{
    label: string;
    title: string;
    /** Where to start showing from, when arriving from the hero screen. */
    enterAt: number;
    /** Where to start when arriving from another section. For "What is it" this
     *  matters: its `enterAt` is zero, which is the hero screen, so a transition
     *  from "How it works" would show the main screen as an intermediate step.
     *  By 0.55 the cards are already gone (they fade over 0.32…0.52) and the
     *  panel is still being drawn. */
    enterFromStory?: number;
  }> = [
    // enterAt is the moment on the timeline where a section starts APPEARING:
    // the previous one has gone and the new one is coming through. A menu
    // transition puts the playhead here and the entrance plays itself out. Every
    // transition is checked by the frame matrix: no stray section may flash.
    // 'what' from the start is the whole scroll; from other sections it is after
    // the cards have parted (they fade over 0.32…0.52).
    { label: 'what', title: 'What is it?', enterAt: 0, enterFromStory: 0.55 },
    // 'how': What is it fades by 3.88, How it works comes through from 3.7.
    { label: 'how', title: 'How it works', enterAt: 3.9 },
    // 'quick': How it works fades by 9.42 (phase 5 leaves at 9.1).
    { label: 'quick', title: 'Quick start', enterAt: 9.46 }
  ];
  private solCommitCleanups: Array<() => void> = [];
  /** The main page holds the splash until the story is built and the first screen's images are ready. */
  private holdingSplash = false;
  private splashExitCleanup?: () => void;


  marqueeItems: string[] = [];
  /**
   * The line on the "Commit SOL" card: the pool phase and the timer. Empty
   * until the first answer. The phase itself travels alongside: the line fades
   * back in when the pool moves to the next phase, and does not blink every second.
   */
  readonly poolCard$: Observable<{ line: string; phase: PoolPhase }>;
  quickCoins: Array<{ ngStyle: Record<string, string>; svg: SafeHtml }> = [];

  /** The How it works phase currently on screen: the scene comes alive by it. */
  howStep: number | null = null;

  activeGuide: GuideModal = null;
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

  mobileMenuOpen = false;
  walletAddress: string | null = null;
  walletBusy = false;
  walletLinked = false;
  isAuthenticated = false;
  expandedSections: Record<NavSection, boolean> = {
    guides: false,
    vision: false,
    archives: false
  };
  private lockedScrollY = 0;
  private headlinePhraseIndex = 0;
  private headlineStep = 0;
  private headlineHoldTicks = 0;
  private headlineAnimation: Subscription | null = null;
  private authSubscription: Subscription | null = null;

  constructor(
    @Inject(DOCUMENT) private document: Document,
    private changeDetectorRef: ChangeDetectorRef,
    private walletService: WalletService,
    private store: Store<IAppState>,
    private router: Router,
    private systemDialog: SystemDialog,
    private dialog: MatDialog,
    private jwtHelper: JwtHelperService,
    private sanitizer: DomSanitizer,
    private authDialog: AuthDialogService,
    private zone: NgZone,
    private pool: PoolService
  ) {
    this.poolCard$ = combineLatest([this.pool.snapshot$('dex'), timer(0, 1000)]).pipe(
      map(([snapshot]) => ({ line: poolCardLine(snapshot, Date.now()), phase: snapshot.phase }))
    );
    if (isSplashActive()) {
      holdSplash();
      this.holdingSplash = true;
    }
    this.marqueeItems = Array.from({ length: 8 }, () => QRES_TRUTH_LINE).flat();
    this.quickCoins = Array.from({ length: 96 }, (_, i) => {
      const color = QRES_COIN_PALETTE[i % QRES_COIN_PALETTE.length];
      return {
        ngStyle: {
          '--qres-coin-left': `${4 + ((i * 47) % 92)}%`,
          '--qres-coin-delay': `${(((i * 29) % 137) * 0.034).toFixed(2)}s`,
          '--qres-coin-duration': `${(4.8 + (i % 5) * 0.42).toFixed(2)}s`,
          '--qres-coin-size': `${(5.8 + (i % 6) * 1.04).toFixed(2)}rem`,
          '--qres-coin-fill': color.fill,
          '--qres-coin-border': color.stroke,
          '--qres-coin-spin': i % 2 === 0 ? '1turn' : '-1turn'
        },
        svg: this.sanitizer.bypassSecurityTrustHtml(quickCoinMarkSvg(i % 8))
      };
    });
  }

  ngOnInit(): void {
    this.headlineText = this.buildHashTransition(HEADLINE_PHRASES[this.headlinePhraseIndex], 0, false);
    this.headlineAnimation = interval(HASH_STEP_DELAY).subscribe(() => this.advanceHeadline());
    this.syncAuthSessionState();
    this.authSubscription = this.store.select(authSelector).subscribe((isAuthenticated) => {
      this.isAuthenticated = isAuthenticated && this.hasValidAuthToken();
      if (isAuthenticated && !this.isAuthenticated) {
        this.clearAuthSession();
        this.store.dispatch(signOut());
      }
      this.changeDetectorRef.markForCheck();
    });
    this.restoreWalletSession();
  }

  async handleBrandPillClick(event: MouseEvent): Promise<void> {
    event.preventDefault();
    this.closeMobileMenu();
    await this.router.navigateByUrl('/');
  }

  /** The section the menu shows as current. */
  get currentNavSection(): string {
    return this.navTargetLabel ?? this.activeSection;
  }

  get navMarkerBox(): { x: number; width: number } {
    return this.navItemBoxes[this.currentNavSection] ?? { x: 0, width: 0 };
  }

  /**
   * Watches the size of the line and the menu items and moves the mark.
   *
   * A ResizeObserver rather than window `resize`: it also catches the font
   * loading (the items change width, the window does not) and the crossing of
   * md, where the menu goes from `display: none` to visible. The first call
   * arrives right after subscribing, and that is the first layout.
   */
  private observeNavLayout(): void {
    const track = this.navTrackRef?.nativeElement;
    if (!track || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.navResizeObserver = new ResizeObserver(() => this.relayoutNavMarker());
    this.navResizeObserver.observe(track);
    this.navItemRefs?.forEach((item) => this.navResizeObserver?.observe(item.nativeElement));
  }

  /**
   * Measuring without animation: on a recalculation the mark has to stay put
   * rather than travel to its new position.
   */
  private relayoutNavMarker(): void {
    const track = this.navTrackRef?.nativeElement;
    const marker = this.navMarkerRef?.nativeElement;
    if (!track || !marker) {
      return;
    }
    const origin = track.getBoundingClientRect().left;
    const boxes: Record<string, { x: number; width: number }> = {};
    this.navItemRefs?.forEach(({ nativeElement: item }) => {
      const label = item.dataset['navLabel'];
      const rect = item.getBoundingClientRect();
      if (label && rect.width) {
        boxes[label] = { x: rect.left - origin, width: rect.width };
      }
    });
    this.navItemBoxes = boxes;
    this.navMarkerAnimated = false;
    this.changeDetectorRef.detectChanges();
    // Without forcing a style recalculation the browser would see the new
    // position together with the returned transition and play the journey anyway.
    void marker.offsetWidth;
    cancelAnimationFrame(this.navMarkerFrame);
    this.navMarkerFrame = requestAnimationFrame(() => {
      this.navMarkerAnimated = true;
      this.changeDetectorRef.detectChanges();
    });
  }

  /**
   * The header height goes into `--qres-header-h`: the first screen's height is
   * computed from it. The header changes with the window height, so the number
   * is not hardcoded. The first value is set immediately, before the story is
   * built — pinning measures the screen at the moment it is created.
   */
  private observeHeaderHeight(): void {
    const header = this.siteHeaderRef?.nativeElement;
    const root = this.rootRef?.nativeElement;
    if (!header || !root) {
      return;
    }
    let height = Math.round(header.getBoundingClientRect().height);
    root.style.setProperty('--qres-header-h', `${height}px`);
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    this.headerResizeObserver = new ResizeObserver(() => {
      const next = Math.round(header.getBoundingClientRect().height);
      if (next === height) {
        return;
      }
      height = next;
      root.style.setProperty('--qres-header-h', `${height}px`);
      ScrollTrigger.refresh();
    });
    this.headerResizeObserver.observe(header);
  }

  // ===================== qres scroll story (GSAP) =====================
  ngAfterViewInit(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.observeHeaderHeight();
    this.observeNavLayout();
    gsap.registerPlugin(ScrollTrigger);
    if (this.holdingSplash) {
      this.splashExitCleanup = onSplashExit(() => this.zone.runOutsideAngular(() => this.playHeroEntrance()));
    }
    // Let the child token-animation components paint first, then measure.
    requestAnimationFrame(() => {
      this.buildScrollStory();
      ScrollTrigger.refresh();
      this.openSectionFromFragment();
      void this.releaseSplashWhenHeroReady();
    });
  }

  /**
   * /#what, /#how, /#quick — from the pool page they lead straight to a story
   * section. A jump, not a scroll: during loading it hides behind the splash.
   */
  private openSectionFromFragment(): void {
    const fragment = this.router.parseUrl(this.router.url).fragment;
    if (fragment && STORY_SECTION_SELECTORS.some(([name]) => name === fragment && name !== 'hero')) {
      this.jumpToSection(fragment);
    }
  }

  /**
   * Put the story on the right section at once, without playing what comes
   * before it. `goToSection` shows the transition, which is right for the menu
   * but not for someone who arrived through a "How it works" link from the pool
   * page: they asked for a section, not for a tour past the previous ones.
   */
  private jumpToSection(label: string): void {
    void this.jumpWhenStoryIsSteady(label);
  }

  /**
   * The jump to a section happens once, when the layout has stopped moving.
   *
   * The story is built while images are still loading and the pinning is being
   * computed, and ScrollTrigger's bounds at that moment are temporary. A jump by
   * them landed in the neighbouring section, and the next recalculation took the
   * page further still. So we wait until the bounds match twice in a row and
   * only then jump.
   */
  private async jumpWhenStoryIsSteady(label: string): Promise<void> {
    // Images first. On an in-app navigation there is no splash, and the layout
    // keeps growing underfoot: every image that arrives changes the height of
    // the pinned story and with it the position of a section. A jump at that
    // moment lands almost right, after which the page keeps creeping for several
    // seconds. On a fresh load this is invisible, because the splash waits for
    // the images.
    const images = Array.from(
      this.document.querySelectorAll<HTMLImageElement>('#qres-hero img')
    ).filter((image) => !image.complete);
    if (images.length > 0) {
      await Promise.race([
        Promise.all(images.map((image) => image.decode().catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    }

    // Two matching bounds in a row are not enough. Scenes inside the story
    // measure their own lines after the first paint and change the height of the
    // pinned block late: the bounds manage to match and half a second later
    // drift, and the jump misses by a screen. We wait for three identical measurements.
    let previous = '';
    let steady = 0;
    for (let attempt = 0; attempt < 24; attempt++) {
      ScrollTrigger.refresh();
      const trigger = this.storyTimeline?.scrollTrigger;
      const bounds = trigger ? `${Math.round(trigger.start)}:${Math.round(trigger.end)}` : '';
      steady = bounds && bounds === previous ? steady + 1 : 0;
      if (steady >= 2) {
        break;
      }
      previous = bounds;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.applyJump(label);
  }

  private applyJump(label: string): void {
    const timeline = this.storyTimeline;
    const trigger = timeline?.scrollTrigger;
    const at = timeline?.labels?.[label];
    if (!timeline || !trigger || at === undefined) {
      const selector = STORY_SECTION_SELECTORS.find(([name]) => name === label)?.[1];
      const node = selector ? this.document.querySelector(selector) : null;
      node?.scrollIntoView({ behavior: 'auto', block: 'start' });
      return;
    }

    // ScrollTrigger computes the position itself: it knows its own bounds
    // exactly, while arithmetic by hand over start/end missed whenever the
    // pinning had not recalculated, and the page landed on the neighbouring section.
    const scroll = typeof trigger.labelToScroll === 'function' ? trigger.labelToScroll(label) : NaN;
    if (!Number.isFinite(scroll)) {
      return;
    }
    this.scrollInstantly(trigger, scroll);
    this.headerHidden = label !== 'hero';
    this.activeSection = label;
    this.changeDetectorRef.markForCheck();
    if (at / timeline.duration() >= 0.999) {
      this.storyScrollEngine?.holdAtStoryEnd();
    }
  }

  /**
   * Releases the splash once the first screen is drawn: the story is built
   * (pinning changes the layout) and the mascot marks are decoded. Otherwise you
   * would see them appear from under the departing splash. We wait no longer
   * than a second and a half for images — a slow network must not hold the whole
   * site.
   */
  private async releaseSplashWhenHeroReady(): Promise<void> {
    if (!this.holdingSplash) {
      return;
    }
    const images = Array.from(this.document.querySelectorAll<HTMLImageElement>('.qres-site-header app-mascot-logo img, .qres-hero app-mascot-logo img'));
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
   * The first screen comes through while the splash mark flies into the header:
   * the mascot, the title with its subtitle, then the cards. We animate the
   * inner nodes: the title wrapper and the cards themselves are driven by the
   * story on scroll, and two sources of opacity on one node would fight.
   */
  private playHeroEntrance(): void {
    const hero = this.heroRef?.nativeElement;
    if (!hero || window.scrollY > 10 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const mascot = hero.querySelector('.qres-hero-mascot');
    const text = [hero.querySelector('.qres-hero-title'), hero.querySelector('.qres-hero-lede')].filter(Boolean);
    const cards = hero.querySelector('.qres-hero-cards');
    const clearProps = 'opacity,visibility,transform';
    const entrance = gsap.timeline({ defaults: { ease: 'power3.out' } });
    if (mascot) {
      entrance.from(mascot, { autoAlpha: 0, scale: 0.8, duration: 0.55, ease: 'back.out(1.8)', clearProps }, 0.12);
    }
    if (text.length) {
      entrance.from(text, { autoAlpha: 0, y: 20, duration: 0.6, stagger: 0.08, clearProps }, 0.16);
    }
    if (cards) {
      entrance.from(cards, { autoAlpha: 0, y: 26, duration: 0.65, clearProps }, 0.28);
    }
  }

  scrollToTop(): void {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Nudges the story off the first screen.
   *
   * We scroll by the window height rather than to a particular section: the
   * hero is pinned, the sections lie over it and have no position of their own
   * on the page — `scrollIntoView` would go to the start of the pinning, which
   * is nowhere.
   */
  scrollToStory(): void {
    this.goToSection('what', true);
  }

  /**
   * Keeps the menu highlight in agreement with what is on screen.
   *
   * The five "how it works" scenes are labels step1..step5, but they are not
   * shown in the menu: to a person that is one section, so we fold them into 'how'.
   */
  private syncActiveSection(progress: number): void {
    const timeline = this.storyTimeline;
    if (!timeline) {
      return;
    }
    const at = progress * timeline.duration();
    let current = 'hero';
    for (const [name, position] of Object.entries(timeline.labels)) {
      if (position <= at + 0.001) {
        current = name;
      }
    }
    // The How it works phases and the What is it beats are internal stops of
    // their own sections: in the menu they fold into the section.
    const section = current.startsWith('step') ? 'how' : current.startsWith('what') ? 'what' : current;

    // Live scenes inside How it works run only for the phase on screen: the
    // rest must not spin for nothing.
    const step = current === 'how' ? 1 : current.startsWith('step') ? Number(current.slice(4)) : null;
    const howStep = section === 'how' ? step : null;
    if (howStep !== this.howStep) {
      this.howStep = howStep;
      this.changeDetectorRef.markForCheck();
    }

    if (section !== this.activeSection) {
      this.activeSection = section;
      // On an ordinary scroll somebody has to drive the header too.
      if (!this.navigatingToSection) {
        this.headerHidden = section !== 'hero';
      }
      this.changeDetectorRef.markForCheck();
    }
  }

  /**
   * Moves the page to a story label.
   *
   * The sections lie over the pinned hero and have no position of their own on
   * the page, so `scrollIntoView` is useless here: we work the place out
   * ourselves from the label's fraction of the timeline and the pinning bounds.
   */
  /**
   * Where to settle the scroll if it was moved past the engine — by dragging
   * the scrollbar. The wheel, trackpad, touch and keys are driven by
   * `StoryScrollEngine` straight from stop to stop and never reach snapping.
   *
   * So this is the nearest label rather than the next one in the direction: a
   * scrollbar is released where the person wanted to stop.
   */
  private snapToLabel(value: number): number {
    // During a button transition, snapping has to pull EXACTLY to the target.
    // Returning `value` is not enough: browser experience showed it still
    // manages to move the page, and from there it cascades to the next label and
    // then the next. With a fixed target a cascade is impossible.
    if (this.navigatingToSection) {
      return this.navTargetProgress;
    }
    const timeline = this.storyTimeline;
    if (!timeline || this.storyScrollEngine?.isAnimating) {
      return value;
    }
    const duration = timeline.duration();
    const points = Object.values(timeline.labels)
      .map((position) => (position as number) / duration)
      .sort((a, b) => a - b);
    if (!points.length) {
      return value;
    }
    // We do not hold past the last label: the footer comes after it, and
    // pulling back felt like "the page will not scroll".
    if (value > points[points.length - 1]) {
      return value;
    }
    return points.reduce((best, point) => (Math.abs(point - value) < Math.abs(best - value) ? point : best), points[0]);
  }

  /** The positions of the story stops, in scroll pixels. */
  private storyStopPositions(): number[] {
    const timeline = this.storyTimeline;
    const trigger = timeline?.scrollTrigger;
    if (!timeline || !trigger) {
      return [];
    }
    const duration = timeline.duration();
    const span = trigger.end - trigger.start;
    return Object.values(timeline.labels)
      .map((position) => trigger.start + span * Math.min(1, (position as number) / duration))
      .sort((a, b) => a - b);
  }

  /** A page under a dialog or the menu: we do not touch its scroll now. */
  private isStoryInputSuspended(): boolean {
    return this.dialog.openDialogs.length > 0 || this.activeGuide !== null || this.mobileMenuOpen || isSplashActive();
  }

  private animateStoryScroll(top: number, done: () => void): void {
    const trigger = this.storyTimeline?.scrollTrigger;
    gsap.killTweensOf(this.sectionScrollProxy);
    this.sectionScrollProxy.top = window.scrollY;
    gsap.to(this.sectionScrollProxy, {
      top,
      duration: STORY_STEP_DURATION_S,
      ease: 'power2.inOut',
      onUpdate: () => this.scrollInstantly(trigger, this.sectionScrollProxy.top),
      onComplete: done,
      // A menu transition kills this tween — otherwise the engine would stay "busy".
      onInterrupt: done
    });
  }

  /**
   * Moves the scroll instantly, bypassing the global smoothness.
   *
   * The global `html { scroll-behavior: smooth }` affects ANY programmatic
   * scroll. Because of it `trigger.scroll()` did not jump but travelled for
   * ~0.5s, ScrollTrigger received every intermediate position, and scrub
   * honestly played every panel along the way. That was the "it scrolls past
   * panels nobody asked for": not a calculation error, somebody else's CSS.
   */
  private scrollInstantly(trigger: any, top: number): void {
    const root = this.document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    trigger.scroll(top);
    // We put it back only after the browser has applied the jump.
    requestAnimationFrame(() => { root.style.scrollBehavior = previous; });
  }

  /**
   * The end of a transition between sections, both when it finished and when it was cut short.
   *
   * Returns the screen to a working state. The opacity of the hero block is the
   * key one here: the whole story lives inside it, and a `fade` stuck halfway
   * dims the entire page.
   */
  private endSectionTransition(): void {
    this.navigatingToSection = false;
    this.navTargetLabel = null;
    this.storyTransition = undefined;
    const hero = this.heroRef?.nativeElement;
    if (hero) {
      gsap.set(hero, { autoAlpha: 1 });
    }
    this.changeDetectorRef.markForCheck();
  }

  goToSection(label: string, smooth = false): void {
    const timeline = this.storyTimeline;
    const trigger = timeline?.scrollTrigger;
    const at = timeline?.labels?.[label];
    if (!timeline || !trigger || at === undefined) {
      // There is no timeline: either it is not built yet or reduced motion
      // turned it off. In that mode the sections are laid out in normal flow, so
      // we go to the right one by its own place on the page.
      // The hero screen is the top of the page. We do not go to the block
      // itself: it sits under the sticky header, and scrolling to it hid its top.
      const selector = label === 'hero' ? undefined : STORY_SECTION_SELECTORS.find(([name]) => name === label)?.[1];
      const node = selector ? this.document.querySelector(selector) : null;
      if (node) {
        node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      }
      return;
    }

    if (label === this.activeSection) {
      return;
    }

    const duration = timeline.duration();
    const span = trigger.end - trigger.start;
    const toTop = (position: number) => trigger.start + span * (position / duration);

    const section = this.storySections.find((item) => item.label === label);
    const fromHero = this.activeSection === 'hero';
    const toHero = label === 'hero';
    const rawEnter = section
      ? (fromHero ? section.enterAt : (section.enterFromStory ?? section.enterAt))
      : at;
    const enterAt = Math.min(rawEnter, at);

    // We kill the previous transition first and raise the flags only after:
    // `kill()` calls `onInterrupt`, and that lowers these same flags.
    this.sectionNavRelease?.kill();
    this.storyTransition?.kill();
    gsap.killTweensOf(this.sectionScrollProxy);

    this.navigatingToSection = true;
    this.navTargetProgress = at / duration;
    this.navTargetLabel = label;

    // The header leaves at the start of the transition rather than when the
    // section changes: it used to toggle somewhere mid-scroll and simply vanish.
    this.headerHidden = !toHero;
    this.changeDetectorRef.markForCheck();

    const hero = this.heroRef?.nativeElement;
    const cards = [this.firstCardRef?.nativeElement, this.secondCardRef?.nativeElement].filter(Boolean);
    const headline = this.heroHeadlineRef?.nativeElement;

    const timelineJump = (position: number) => {
      timeline.progress(position / duration);
      this.scrollInstantly(trigger, toTop(position));
    };

    // Drives the scroll from one point of the timeline to another, which is
    // "ordinary scrolling" performed on someone's behalf: scrub draws exactly
    // the frames they would have seen themselves.
    const scrub = (from: number, to: number, secs: number) => {
      this.sectionScrollProxy.top = toTop(from);
      return gsap.to(this.sectionScrollProxy, {
        top: toTop(to),
        duration: secs,
        ease: 'power1.inOut',
        onUpdate: () => this.scrollInstantly(trigger, this.sectionScrollProxy.top),
        onComplete: () => this.scrollInstantly(trigger, toTop(to))
      });
    };

    const tl = gsap.timeline({
      onComplete: () => {
        this.endSectionTransition();
        // We arrived at the last stop — the rest of the gesture must not take us into the footer.
        if (at / duration >= 0.999) {
          this.storyScrollEngine?.holdAtStoryEnd();
        }
      },
      // A transition is interrupted when someone clicks the menu a second time
      // without waiting for the first. Before this, an interruption left the page
      // in a half frame: the title faded halfway and never came back, and
      // `navigatingToSection` stayed raised forever with the engine holding the
      // scroll locked. It looked like "the site disappeared" and only a reload cured it.
      onInterrupt: () => this.endSectionTransition()
    });
    this.storyTransition = tl;

    if (toHero) {
      // Back to the hero screen. First we fade out what is on screen, then
      // under that cover we set the frame to the start and bring the cards back
      // — a mirror of how they left.
      tl.to(hero, { autoAlpha: 0, duration: 0.24, ease: 'power2.in' })
        .add(() => {
          timelineJump(0);
          gsap.set(cards[0], { xPercent: -125, scale: 0.94, autoAlpha: 0 });
          gsap.set(cards[1], { xPercent: 125, scale: 0.94, autoAlpha: 0 });
          gsap.set([headline].filter(Boolean), { y: -40, autoAlpha: 0 });
        })
        .to(hero, { autoAlpha: 1, duration: 0.2, ease: 'power2.out' })
        .to(cards, { xPercent: 0, scale: 1, autoAlpha: 1, duration: 0.6, ease: 'power2.out' }, '<')
        .to([headline].filter(Boolean), { y: 0, autoAlpha: 1, duration: 0.5, ease: 'power2.out' }, '<0.05');
      return;
    }

    if (fromHero && label === 'what') {
      // A neighbouring step: we show the real scroll in full — the cards part,
      // the title leaves, the panel comes through. There is nothing extra
      // between them, so no sleight of hand is needed.
      tl.add(scrub(0, at, 1.15));
      return;
    }

    if (fromHero) {
      // From the hero screen to a distant section. The timeline cannot be
      // fast-forwarded: "What is it" would show along the way. So we play the
      // cards parting ourselves and hide the jump behind it: by the time of the
      // jump the cards are gone.
      tl.to(cards[0], { xPercent: -125, scale: 0.94, autoAlpha: 0, duration: 0.5, ease: 'power2.in' }, 0)
        .to(cards[1], { xPercent: 125, scale: 0.94, autoAlpha: 0, duration: 0.5, ease: 'power2.in' }, 0)
        .to([headline].filter(Boolean), { y: -40, autoAlpha: 0, duration: 0.42, ease: 'power2.in' }, 0)
        .add(() => timelineJump(enterAt))
        .add(scrub(enterAt, at, 0.75));
      return;
    }

    // Between story sections. It cannot be fast-forwarded for the same reason:
    // everything in between would show. We fade the current one out, move the
    // frame under cover and bring the entrance of the right one through — the
    // hero screen never enters the frame.
    tl.to(hero, { autoAlpha: 0, duration: 0.22, ease: 'power2.in' })
      .add(() => timelineJump(enterAt))
      .to(hero, { autoAlpha: 1, duration: 0.22, ease: 'power2.out' })
      .add(scrub(enterAt, at, 0.7), '<');
  }


  /**
   * The current section with no timeline.
   *
   * In reduced motion ScrollTrigger is never created and `activeSection` stayed
   * 'hero' forever: the "you are here" mark sat under "pumpling" while the
   * "pumpling" button itself was disabled — there was no way back to the top
   * from the menu. Here the sections lie in normal flow, so the current one is
   * the last whose top has risen above a third of the window.
   */
  private trackSectionsByScroll(): void {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      let current = 'hero';
      for (const [label, selector] of STORY_SECTION_SELECTORS) {
        const node = this.document.querySelector(selector);
        if (label !== 'hero' && node && node.getBoundingClientRect().top <= line) {
          current = label;
        }
      }
      if (current !== this.activeSection) {
        this.activeSection = current;
        this.changeDetectorRef.detectChanges();
      }
    };
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(update);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    this.sectionScrollTrackingCleanup = () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }

  private buildScrollStory(): void {
    const root = this.rootRef?.nativeElement;
    const hero = this.heroRef?.nativeElement;
    const firstCard = this.firstCardRef?.nativeElement;
    const secondCard = this.secondCardRef?.nativeElement;
    const nextScreen = this.nextScreenRef?.nativeElement;
    const scrollCue = this.scrollCueRef?.nativeElement;
    const heroHeadline = this.heroHeadlineRef?.nativeElement;
    const sectionHeader = this.sectionHeaderRef?.nativeElement;
    const sectionDot = this.sectionDotRef?.nativeElement;
    const sectionTitle = this.sectionTitleRef?.nativeElement;
    const sectionLine = this.sectionLineRef?.nativeElement;
    const sectionCopy = this.sectionCopyRef?.nativeElement;

    if (!root || !hero || !firstCard || !secondCard || !nextScreen || !sectionHeader || !sectionDot || !sectionTitle || !sectionLine || !sectionCopy) {
      return;
    }

    this.bindSolCommitHover(root);
    this.zone.runOutsideAngular(() => this.solCommitCleanups.push(bindQuickStartPointer(root)));

    // Two story layouts, and gsap switches between them itself when the
    // conditions change — a tablet rotating, the window narrowing, reduced
    // motion turning on — rolling back everything the previous one did.
    this.storyMedia = gsap.matchMedia();

    // Phone and reduced motion: an ordinary long page with no pinning.
    // The story sections lie OVER the hero (`absolute … top-[-6rem]`) and are
    // separated in time by the timeline; with no timeline they have to be laid
    // out in flow, or three panels stack on one screen. On a phone, hijacking
    // the scroll hurts more than it helps: touch, inertia and a collapsing
    // address bar would jerk a pinned screen.
    this.storyMedia.add('(max-width: 767px), (prefers-reduced-motion: reduce)', () => {
      root.classList.add('qres-story--static');
      gsap.set(root.querySelectorAll('[data-story-anim],[data-qres-quick-item]'), { autoAlpha: 1, clearProps: 'transform' });
      gsap.set(
        [nextScreen, ...root.querySelectorAll('[data-qres-copy-section],[data-qres-quick-start]')],
        { autoAlpha: 1, position: 'static', inset: 'auto', marginTop: '4rem' }
      );
      gsap.set(hero, { height: 'auto', minHeight: 'auto', display: 'block' });
      // The "scroll down" hint is not needed here: the page is ordinary anyway.
      gsap.set([scrollCue].filter(Boolean), { display: 'none' });
      this.reducedMotionLayout = true;
      this.trackSectionsByScroll();
      this.changeDetectorRef.markForCheck();
      return () => {
        root.classList.remove('qres-story--static');
        this.reducedMotionLayout = false;
        this.sectionScrollTrackingCleanup?.();
        this.sectionScrollTrackingCleanup = undefined;
      };
    });

    this.storyMedia.add('(min-width: 768px) and (prefers-reduced-motion: no-preference)', () => {
      const q = (selector: string) => gsap.utils.toArray<HTMLElement>(selector, root);
      const cards = [firstCard, secondCard];

      // ------------------------------------------------ What is it
      const whatCopy = [1, 2, 3].map((beat) =>
        q(`[data-what-copy="${beat}"] .what__eyebrow, [data-what-copy="${beat}"] [data-what-line]`));
      const feed = q('[data-what-feed]');
      const postA = q('[data-what-post="a"]');
      const postB = q('[data-what-post="b"]');
      const stampA = q('[data-what-stamp="a"]');
      const stampB = q('[data-what-stamp="b"]');
      const pool = q('[data-what-pool]');
      const poolFill = q('[data-what-pool-fill]');
      const poolLock = q('[data-what-lock]');
      const marquee = q('[data-qres-primary-marquee]');

      // ------------------------------------------------ How it works
      const howSection = q('[data-qres-copy-section]');
      const howDot = q('[data-qres-copy-section-dot]');
      const howTitle = q('[data-qres-copy-section-title]');
      const howLine = q('[data-qres-copy-section-line]');
      const track = q('[data-how-track]');
      const trackFill = q('[data-how-fill]');
      const nodeDots = [1, 2, 3, 4, 5].map((i) => q(`[data-how-dot="${i}"]`));
      const nodeLabels = [1, 2, 3, 4, 5].map((i) => q(`[data-how-label="${i}"]`));
      const scenes = [1, 2, 3, 4, 5].map((i) => q(`[data-how-scene="${i}"]`));
      const sceneCopy = scenes.map((scene) => q(`[data-how-scene="${scenes.indexOf(scene) + 1}"] [data-how-copy]`));
      const sceneCard = scenes.map((scene) => q(`[data-how-scene="${scenes.indexOf(scene) + 1}"] [data-how-card]`));
      const sceneRows = scenes.map((scene) => q(`[data-how-scene="${scenes.indexOf(scene) + 1}"] [data-how-row]`));
      const sceneBars = scenes.map((scene) => q(`[data-how-scene="${scenes.indexOf(scene) + 1}"] [data-how-bar]`));
      const shareBars = q('[data-how-share]');
      const shackle = q('[data-how-shackle]');
      /** The fraction of the scale the phase node sits at. The same as `nodes` in story-how. */
      const nodeAt = [0, 1 / 3, 2 / 3, 5 / 6, 1];

      // ------------------------------------------------ Quick start
      const quickStartSection = q('[data-qres-quick-start]');
      const quickDot = q('[data-qres-quick-dot]');
      const quickTitle = q('[data-qres-quick-title]');
      const quickLine = q('[data-qres-quick-line]');
      const quickItems = q('[data-qres-quick-item]');

      // ------------------------------------------------ initial states
      gsap.set(cards, { autoAlpha: 1, y: 0 });
      gsap.set(nextScreen, { autoAlpha: 0 });
      gsap.set(sectionHeader, { autoAlpha: 1 });
      gsap.set([sectionDot, howDot, quickDot], { autoAlpha: 0, scale: 0, transformOrigin: '50% 50%' });
      gsap.set([sectionTitle, howTitle, quickTitle], { autoAlpha: 0, yPercent: 70 });
      gsap.set([sectionLine, howLine, quickLine], { autoAlpha: 1, scaleX: 0, transformOrigin: '0% 50%' });
      gsap.set(sectionCopy, { autoAlpha: 1 });
      gsap.set(whatCopy.flat(), { autoAlpha: 0, yPercent: 60 });
      gsap.set(feed, { autoAlpha: 0 });
      gsap.set(postA, { autoAlpha: 0, xPercent: 30, yPercent: 8, rotation: 4 });
      gsap.set(postB, { autoAlpha: 0, xPercent: 40, yPercent: 70 });
      gsap.set([stampA, stampB], { autoAlpha: 0, scale: 1.8 });
      gsap.set(pool, { autoAlpha: 0, scale: 0.86, y: 40 });
      gsap.set(poolFill, { scaleX: 0 });
      gsap.set(poolLock, { autoAlpha: 0, y: 12 });
      gsap.set(marquee, { autoAlpha: 0, y: 42 });
      gsap.set(howSection, { autoAlpha: 0 });
      gsap.set(track, { autoAlpha: 0, y: 16 });
      gsap.set(trackFill, { scaleX: 0 });
      gsap.set(nodeDots.flat(), { backgroundColor: '#FCFCFC' });
      gsap.set(nodeLabels.flat(), { color: 'rgba(2, 2, 2, 0.6)' });
      gsap.set(scenes.flat(), { autoAlpha: 0 });
      gsap.set(sceneCopy.flat(), { y: 30 });
      gsap.set(sceneCard.flat(), { y: 40, scale: 0.97 });
      gsap.set(sceneRows.flat(), { autoAlpha: 0, y: 12 });
      gsap.set(sceneBars.flat(), { scaleX: 0 });
      gsap.set(shareBars, { scaleX: (i: number, el: HTMLElement) => (+(el.dataset['before'] ?? 1)) / (+(el.dataset['after'] ?? 1)) });
      gsap.set(shackle, { y: -4 });
      gsap.set(quickStartSection, { autoAlpha: 0 });
      gsap.set(quickItems, { autoAlpha: 0, y: 34 });

      const timeline = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: root,
          start: 'top top',
          end: '+=650%',
          // No smoothing: the wheel and trackpad are driven by the engine with a
          // smooth tween, and a second delay on top only stretched the step and
          // blurred the moment the scene settled.
          scrub: true,
          pin: hero,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate: (self) => this.syncActiveSection(self.progress),
          snap: {
            // Our own function rather than the string 'labelsDirectional': a
            // string one cannot be switched off during a programmatic transition.
            snapTo: (value: number) => this.snapToLabel(value),
            // No velocity projection: a sharp move would "coast" past the
            // target — measured, a jump to Quick start ran off to the end of the story.
            inertia: false,
            duration: { min: 0.25, max: 0.6 },
            delay: 0.15,
            ease: 'power1.inOut'
          }
        }
      });

      // The labels are the story stops: the engine leads here and the menu
      // jumps by them. Between labels there is exactly one transition scene.
      this.storyTimeline = timeline;
      timeline.addLabel('hero', 0);

      // ------------------------------------ start → What is it, beat 1
      timeline
        .fromTo(firstCard, { xPercent: 0, scale: 1, autoAlpha: 1 }, { xPercent: -125, scale: 0.94, autoAlpha: 0.9, duration: 0.46, immediateRender: false }, 0)
        .fromTo(secondCard, { xPercent: 0, scale: 1, autoAlpha: 1 }, { xPercent: 125, scale: 0.94, autoAlpha: 0.9, duration: 0.46, immediateRender: false }, 0)
        // An empty array if the hint is not in the markup: GSAP skips such a
        // target silently, while it complains about undefined in the console.
        // The title and the arrow start from exactly zero. A menu transition
        // hides them with its own tween, and if the timeline reached these tweens
        // for the first time after it, then scrolling back BEFORE the start of
        // the tween made GSAP restore that hidden state — the first screen was
        // left with no title (measured). A tween starting at zero draws its
        // initial values at zero.
        .fromTo([scrollCue].filter(Boolean), { autoAlpha: 1, y: 0 }, { autoAlpha: 0, y: 14, duration: 0.12, ease: 'power2.in', immediateRender: false }, 0)
        .fromTo([heroHeadline].filter(Boolean), { autoAlpha: 1, y: 0 }, { autoAlpha: 0, y: -40, duration: 0.34, ease: 'power3.in', immediateRender: false }, 0)
        .fromTo(cards, { autoAlpha: 0.9 }, { autoAlpha: 0, duration: 0.2, immediateRender: false }, 0.32)
        .to(nextScreen, { autoAlpha: 1, duration: 0.42 }, 0.26)
        .to(sectionDot, { autoAlpha: 1, scale: 1, duration: 0.18, ease: 'back.out(2)' }, 0.43)
        .to(sectionTitle, { autoAlpha: 1, yPercent: 0, duration: 0.22, ease: 'power2.out' }, 0.47)
        .to(sectionLine, { scaleX: 1, duration: 0.38, ease: 'power2.out' }, 0.52)
        .to(feed, { autoAlpha: 1, duration: 0.3 }, 0.6)
        .to(postA, { autoAlpha: 1, xPercent: 0, yPercent: 0, rotation: 0, duration: 0.4, ease: 'power3.out' }, 0.64)
        .to(whatCopy[0], { autoAlpha: 1, yPercent: 0, duration: 0.28, stagger: 0.07, ease: 'power2.out' }, 0.62)
        .to(marquee, { autoAlpha: 1, y: 0, duration: 0.26, ease: 'power2.out' }, 0.78)
        .addLabel('what', 1.2);

      // ------------------------------------ beat 2: promises are cheap
      timeline
        .to(whatCopy[0], { autoAlpha: 0, yPercent: -60, duration: 0.2, stagger: 0.03, ease: 'power2.in' }, 1.3)
        .to(postA, { xPercent: -10, yPercent: -38, scale: 0.94, duration: 0.4, ease: 'power2.inOut' }, 1.3)
        .to(stampA, { autoAlpha: 1, scale: 1, duration: 0.16, ease: 'back.out(3)' }, 1.62)
        .to(postB, { autoAlpha: 1, xPercent: 8, yPercent: 36, duration: 0.4, ease: 'power3.out' }, 1.5)
        .to(stampB, { autoAlpha: 1, scale: 1, duration: 0.16, ease: 'back.out(3)' }, 1.86)
        .to(whatCopy[1], { autoAlpha: 1, yPercent: 0, duration: 0.28, stagger: 0.07, ease: 'power2.out' }, 1.52)
        .addLabel('what2', 2.2);

      // ------------------------------------ beat 3: the program
      timeline
        .to(whatCopy[1], { autoAlpha: 0, yPercent: -60, duration: 0.2, stagger: 0.03, ease: 'power2.in' }, 2.3)
        .to([postA, postB], { autoAlpha: 0, xPercent: '-=30', duration: 0.3, ease: 'power2.in' }, 2.3)
        .to(feed, { autoAlpha: 0, duration: 0.3 }, 2.3)
        .to(pool, { autoAlpha: 1, scale: 1, y: 0, duration: 0.42, ease: 'back.out(1.4)' }, 2.5)
        .to(poolFill, { scaleX: 1, duration: 0.36, ease: 'power2.out' }, 2.74)
        .to(poolLock, { autoAlpha: 1, y: 0, duration: 0.22, ease: 'power2.out' }, 2.96)
        .to(whatCopy[2], { autoAlpha: 1, yPercent: 0, duration: 0.28, stagger: 0.07, ease: 'power2.out' }, 2.55)
        .addLabel('what3', 3.3);

      // ------------------------------------ What is it → How it works, phase 1
      timeline
        .to(marquee, { autoAlpha: 0, y: 42, duration: 0.22, ease: 'power2.in' }, 3.4)
        .to(whatCopy[2], { autoAlpha: 0, yPercent: -60, duration: 0.2, stagger: { each: 0.03, from: 'end' }, ease: 'power2.in' }, 3.42)
        .to(pool, { autoAlpha: 0, y: -40, duration: 0.24, ease: 'power2.in' }, 3.44)
        .to(sectionLine, { scaleX: 0, duration: 0.26, transformOrigin: '100% 50%', ease: 'power2.in' }, 3.56)
        .to(sectionTitle, { autoAlpha: 0, yPercent: -80, duration: 0.2, ease: 'power2.in' }, 3.6)
        .to(sectionDot, { autoAlpha: 0, scale: 0, duration: 0.18, ease: 'power2.in' }, 3.62)
        .to(nextScreen, { autoAlpha: 0, duration: 0.16 }, 3.72)
        .to(howSection, { autoAlpha: 1, duration: 0.24 }, 3.7)
        .to(howDot, { autoAlpha: 1, scale: 1, duration: 0.18, ease: 'back.out(2)' }, 3.82)
        .to(howTitle, { autoAlpha: 1, yPercent: 0, duration: 0.22, ease: 'power2.out' }, 3.87)
        .to(howLine, { scaleX: 1, duration: 0.38, ease: 'power2.out' }, 3.94)
        .to(track, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power2.out' }, 4.0)
        .to(nodeDots[0], { backgroundColor: '#AF8FFF', duration: 0.16 }, 4.2)
        .to(nodeLabels[0], { color: '#020202', duration: 0.16 }, 4.2)
        .to(scenes[0], { autoAlpha: 1, duration: 0.2 }, 4.1)
        .to(sceneCopy[0], { y: 0, duration: 0.36, ease: 'power3.out' }, 4.1)
        .to(sceneCard[0], { y: 0, scale: 1, duration: 0.4, ease: 'power3.out' }, 4.16)
        .to(sceneRows[0], { autoAlpha: 1, y: 0, duration: 0.2, stagger: 0.06, ease: 'power2.out' }, 4.3)
        .addLabel('how', 4.7);

      // ------------------------------------ phases 2–5
      const stepAt = (step: number) => 4.8 + (step - 2) * 1.1;
      for (let step = 2; step <= 5; step++) {
        const start = stepAt(step);
        const i = step - 1;
        timeline
          .to(sceneCopy[i - 1], { y: -30, duration: 0.24, ease: 'power2.in' }, start)
          .to(sceneCard[i - 1], { y: -30, duration: 0.24, ease: 'power2.in' }, start)
          .to(scenes[i - 1], { autoAlpha: 0, duration: 0.22, ease: 'power2.in' }, start)
          .to(trackFill, { scaleX: nodeAt[i], duration: 0.5, ease: 'power2.inOut' }, start)
          .to(nodeDots[i - 1], { backgroundColor: '#020202', duration: 0.16 }, start + 0.1)
          .to(nodeDots[i], { backgroundColor: '#AF8FFF', duration: 0.16 }, start + 0.4)
          .to(nodeLabels[i], { color: '#020202', duration: 0.16 }, start + 0.4)
          .fromTo(sceneCopy[i], { y: 30 }, { y: 0, duration: 0.36, ease: 'power3.out', immediateRender: false }, start + 0.22)
          .fromTo(sceneCard[i], { y: 40, scale: 0.97 }, { y: 0, scale: 1, duration: 0.4, ease: 'power3.out', immediateRender: false }, start + 0.26)
          .to(scenes[i], { autoAlpha: 1, duration: 0.22 }, start + 0.22)
          .to(sceneRows[i], { autoAlpha: 1, y: 0, duration: 0.2, stagger: 0.06, ease: 'power2.out' }, start + 0.38)
          .to(sceneBars[i], { scaleX: 1, duration: 0.34, stagger: 0.06, ease: 'power2.out' }, start + 0.46);
        if (step === 3) {
          timeline
            .to(shackle, { y: 0, duration: 0.14, ease: 'back.in(2)' }, start + 0.42)
            .to(shareBars, { scaleX: 1, duration: 0.4, stagger: 0.05, ease: 'power2.inOut' }, start + 0.6);
        }
        timeline.addLabel(`step${step}`, start + 0.9);
      }

      // ------------------------------------ How it works → Quick start
      const quickStartAt = stepAt(5) + 1.0;
      timeline
        .to(sceneCopy[4], { y: -30, duration: 0.24, ease: 'power2.in' }, quickStartAt)
        .to(sceneCard[4], { y: -30, duration: 0.24, ease: 'power2.in' }, quickStartAt)
        .to(scenes[4], { autoAlpha: 0, duration: 0.22, ease: 'power2.in' }, quickStartAt)
        .to(track, { autoAlpha: 0, y: -12, duration: 0.22, ease: 'power2.in' }, quickStartAt + 0.05)
        .to(howSection, { autoAlpha: 0, duration: 0.2, ease: 'power2.in' }, quickStartAt + 0.12)
        .to(quickStartSection, { autoAlpha: 1, duration: 0.24, ease: 'power2.out' }, quickStartAt + 0.18)
        .to(quickDot, { autoAlpha: 1, scale: 1, duration: 0.18, ease: 'back.out(2)' }, quickStartAt + 0.3)
        .to(quickTitle, { autoAlpha: 1, yPercent: 0, duration: 0.22, ease: 'power2.out' }, quickStartAt + 0.35)
        .to(quickLine, { scaleX: 1, duration: 0.38, ease: 'power2.out' }, quickStartAt + 0.42)
        .to(quickItems, { autoAlpha: 1, y: 0, duration: 0.28, stagger: 0.06, ease: 'power2.out' }, quickStartAt + 0.56)
        // Quick start is the end of the story: the label sits at the very end,
        // the pinning releases the page exactly here, and after that the footer
        // scrolls normally. A timeline tail after the label created a "dead
        // zone" the engine kept pulling the page back from, and the footer was unreachable.
        .addLabel('quick', quickStartAt + 1.2)
        // An empty point exactly on the label: without it the timeline's length
        // ended at the last animation (before the label), and the last stop
        // counted as being past the end of the story, where scrolling up looped.
        .set({}, {}, 'quick');

      // Wheel, trackpad, touch and keys go from stop to stop.
      // Why, in detail, is in story-scroll-engine.ts.
      this.storyScrollEngine = new StoryScrollEngine({
        getStops: () => this.storyStopPositions(),
        getEnd: () => this.storyTimeline?.scrollTrigger?.end ?? 0,
        getExitTarget: () => ScrollTrigger.maxScroll(window),
        isBusy: () => this.navigatingToSection,
        isSuspended: () => this.isStoryInputSuspended(),
        animateTo: (top, done) => this.animateStoryScroll(top, done)
      });
      this.storyScrollEngine.attach();

      return () => {
        this.storyScrollEngine?.detach();
        this.storyScrollEngine = undefined;
        this.storyTimeline = undefined;
      };
    });
  }

  /**
   * The animation of the "Add SOL" line in Quick start: the bars of the Solana
   * mark slide into a circle and fly away. It plays on hover in any layout.
   */
  private bindSolCommitHover(root: HTMLElement): void {
    gsap.utils.toArray<HTMLElement>('[data-qres-sol-commit-row]', root).forEach((row) => {
      const stage = row.querySelector<HTMLElement>('[data-qres-sol-commit-stage]');
      const symbol = row.querySelector<SVGGElement>('[data-qres-sol-symbol]');
      const bars = gsap.utils.toArray<SVGPathElement>('[data-qres-sol-bar]', row);
      const circle = row.querySelector<SVGCircleElement>('[data-qres-sol-circle]');
      if (!stage || !symbol || !circle || bars.length === 0) {
        return;
      }
      const resetSolCommit = () => {
        gsap.set(stage, { autoAlpha: 0 });
        gsap.set(symbol, { x: 0, autoAlpha: 1, transformOrigin: '50% 50%' });
        gsap.set(bars, { autoAlpha: 0, x: (index: number) => -170 - index * 36, y: (index: number) => (index - 1) * -22, transformOrigin: '50% 50%' });
        gsap.set(circle, { autoAlpha: 0, strokeDasharray: 190, strokeDashoffset: 190, transformOrigin: '50% 50%' });
      };
      resetSolCommit();
      const solTimeline = gsap
        .timeline({ paused: true, repeat: -1, repeatDelay: 0.1 })
        .set(stage, { autoAlpha: 1 })
        .to(bars, { autoAlpha: 1, x: 0, y: 0, duration: 0.34, stagger: 0.07, ease: 'power3.out' })
        .to(circle, { autoAlpha: 1, duration: 0.01 }, '-=0.06')
        .to(circle, { strokeDashoffset: 0, duration: 0.3, ease: 'power2.out' }, '-=0.03')
        .to({}, { duration: 0.16 })
        .to(symbol, { x: 162, autoAlpha: 0, duration: 0.48, ease: 'power2.in' })
        .call(resetSolCommit);
      // Mouse only: touch on a phone sends an enter with no leave, and the
      // animation would loop until you touched something else.
      const playSolCommit = (event: PointerEvent) => {
        if (event.pointerType !== 'touch') {
          solTimeline.restart();
        }
      };
      const resetOnLeave = () => { solTimeline.pause(0); resetSolCommit(); };
      row.addEventListener('pointerenter', playSolCommit);
      row.addEventListener('pointerleave', resetOnLeave);
      this.solCommitCleanups.push(() => {
        row.removeEventListener('pointerenter', playSolCommit);
        row.removeEventListener('pointerleave', resetOnLeave);
        solTimeline.kill();
      });
    });
  }

  ngOnDestroy(): void {
    // We left the main page before it released the splash — release it ourselves.
    this.releaseHeldSplash();
    this.splashExitCleanup?.();
    // An interrupted transition would otherwise leave the flag raised and snapping silent.
    this.sectionNavRelease?.kill();
    gsap.killTweensOf(this.sectionScrollProxy);
    this.navigatingToSection = false;
    this.navResizeObserver?.disconnect();
    this.headerResizeObserver?.disconnect();
    cancelAnimationFrame(this.navMarkerFrame);
    this.sectionScrollTrackingCleanup?.();
    this.storyScrollEngine?.detach();
    this.solCommitCleanups.forEach((cleanup) => cleanup());
    this.solCommitCleanups = [];
    this.gsapContext?.revert();
    this.storyMedia?.revert();
    this.headlineAnimation?.unsubscribe();
    this.authSubscription?.unsubscribe();
    this.mobileMenuOpen = false;
    this.unlockPageScroll();
  }

  toggleMobileMenu(): void {
    if (this.mobileMenuOpen) {
      this.closeMobileMenu();
      return;
    }

    this.mobileMenuOpen = true;
    this.lockPageScroll();
  }

  closeMobileMenu(): void {
    if (!this.mobileMenuOpen) {
      return;
    }

    this.mobileMenuOpen = false;

    if (!this.activeGuide) {
      this.unlockPageScroll();
    }
  }

  toggleSection(section: NavSection): void {
    this.expandedSections[section] = !this.expandedSections[section];
  }

  async handleAuthButtonClick(): Promise<void> {
    if (this.walletBusy) {
      return;
    }

    if (this.isAuthenticated) {
      const confirmed = await this.systemDialog.confirm('You can sign back in with your email or wallet at any time.', SignOutConfirm);
      if (confirmed) {
        await this.logout();
      }
      return;
    }

    this.authDialog.open({ mode: 'sign-in' });
  }

  async connectWallet(): Promise<void> {
    if (this.walletBusy) {
      return;
    }

    if (this.walletLinked) {
      const confirmed = await this.systemDialog.confirm('You can sign back in with your email or wallet at any time.', SignOutConfirm);
      if (confirmed) {
        await this.logoutWallet();
      }
      return;
    }

    this.authDialog.open({ mode: 'sign-in' });
  }

  walletButtonLabel(): string {
    if (this.walletBusy) {
      return 'Connecting...';
    }
    if (this.isAuthenticated) {
      return 'Sign out';
    }
    return 'Sign in';
  }

  private async logout(): Promise<void> {
    this.walletBusy = true;
    try {
      // Signing out always releases the wallet: the session ended, so the site
      // has forgotten about it. We used to disconnect only the one used to sign
      // in, and a connection made for a commit survived the sign-out.
      await this.walletService.disconnect();
    } catch (error) {
      console.error('Wallet disconnect failed', error);
    } finally {
      this.clearAuthSession();
      this.store.dispatch(signOut());
      this.walletBusy = false;
      this.changeDetectorRef.markForCheck();
    }
  }

  private async logoutWallet(): Promise<void> {
    this.walletBusy = true;
    try {
      await this.walletService.disconnect();
    } catch (error) {
      console.error('Wallet disconnect failed', error);
    } finally {
      this.clearAuthSession();
      this.store.dispatch(signOut());
      this.walletBusy = false;
      this.changeDetectorRef.markForCheck();
    }
  }

  private async restoreWalletSession(): Promise<void> {
    const token = localStorage.getItem('jwt');
    const linkedAddress = localStorage.getItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
    const hasValidToken = !!token && !this.jwtHelper.isTokenExpired(token);

    if (!hasValidToken) {
      this.resetWalletSessionState();
      return;
    }

    this.isAuthenticated = true;
    this.store.dispatch(signIn());

    if (!linkedAddress) {
      this.walletLinked = false;
      this.walletAddress = null;
      this.changeDetectorRef.markForCheck();
      return;
    }

    try {
      this.walletLinked = true;
      this.walletAddress = linkedAddress;
      const connectedAddress = await this.walletService.checkConnection();
      if (connectedAddress) {
        this.walletAddress = connectedAddress;
        localStorage.setItem(WALLET_LINKED_ADDRESS_STORAGE_KEY, connectedAddress);
      }
    } catch (error) {
      console.error('Failed to restore wallet session', error);
    } finally {
      this.changeDetectorRef.markForCheck();
    }
  }

  private resetWalletSessionState(): void {
    this.clearAuthSession();
    this.store.dispatch(signOut());
  }

  private clearAuthSession(): void {
    localStorage.removeItem('jwt');
    localStorage.removeItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
    this.isAuthenticated = false;
    this.walletLinked = false;
    this.walletAddress = null;
  }

  private syncAuthSessionState(): void {
    if (this.hasValidAuthToken()) {
      this.isAuthenticated = true;
      this.store.dispatch(signIn());
      return;
    }

    this.clearAuthSession();
    this.store.dispatch(signOut());
  }

  private hasValidAuthToken(): boolean {
    const token = localStorage.getItem('jwt');
    return !!token && !this.jwtHelper.isTokenExpired(token);
  }

  private advanceHeadline(): void {
    const phrase = HEADLINE_PHRASES[this.headlinePhraseIndex];

    if (this.headlinePhase === 'decoding') {
      this.headlineStep += 1;

      if (this.headlineStep >= HASH_TRANSITION_STEPS) {
        this.headlineText = phrase;
        this.headlinePhase = 'hold';
        this.headlineHoldTicks = 0;
        this.changeDetectorRef.markForCheck();
        return;
      }

      this.headlineText = this.buildHashTransition(phrase, this.headlineStep, false);
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
        this.changeDetectorRef.markForCheck();
        return;
      }

      this.headlineText = this.buildHashBridge(phrase, nextPhrase, this.headlineStep);
      this.changeDetectorRef.markForCheck();
      return;
    }

    this.headlineStep += 1;

    if (this.headlineStep >= HASH_TRANSITION_STEPS) {
      const nextPhraseIndex = (this.headlinePhraseIndex + 1) % HEADLINE_PHRASES.length;

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
      .map((char, index) => {
        if (char === ' ') {
          return ' ';
        }

        const shouldShowPhraseChar = index < pivot;
        return shouldShowPhraseChar ? char : this.randomHashChar();
      })
      .join('');
  }

  private buildHashBridge(fromPhrase: string, toPhrase: string, step: number): string {
    const ratio = step / HASH_BRIDGE_STEPS;
    const easedRatio = 1 - Math.pow(1 - ratio, 2);
    const nextLength = Math.round(fromPhrase.length + (toPhrase.length - fromPhrase.length) * easedRatio);
    const spacingTemplate = easedRatio < 0.5 ? fromPhrase : toPhrase;

    return Array.from({ length: nextLength }, (_, index) => {
      return spacingTemplate[index] === ' ' ? ' ' : this.randomHashChar();
    }).join('');
  }

  private randomHashChar(): string {
    return HASH_CHARS[Math.floor(Math.random() * HASH_CHARS.length)];
  }

  private lockPageScroll(): void {
    const body = this.document.body;
    if (body.classList.contains('modal-scroll-locked')) {
      return;
    }

    this.lockedScrollY = window.scrollY;
    body.classList.add('modal-scroll-locked');
    body.style.top = `-${this.lockedScrollY}px`;
  }

  private unlockPageScroll(): void {
    const body = this.document.body;
    if (!body.classList.contains('modal-scroll-locked')) {
      return;
    }

    const scrollY = Math.abs(parseInt(body.style.top || '0', 10)) || this.lockedScrollY;
    body.classList.remove('modal-scroll-locked');
    body.style.top = '';
    window.scrollTo(0, scrollY);
  }
}
