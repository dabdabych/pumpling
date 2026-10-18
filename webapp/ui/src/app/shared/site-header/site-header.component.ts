import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { JwtHelperService } from '@auth0/angular-jwt';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';

import { AuthDialogService } from '../../auth/auth-dialog.service';
import { ChatLauncherComponent } from '../../chat/chat-launcher/chat-launcher.component';
import { MascotLogoComponent } from '../../public/main-page/mascot/mascot-logo.component';
import { HeaderNavComponent } from './header-nav.component';
import { signOut } from '../../store/actions/auth';
import { authSelector } from '../../store/selectors/auth';
import { IAppState } from '../../store/state/app.state';
import { SignOutConfirm, SystemDialog } from '../system-dialog';
import { WalletService } from '../wallet.service';
import { WALLET_LINKED_ADDRESS_STORAGE_KEY } from '../wallet-link';


/**
 * The header of the inner pages: the pumpling mark, the links (How it works,
 * Past pools, My commits when signed in), the chat, X and sign-in. The same
 * border, shadow and buttons as the main page header, but with no marquee and no
 * section menu — those are about the story on the main page, and here somebody
 * has already arrived on business. My commits sits with the other links now:
 * without a link a person does not know their participation is recorded
 * anywhere, and in the bar it no longer fitted a phone beside the chat.
 */
@Component({
  selector: 'app-site-header',
  standalone: true,
  imports: [MascotLogoComponent, HeaderNavComponent, ChatLauncherComponent],
  templateUrl: './site-header.component.html',
  styleUrls: ['./site-header.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SiteHeaderComponent implements OnInit, OnDestroy {
  isAuthenticated = false;
  busy = false;

  private authSubscription?: Subscription;

  constructor(
    private readonly store: Store<IAppState>,
    private readonly jwtHelper: JwtHelperService,
    private readonly authDialog: AuthDialogService,
    private readonly systemDialog: SystemDialog,
    private readonly wallet: WalletService,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.authSubscription = this.store.select(authSelector).subscribe((signedIn) => {
      this.isAuthenticated = signedIn && this.hasValidToken();
      if (signedIn && !this.isAuthenticated) {
        // The token expired while the tab was closed.
        this.clearSession();
      }
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.authSubscription?.unsubscribe();
  }

  async onAuthClick(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!this.isAuthenticated) {
      this.authDialog.open({ mode: 'sign-in' });
      return;
    }
    const confirmed = await this.systemDialog.confirm('You can sign back in with your email or wallet at any time.', SignOutConfirm);
    if (!confirmed) {
      return;
    }
    this.busy = true;
    this.cdr.markForCheck();
    try {
      // We always disconnect, not only when a wallet was used to sign in.
      // Otherwise a live connection stays in the page after signing out, and the
      // next wallet sign-in silently takes that same one: switching wallets was impossible.
      await this.wallet.disconnect().catch(() => undefined);
    } finally {
      this.clearSession();
      this.busy = false;
      this.cdr.markForCheck();
    }
  }

  private hasValidToken(): boolean {
    const token = localStorage.getItem('jwt');
    return !!token && !this.jwtHelper.isTokenExpired(token);
  }

  private clearSession(): void {
    localStorage.removeItem('jwt');
    localStorage.removeItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
    this.isAuthenticated = false;
    this.store.dispatch(signOut());
  }
}
