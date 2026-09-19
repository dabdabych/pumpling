import {Component, OnDestroy, OnInit} from '@angular/core';
import {MatDialog} from '@angular/material/dialog';
import {NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router} from '@angular/router';
import {Store} from '@ngrx/store';
import {Subscription} from 'rxjs';
import {filter, take} from 'rxjs/operators';

import {WalletService} from './shared/wallet.service';
import {signOut} from './store/actions/auth';
import {markAppReady} from './shared/splash';
import {startWalletStandard} from './shared/wallet-standard';
import { WALLET_LINKED_ADDRESS_STORAGE_KEY } from './shared/wallet-link';


@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss'],
    standalone: false
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'qabrica-ui';
  private walletSessionSubscription: Subscription | null = null;
  private firstNavigationSubscription: Subscription | null = null;
  private dialogNavigationSubscription: Subscription | null = null;
  private chunkErrorSubscription: Subscription | null = null;
  private linkedWalletSeen = false;

  constructor(
    private readonly walletService: WalletService,
    private readonly store: Store,
    private readonly router: Router,
    private readonly dialog: MatDialog,
  ) { }

  ngOnInit(): void {
    // Wallets announce themselves once and early. We start listening at app
    // startup rather than when the chooser opens: an announcement made before we
    // subscribed would simply not be heard.
    startWalletStandard();

    // The first route is rendered, so the splash can leave. Two frames: Angular
    // spends the first inserting the markup, and by the second it is drawn. A
    // page that needs longer holds the splash itself.
    this.firstNavigationSubscription = this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError),
      take(1)
    ).subscribe(() => this.signalFirstScreen());
    // If the first navigation finished before this component was created, the
    // event will never come.
    if (this.router.navigated) {
      this.signalFirstScreen();
    }

    // A new version shipped while the tab was open, and the files under the old
    // names are gone from the server. Navigating to a route whose chunk this tab
    // has not loaded fails: the router cancels the navigation and the person sees
    // a blank page until they reload.
    //
    // Today that can only happen in the admin area: the main page, the pool, the
    // archive and "my commits" live in one chunk and load at once. But the
    // insurance costs twenty lines while a miss costs a white screen for somebody
    // with money in a pool, so it is here.
    //
    // The cure is a reload of the same address: index.html is served without
    // caching, so a fresh version arrives. We retry at most once a minute,
    // otherwise a real breakage would put the page in a loop.
    this.chunkErrorSubscription = this.router.events.pipe(
      filter((event): event is NavigationError => event instanceof NavigationError)
    ).subscribe((event) => {
      if (!isChunkLoadError(event.error) || !markChunkReload()) {
        return;
      }
      window.location.assign(event.url || window.location.href);
    });

    // A dialog lives over a page rather than over the site: leave the page and
    // the dialogs close. MatDialog's own `closeOnNavigation` only listens to
    // `Location`, that is the browser's back and forward buttons, and does not
    // fire on a routerLink navigation: from the sign-in dialog an "Open as a
    // page" link opened the document while the sign-in form stayed hanging over
    // it. A change of the fragment alone (#how) is scrolling within the same
    // page, and we leave dialogs alone for that.
    this.dialogNavigationSubscription = this.router.events.pipe(
      filter((event): event is NavigationStart => event instanceof NavigationStart),
      filter((event) => pathOf(event.url) !== pathOf(this.router.url))
    ).subscribe(() => {
      if (this.dialog.openDialogs.length > 0) {
        this.dialog.closeAll();
      }
    });

    this.walletSessionSubscription = this.walletService.walletAddress$.subscribe((address) => {
      // The person asked to switch wallets themselves: the same handler reissues
      // the session for the new address, and there is nothing to sign them out for.
      if (this.walletService.isSwitchingWallet) {
        return;
      }
      const linkedAddress = localStorage.getItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
      const token = localStorage.getItem('jwt');

      if (!token || !linkedAddress) {
        this.linkedWalletSeen = false;
        return;
      }

      if (!address) {
        if (!this.linkedWalletSeen) {
          return;
        }
        this.forceWalletLogout();
        return;
      }

      if (address === linkedAddress) {
        this.linkedWalletSeen = true;
        return;
      }

      this.forceWalletLogout();
    });
  }

  private signalFirstScreen(): void {
    requestAnimationFrame(() => requestAnimationFrame(() => markAppReady()));
  }

  private forceWalletLogout(): void {
    this.linkedWalletSeen = false;
    localStorage.removeItem('jwt');
    localStorage.removeItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
    this.store.dispatch(signOut());
    void this.router.navigate(['/']);
  }

  ngOnDestroy(): void {
    this.walletSessionSubscription?.unsubscribe();
    this.firstNavigationSubscription?.unsubscribe();
    this.dialogNavigationSubscription?.unsubscribe();
    this.chunkErrorSubscription?.unsubscribe();
  }
}

/** An app chunk failed to load: this is how a browser reports a missing file. */
function isChunkLoadError(error: unknown): boolean {
  const name = (error as { name?: string })?.name || '';
  const message = String((error as { message?: string })?.message || error || '');
  return name === 'ChunkLoadError'
    || /Loading chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(message);
}

/** One reload a minute: the page must not go into a loop. */
const CHUNK_RELOAD_KEY = 'pumpling:chunk-reload';
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;

function markChunkReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
    if (Number.isFinite(last) && Date.now() - last < CHUNK_RELOAD_COOLDOWN_MS) {
      return false;
    }
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    // Storage is closed by privacy settings: we reload blind.
    return true;
  }
}

/** The address with no fragment or query: we decide by it whether the page changed. */
function pathOf(url: string): string {
  return url.split('#')[0].split('?')[0];
}
