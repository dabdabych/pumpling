import { A11yModule } from '@angular/cdk/a11y';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import { AsyncPipe } from '@angular/common';
import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, TemplateRef,
  ViewChild, ViewContainerRef
} from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';

import { AnalyticsService } from '../../shared/analytics/analytics.service';
import { ChatFeatureModule } from '../chat-feature.module';
import { ChatUnreadService } from './chat-unread.service';

/** Below this width the chat opens over the whole screen: a popover would leave no room to type. */
const SHEET_BELOW = '(max-width: 639.98px)';

/**
 * The chat, behind a button next to X in the header.
 *
 * Until 2026-10-16 the chat filled the second card of the first screen; that
 * card now shows the coins people have backed, and Georgiy asked for the chat
 * as an icon by the X one that opens to write in.
 *
 * The panel lives in the CDK overlay, at the top of the page, not inside the
 * header: the header bar has `will-change: transform` and leaves with a
 * transform, which would carry a fixed panel with it and position it against
 * the bar. On a wide screen it is a popover under the button, a non-modal
 * dialog: Escape or a press outside closes it and focus returns to the button.
 * On a phone it is a sheet over the whole screen, modal, with focus kept inside
 * it, because there a popover leaves no room for the keyboard.
 *
 * The chat itself is created when the panel opens and destroyed when it
 * closes, so a visitor who never opens it never opens its connection. The dot
 * on the button is `ChatUnreadService`.
 */
@Component({
  selector: 'app-chat-launcher',
  standalone: true,
  imports: [AsyncPipe, A11yModule, ChatFeatureModule],
  templateUrl: './chat-launcher.component.html',
  styleUrls: ['./chat-launcher.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatLauncherComponent implements OnInit, OnDestroy {
  /** Ids must be unique on the page: there is one launcher per header, and only one header at a time. */
  readonly panelId = 'chat-panel';
  readonly unread$: Observable<boolean>;
  open = false;
  sheet = false;

  @ViewChild('toggleButton', { static: true }) private toggleRef!: ElementRef<HTMLButtonElement>;
  @ViewChild('panel', { static: true }) private panelTemplate!: TemplateRef<unknown>;
  private overlayRef: OverlayRef | null = null;
  private overlaySubscriptions = new Subscription();
  private stopWatching: (() => void) | null = null;
  private media: MediaQueryList | null = null;
  private readonly onMediaChange = () => {
    // Crossing the width while open: the same chat in the other form.
    if (this.open) {
      this.zone.run(() => {
        this.detach();
        this.attach();
      });
    }
  };

  constructor(
    private readonly overlay: Overlay,
    private readonly viewContainer: ViewContainerRef,
    private readonly unread: ChatUnreadService,
    private readonly analytics: AnalyticsService,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone
  ) {
    this.unread$ = this.unread.unread$;
  }

  ngOnInit(): void {
    this.stopWatching = this.unread.watch();
    if (typeof matchMedia === 'function') {
      this.media = matchMedia(SHEET_BELOW);
      this.media.addEventListener('change', this.onMediaChange);
    }
  }

  ngOnDestroy(): void {
    this.stopWatching?.();
    this.media?.removeEventListener('change', this.onMediaChange);
    this.detach();
  }

  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  show(): void {
    if (this.open) {
      return;
    }
    this.open = true;
    this.attach();
    this.unread.markSeen();
    this.analytics.event('chat_open', { form: this.sheet ? 'sheet' : 'popover' });
    this.cdr.markForCheck();
  }

  /** `returnFocus`: back to the button, unless the press that closed it went somewhere else on purpose. */
  close(returnFocus = true): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.unread.markSeen();
    this.detach();
    this.cdr.markForCheck();
    if (returnFocus) {
      this.toggleRef.nativeElement.focus();
    }
  }

  private attach(): void {
    this.sheet = !!this.media?.matches;
    const button = this.toggleRef.nativeElement;
    const ref = this.sheet
      ? this.overlay.create({
        positionStrategy: this.overlay.position().global().top('0').left('0'),
        width: '100%',
        height: '100%',
        hasBackdrop: true,
        backdropClass: 'chat-launcher-backdrop',
        scrollStrategy: this.overlay.scrollStrategies.block(),
        panelClass: ['chat-launcher-pane', 'chat-launcher-pane--sheet']
      })
      : this.overlay.create({
        positionStrategy: this.overlay.position()
          .flexibleConnectedTo(button)
          .withPositions([
            { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 12 },
            { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -12 }
          ])
          .withViewportMargin(12)
          .withPush(true),
        scrollStrategy: this.overlay.scrollStrategies.reposition(),
        panelClass: ['chat-launcher-pane', 'chat-launcher-pane--popover']
      });
    this.overlayRef = ref;
    ref.attach(new TemplatePortal(this.panelTemplate, this.viewContainer));
    // Into the dialog, on the dialog itself: a screen reader says what opened,
    // and a phone does not throw up its keyboard over the messages.
    ref.overlayElement.querySelector<HTMLElement>('.chat-panel')?.focus({ preventScroll: true });

    this.overlaySubscriptions = new Subscription();
    this.overlaySubscriptions.add(ref.keydownEvents().pipe(filter((event) => event.key === 'Escape')).subscribe((event) => {
      event.preventDefault();
      this.zone.run(() => this.close());
    }));
    this.overlaySubscriptions.add(ref.backdropClick().subscribe(() => this.zone.run(() => this.close())));
    this.overlaySubscriptions.add(ref.outsidePointerEvents().subscribe((event) => {
      const target = event.target as Node | null;
      // The button toggles by itself; another overlay (the sign-in dialog the
      // chat opens) sits outside this pane but is part of using the chat.
      if (!target || button.contains(target) || (target instanceof Element && target.closest('.cdk-overlay-container'))) {
        return;
      }
      this.zone.run(() => this.close(false));
    }));
  }

  private detach(): void {
    this.overlaySubscriptions.unsubscribe();
    this.overlayRef?.dispose();
    this.overlayRef = null;
  }
}
