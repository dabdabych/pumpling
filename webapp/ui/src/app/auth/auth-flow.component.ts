import { ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule, NgForm, ValidationErrors } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';

import { AuthFlowService } from './auth-flow.service';
import { PasswordValidatorDirective } from '../shared/directives/password-validator.directive';
import { PASSWORD_RULES_TEXT } from '../shared/password-rules';
import { LegalDialogComponent, LegalDocument } from '../shared/legal/legal-dialog.component';

export type AuthMode = 'sign-in' | 'sign-up';
export type AuthView = 'methods' | 'email-sign-in' | 'email-sign-up' | 'forgot' | 'reset-sent' | 'confirm-sent';

let instanceCount = 0;

/** Matches CONFIRMATION_RESEND_COOLDOWN_SECONDS on the server. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * The whole sign-in as one flow: choosing a method, email, registration,
 * password reset and the "check your email" screens. With no border of its own —
 * that comes from whoever shows the flow: a dialog over the page or the
 * `/sign-in` page. So sign-in has one markup and one logic wherever it opens.
 */
@Component({
  selector: 'app-auth-flow',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, PasswordValidatorDirective],
  templateUrl: './auth-flow.component.html',
  styleUrls: ['./auth-flow.component.scss']
})
export class AuthFlowComponent implements OnInit, OnDestroy {
  @Input() mode: AuthMode = 'sign-in';
  @Input() view: AuthView = 'methods';

  /** Where we came into registration from: that is where "Back" leads. */
  private signUpReturnView: AuthView = 'methods';

  /** Signed in: the token is stored and the state broadcast. */
  @Output() completed = new EventEmitter<void>();

  /** The prefix for field ids: labels have to point at their own fields. */
  readonly uid = `auth-${++instanceCount}`;

  email = '';
  password = '';
  nickname = '';
  keepSignedIn = true;
  passwordVisible = false;
  submitting = false;
  walletBusy = false;
  error = '';

  /** What the field says before anything is typed: the rule, not a complaint. */
  readonly passwordRules = PASSWORD_RULES_TEXT;

  /** Seconds left before the confirmation email can be asked for again. */
  resendIn = 0;
  resendBusy = false;
  resendNote = '';
  /** Sign-in refused because the address has not been confirmed yet. */
  needsConfirmation = false;
  private resendTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly auth: AuthFlowService,
    private readonly dialog: MatDialog,
    private readonly host: ElementRef<HTMLElement>,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Registration goes straight to the form: it has no method choice, and a
    // wallet creates an account on the first signature and lives on the sign-in screen.
    if (this.mode === 'sign-up' && this.view === 'methods') {
      this.view = 'email-sign-up';
    }
  }

  go(view: AuthView, mode: AuthMode = this.mode): void {
    if (view === 'email-sign-up' && (this.view === 'methods' || this.view === 'email-sign-in')) {
      this.signUpReturnView = this.view;
    }
    this.view = view;
    this.mode = mode;
    this.error = '';
    this.resendNote = '';
    this.needsConfirmation = false;
    this.password = '';
    this.passwordVisible = false;
    this.cdr.detectChanges();
    // Focus moves into the new step: otherwise it stayed on a pressed button
    // that no longer exists, and the keyboard and screen reader lost their place.
    const target = this.host.nativeElement.querySelector<HTMLElement>('[data-autofocus]')
      ?? this.host.nativeElement.querySelector<HTMLElement>('#auth-flow-title');
    target?.focus();
  }

  back(): void {
    if (this.view === 'forgot') {
      this.go('email-sign-in', 'sign-in');
      return;
    }
    this.go(this.view === 'email-sign-up' ? this.signUpReturnView : 'methods', 'sign-in');
  }

  async submitSignIn(form: NgForm): Promise<void> {
    if (!this.startSubmit(form)) {
      return;
    }
    try {
      await this.auth.signInWithEmail(this.email, this.password, this.keepSignedIn);
      this.completed.emit();
    } catch (error) {
      this.error = this.auth.signInError(error);
      this.needsConfirmation = this.auth.isEmailNotConfirmed(error);
    } finally {
      this.finishSubmit();
    }
  }

  async submitSignUp(form: NgForm): Promise<void> {
    if (!this.startSubmit(form)) {
      return;
    }
    try {
      await this.auth.register(this.nickname, this.email, this.password);
      this.submitting = false;
      this.go('confirm-sent', 'sign-in');
    } catch (error) {
      this.error = this.auth.registerError(error);
    } finally {
      this.finishSubmit();
    }
  }

  async submitForgot(form: NgForm): Promise<void> {
    if (!this.startSubmit(form)) {
      return;
    }
    try {
      await this.auth.requestPasswordReset(this.email);
      this.submitting = false;
      this.go('reset-sent', 'sign-in');
    } catch (error) {
      this.error = this.auth.resetError(error);
    } finally {
      this.finishSubmit();
    }
  }

  async continueWithWallet(): Promise<void> {
    if (this.walletBusy) {
      return;
    }
    this.walletBusy = true;
    this.error = '';
    try {
      if (await this.auth.signInWithWallet()) {
        this.completed.emit();
      }
    } catch (error) {
      this.error = this.auth.walletError(error);
    } finally {
      this.walletBusy = false;
      // The wallet dialog closes outside the Angular zone, and without an
      // explicit refresh the button stayed in its waiting state forever.
      this.cdr.detectChanges();
    }
  }

  /**
   * Ask for the confirmation link again.
   *
   * Before this the only way out of an unconfirmed account was to register
   * again with the same address, which happens to work and which nothing said.
   * The server answers the same whether or not the address has an account, so
   * this cannot be used to find out who has registered, and the countdown is
   * the server's own cooldown rather than a guess.
   */
  async resendConfirmation(): Promise<void> {
    if (this.resendBusy || this.resendIn > 0) {
      return;
    }
    this.resendBusy = true;
    this.resendNote = '';
    this.error = '';
    try {
      await this.auth.resendConfirmation(this.email);
      this.resendNote = 'Sent. Check your inbox, and the spam folder.';
      this.startResendCountdown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      const wait = this.auth.resendRetryAfter(error);
      if (wait) {
        this.startResendCountdown(wait);
        this.resendNote = 'We just sent one. Give it a moment.';
      } else {
        this.error = this.auth.resendError(error);
      }
    } finally {
      this.resendBusy = false;
      this.cdr.detectChanges();
    }
  }

  private startResendCountdown(seconds: number): void {
    this.stopResendCountdown();
    this.resendIn = seconds;
    this.resendTimer = setInterval(() => {
      this.resendIn -= 1;
      if (this.resendIn <= 0) {
        this.stopResendCountdown();
      }
      this.cdr.detectChanges();
    }, 1000);
  }

  private stopResendCountdown(): void {
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = undefined;
    }
    this.resendIn = 0;
  }

  ngOnDestroy(): void {
    // The flow lives in a dialog that can be closed mid-countdown.
    this.stopResendCountdown();
  }

  /** The legal text as a dialog: navigating to a page would lose the filled-in form. */
  openLegal(document: LegalDocument): void {
    LegalDialogComponent.open(this.dialog, document);
  }

  /** The one thing wrong with the password, ready to render. */
  passwordProblem(errors: ValidationErrors | null): string {
    return (errors?.['password'] as string) ?? '';
  }

  /** A second press while a request was in flight used to send a second request. */
  private startSubmit(form: NgForm): boolean {
    if (this.submitting) {
      return false;
    }
    this.error = '';
    if (form.invalid) {
      form.form.markAllAsTouched();
      // First render the errors, then look for the first field with one.
      this.cdr.detectChanges();
      this.host.nativeElement.querySelector<HTMLElement>('.field--invalid input')?.focus();
      return false;
    }
    this.submitting = true;
    return true;
  }

  private finishSubmit(): void {
    this.submitting = false;
    this.cdr.detectChanges();
  }
}
