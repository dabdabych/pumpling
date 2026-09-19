import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';

import { Api } from '../api-client/api';
import { loginAuthLoginPost } from '../api-client/fn/auth/login-auth-login-post';
import { registerAuthRegisterPost } from '../api-client/fn/auth/register-auth-register-post';
import { environment } from '../../environments/environment';
import { isWalletFlowInterruption, WalletService } from '../shared/wallet.service';
import { rememberLinkedWallet } from '../shared/wallet-link';
import { signIn } from '../store/actions/auth';
import { IAppState } from '../store/state/app.state';

/**
 * Everything sign-in does, with no markup: email, wallet, registration, password
 * reset and human error texts. This used to live in three page components and in
 * the panel form, and the error texts drifted apart between them.
 */
@Injectable({ providedIn: 'root' })
export class AuthFlowService {
  constructor(
    private readonly api: Api,
    private readonly http: HttpClient,
    private readonly walletService: WalletService,
    private readonly store: Store<IAppState>
  ) {}

  async signInWithEmail(email: string, password: string, keepSignedIn: boolean): Promise<void> {
    const response = await firstValueFrom(this.api.invoke$Response(loginAuthLoginPost, {
      body: { username: email.trim(), password, remember_me: keepSignedIn }
    }));
    this.completeSignIn(response.body.access_token);
  }

  /**
   * Signing in with a wallet. It is registration too: the account is created on
   * the first signature. `false` means the person closed the wallet dialog or went
   * off to install an extension, which is not an error.
   */
  /**
   * @param chooser show the wallet list. Signing in is the moment of choosing, so
   * yes by default. No is for when a wallet has just been chosen somewhere else
   * and a second list would be a redundant question.
   */
  async signInWithWallet(chooser = true): Promise<boolean> {
    try {
      const address = await this.walletService.connect({ chooser });
      const challenge: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/auth/wallet/nonce`, { address }));
      const message = [
        `${challenge.domain} wants you to sign in with your wallet`,
        '',
        `Address: ${address}`,
        `Nonce: ${challenge.nonce}`,
        `Issued At: ${challenge.issued_at}`,
        `Expiration Time: ${challenge.expiration_time}`,
        `URI: ${challenge.uri}`,
        `Chain: ${challenge.chain}`
      ].join('\n');
      const signature = this.bytesToBase64(await this.walletService.signMessage(new TextEncoder().encode(message)));
      const token: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/auth/wallet/verify`, {
        address,
        message,
        signature,
        remember_me: true
      }));
      // The browser has to remember which wallet was used to sign in: by that
      // record a sign-out disconnects the wallet, and an address change in the
      // extension closes the session.
      rememberLinkedWallet(address);
      this.completeSignIn(token.access_token);
      return true;
    } catch (error) {
      if (isWalletFlowInterruption(error)) {
        return false;
      }
      throw error;
    }
  }

  async register(nickname: string, email: string, password: string): Promise<void> {
    await firstValueFrom(this.api.invoke$Response(registerAuthRegisterPost, {
      body: { username: email.trim(), email: email.trim(), password, nickname: nickname.trim() }
    }));
  }

  async requestPasswordReset(email: string): Promise<void> {
    await firstValueFrom(this.http.post(`${environment.apiUrl}/auth/request-password-reset`, { email: email.trim() }));
  }

  // ------------------------------------------------------------ error texts

  signInError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const detail = typeof error.error?.detail === 'string' ? error.error.detail : '';
      if (error.status === 0) {
        return 'No connection to the server. Check your internet and try again.';
      }
      if (error.status === 403 && detail === 'Email is not verified') {
        return 'Your email is not confirmed yet. Open the link we sent you, then sign in.';
      }
      if (error.status === 401) {
        return 'Wrong email or password.';
      }
    }
    return 'Sign in failed. Please try again.';
  }

  walletError(error: unknown): string {
    // The failure only went to the console, and a person saw a dialog that "did nothing".
    console.error('Wallet sign in failed', error);
    const text = error instanceof Error ? error.message : '';
    if (/reject|denied|cancel/i.test(text)) {
      return 'The signature request was rejected in the wallet.';
    }
    if (/not supported|no provider|not installed|not detected/i.test(text)) {
      return 'No Solana wallet found. Install Phantom or another Solana wallet and try again.';
    }
    return 'Wallet sign in failed. Please try again.';
  }

  registerError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const detail = typeof error.error?.detail === 'string' ? error.error.detail : '';
      if (error.status === 0) {
        return 'No connection to the server. Check your internet and try again.';
      }
      if (error.status === 409 || /exist|taken|already/i.test(detail)) {
        return /nickname/i.test(detail)
          ? 'This nickname is taken. Pick another one.'
          : 'An account with this email already exists. Sign in instead.';
      }
      // A 503 arrives with its own text: the confirmation email did not go out.
      if (detail) {
        return detail;
      }
    }
    return 'Could not create the account. Please try again.';
  }

  resetError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return 'No connection to the server. Check your internet and try again.';
      }
      if (typeof error.error?.detail === 'string') {
        return error.error.detail;
      }
    }
    return 'Could not send the reset link. Please try again.';
  }

  private completeSignIn(accessToken: string): void {
    localStorage.setItem('jwt', accessToken);
    this.store.dispatch(signIn());
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((byte) => binary += String.fromCharCode(byte));
    return btoa(binary);
  }
}
