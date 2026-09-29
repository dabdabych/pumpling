import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpResponse} from '@angular/common/http';
import {ActivatedRoute, Router} from '@angular/router';
import {environment} from '../../../environments/environment';
import {firstValueFrom} from 'rxjs';
import {AuthFlowService} from '../../auth/auth-flow.service';

type ConfirmationStatus = 'pending' | 'success' | 'error';

@Component({
  selector: 'app-confirm-email',
  templateUrl: './confirm-email.component.html',
  styleUrls: ['./confirm-email.component.scss'],
  standalone: false
})
export class ConfirmEmailComponent implements OnInit {
  status: ConfirmationStatus = 'pending';
  message = 'Confirming your email...';

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private auth: AuthFlowService
  ) {
  }

  ngOnInit(): void {
    void this.confirmEmail();
  }

  private async confirmEmail(): Promise<void> {
    const token = this.route.snapshot.queryParamMap.get('token') || '';
    if (!token) {
      this.setState('error', 'Confirmation link is missing a token.');
      return;
    }

    try {
      const response = await firstValueFrom(
        this.http.post<{ email: string; message: string; access_token?: string | null }>(
          `${environment.apiUrl}/auth/confirm-email`,
          { token },
          { observe: 'response' }
        )
      );
      this.handleConfirmationResponse(response);
    } catch (error) {
      this.setState('error', this.resolveErrorMessage(error));
    }
  }

  async close(): Promise<void> {
    await this.router.navigate(['/']);
  }

  private handleConfirmationResponse(
    response: HttpResponse<{ email: string; message: string; access_token?: string | null }>
  ): void {
    if (response.status < 200 || response.status >= 300) {
      this.setState('error', 'Confirmation link is invalid or expired.');
      return;
    }

    const session = response.body?.access_token;
    if (!session) {
      // Confirmed, but no session came back. Rare, and the sign-in screen is
      // still a way in, so say so rather than leaving the page blank.
      this.setState('success', 'Your email is confirmed. You can sign in now.');
      return;
    }

    // Signed in and straight to the site. Stopping here to say "now go and
    // sign in" is a step that proves nothing: opening this link already did.
    this.auth.adoptSession(session);
    this.setState('success', 'Your email is confirmed. Taking you in…');
    void this.router.navigate(['/']);
  }

  private resolveErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse && typeof error.error?.detail === 'string') {
      return error.error.detail;
    }
    return 'Confirmation link is invalid or expired.';
  }

  private setState(status: ConfirmationStatus, message: string): void {
    this.status = status;
    this.message = message;
    this.cdr.detectChanges();
  }
}
