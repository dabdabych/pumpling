import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  ViewChild,
  inject
} from '@angular/core';
import { CdkConnectedOverlay, CdkOverlayOrigin, ConnectedPosition, Overlay } from '@angular/cdk/overlay';

let nextId = 0;

/** A moment's grace before a hover opens the card, so a mouse passing over does not flash it. */
const HOVER_OPEN_MS = 120;
/** And before it closes, so the mouse can travel from the trigger into the card to reach a link. */
const HOVER_CLOSE_MS = 180;
/** The card's width and its distance from the screen's edges: `.card` in the styles. */
const CARD_WIDTH_PX = 296;
const EDGE_PX = 16;
const GAP_PX = 8;

/**
 * A small thing on a row, and the card that explains it: the coin check's mark
 * and the burn chip. The trigger is projected with `popoverTrigger`, the card's
 * content as the rest; both are styled by the component that uses this one.
 *
 * The card comes up three ways, by the usual rules for a popover with a link in
 * it: a mouse resting on the trigger, a tap, or Enter on the focused trigger. A
 * hover card goes away when the mouse leaves both the trigger and the card; one
 * opened by a tap or a key stays until a tap elsewhere, another tap on the
 * trigger, or Escape, which also brings the focus back to the trigger. Opened
 * from the keyboard, the focus moves into the card so Tab reaches its link.
 *
 * The card lives in the CDK overlay, outside the row: no row or dialog can clip
 * it, it turns upward when there is no room below, and it closes if its trigger
 * scrolls out of view or the window changes width. Across, it is placed here
 * rather than left to the overlay: under the trigger when it fits, else shifted
 * to keep 16px off the edge. Left to the overlay, a phone 320px wide had no
 * position that fitted across, and the card was pushed on top of its own
 * trigger. The overlay's own push stays off: it ignores a position's offset and
 * shifted the card a second time, off the screen (measured, 2026-10-02).
 */
@Component({
  selector: 'app-info-popover',
  standalone: true,
  imports: [CdkOverlayOrigin, CdkConnectedOverlay],
  templateUrl: './info-popover.component.html',
  styleUrl: './info-popover.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InfoPopoverComponent implements OnDestroy {
  /** The trigger's accessible name. It has to contain any words the trigger shows. */
  @Input({ required: true }) label!: string;
  /** The card's accessible name. */
  @Input({ required: true }) cardLabel!: string;
  /** Whether the card is up: a pool row hides its price card meanwhile. */
  @Output() openChange = new EventEmitter<boolean>();

  @ViewChild('trigger', { static: true }) private triggerRef!: ElementRef<HTMLButtonElement>;
  @ViewChild('card') private cardRef?: ElementRef<HTMLElement>;

  open = false;
  readonly id = `info-popover-${++nextId}`;
  readonly scrollStrategy = inject(Overlay).scrollStrategies.reposition({ autoClose: true });
  positions: ConnectedPosition[] = [];

  private readonly cdr = inject(ChangeDetectorRef);
  /** Opened by a tap or a key: it stays until dismissed rather than following the mouse. */
  private pinned = false;
  private focusCard = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openedAtWidth = 0;

  onTriggerEnter(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || this.pinned) {
      return;
    }
    this.schedule(() => this.show(), this.open ? 0 : HOVER_OPEN_MS);
  }

  onTriggerLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && !this.pinned) {
      this.schedule(() => this.hide(), HOVER_CLOSE_MS);
    }
  }

  onCardEnter(event: PointerEvent): void {
    if (event.pointerType === 'mouse') {
      this.cancel();
    }
  }

  onCardLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && !this.pinned) {
      this.schedule(() => this.hide(), HOVER_CLOSE_MS);
    }
  }

  /** A tap, a click or Enter. A card already up from a hover is pinned rather than closed. */
  onTriggerClick(event: MouseEvent): void {
    event.stopPropagation();
    this.cancel();
    // `detail` is 0 for a click made with the keyboard.
    const fromKeyboard = event.detail === 0;
    if (this.open && this.pinned) {
      this.hide();
      return;
    }
    this.pinned = true;
    this.focusCard = fromKeyboard;
    this.show();
  }

  onOutsideClick(event: MouseEvent): void {
    // The trigger handles its own clicks: closing here first would reopen it there.
    if (this.triggerRef.nativeElement.contains(event.target as Node)) {
      return;
    }
    this.hide();
  }

  onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide(true);
    }
  }

  onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.open) {
      event.preventDefault();
      this.hide(true);
    }
  }

  /** The overlay's own detach: the trigger scrolled out of view. */
  onDetach(): void {
    if (this.open) {
      this.hide();
    }
  }

  onAttach(): void {
    if (this.focusCard) {
      this.focusCard = false;
      // After the card is in the page: the overlay attaches it this tick.
      setTimeout(() => this.cardRef?.nativeElement.focus());
    }
  }

  ngOnDestroy(): void {
    this.cancel();
    window.removeEventListener('resize', this.onResize);
    if (this.open) {
      this.openChange.emit(false);
    }
  }

  /**
   * A rotated phone or a narrower window: the place worked out across no longer
   * holds. Only the width: a phone's address bar folding away on scroll changes
   * the height, and the card stays for that.
   */
  private readonly onResize = (): void => {
    if (this.viewportWidth() !== this.openedAtWidth) {
      this.hide();
    }
  };

  private viewportWidth(): number {
    return document.documentElement.clientWidth || window.innerWidth;
  }

  /** Below the trigger, or above it when there is no room; across, inside the 16px margins. */
  private place(): ConnectedPosition[] {
    const trigger = this.triggerRef.nativeElement.getBoundingClientRect();
    const viewport = this.viewportWidth();
    this.openedAtWidth = viewport;
    const width = Math.min(CARD_WIDTH_PX, viewport - 2 * EDGE_PX);
    const left = Math.min(Math.max(trigger.left, EDGE_PX), viewport - EDGE_PX - width);
    const offsetX = Math.round(left - trigger.left);
    return [
      { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetX, offsetY: GAP_PX },
      { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetX, offsetY: -GAP_PX }
    ];
  }

  private show(): void {
    if (this.open) {
      this.cdr.markForCheck();
      return;
    }
    this.positions = this.place();
    this.open = true;
    window.addEventListener('resize', this.onResize, { passive: true });
    // Before the card renders, so whatever it says about the time is said as of now.
    this.openChange.emit(true);
    this.cdr.markForCheck();
  }

  private hide(returnFocus = false): void {
    this.cancel();
    this.pinned = false;
    if (!this.open) {
      return;
    }
    this.open = false;
    window.removeEventListener('resize', this.onResize);
    this.openChange.emit(false);
    this.cdr.markForCheck();
    if (returnFocus) {
      this.triggerRef.nativeElement.focus();
    }
  }

  private schedule(action: () => void, delay: number): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      action();
    }, delay);
  }

  private cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
