import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AnalyticsService } from '../analytics/analytics.service';

/**
 * "How it works" and "Past pools" in the header, on every page.
 *
 * Asked for on 2026-10-16: How it works out of the section strip and into the
 * header as a button, Past pools up there too (it stays in the footer), so the
 * Commit SOL card no longer has to carry it.
 *
 * Wide enough, the links stand in the bar. Narrower, they fold behind a menu
 * button: the bar holds the mark, the chat, X and Sign in and nothing more on
 * a phone. The menu is a disclosure, a button that shows a list of links
 * (WAI-ARIA APG, "Disclosure Navigation Menu"), not an ARIA menu, which is for
 * application commands and makes a screen reader expect arrow keys.
 *
 * On the main page How it works moves the story (`how` output); elsewhere it
 * is a plain link to /#how, a fresh load of the main page, for the same reason
 * the header's mark is (`SiteHeaderComponent`).
 */
@Component({
  selector: 'app-header-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './header-nav.component.html',
  styleUrls: ['./header-nav.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HeaderNavComponent {
  /** On the main page: How it works is a button that moves the story there. */
  @Input() howInPage = false;
  /** Signed in: My commits joins the links. */
  @Input() mine = false;
  @Output() readonly how = new EventEmitter<void>();

  menuOpen = false;

  @ViewChild('menuButton') private menuButton?: ElementRef<HTMLButtonElement>;

  constructor(
    private readonly host: ElementRef<HTMLElement>,
    private readonly analytics: AnalyticsService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    this.cdr.markForCheck();
  }

  closeMenu(returnFocus = false): void {
    if (!this.menuOpen) {
      return;
    }
    this.menuOpen = false;
    this.cdr.markForCheck();
    if (returnFocus) {
      this.menuButton?.nativeElement.focus();
    }
  }

  goHow(from: 'bar' | 'menu'): void {
    this.analytics.event('header_how_click', { from });
    this.closeMenu();
    this.how.emit();
  }

  pastPools(from: 'bar' | 'menu'): void {
    this.analytics.event('past_pools_click', { from: from === 'bar' ? 'header' : 'header_menu' });
    this.closeMenu();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.menuOpen && !this.host.nativeElement.contains(event.target as Node)) {
      this.closeMenu();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeMenu(true);
  }
}
