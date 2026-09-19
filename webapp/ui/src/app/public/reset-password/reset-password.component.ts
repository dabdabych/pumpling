import {ChangeDetectorRef, Component, OnInit} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpResponse} from '@angular/common/http';
import {NgForm} from '@angular/forms';
import {ActivatedRoute, Router} from '@angular/router';
import {environment} from '../../../environments/environment';
import {firstValueFrom} from 'rxjs';

type ResetStatus = 'form' | 'success' | 'error';

@Component({
  selector: 'app-reset-password',
  templateUrl: './reset-password.component.html',
  styleUrls: ['./reset-password.component.scss'],
  standalone: false
})
export class ResetPasswordComponent implements OnInit {
  status: ResetStatus = 'form';
  passwordVisible = false;
  password = '';
  token = '';
  errorMessage = '';

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {
  }

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') || '';
    if (!this.token) {
      this.setState('error', 'Password reset link is missing a token.');
    }
  }

  async resetPassword(form: NgForm): Promise<void> {
    if (!form.valid || !this.token) {
      return;
    }

    this.errorMessage = '';
    try {
      const response = await firstValueFrom(
        this.http.post<{ message: string }>(
          `${environment.apiUrl}/auth/reset-password`,
          {
            token: this.token,
            password: this.password
          },
          { observe: 'response' }
        )
      );
      this.handleResetResponse(response);
    } catch (error) {
      this.setState('error', this.resolveErrorMessage(error));
    }
  }

  togglePasswordVisibility(): void {
    this.passwordVisible = !this.passwordVisible;
  }

  async close(): Promise<void> {
    await this.router.navigate(['/']);
  }

  private handleResetResponse(response: HttpResponse<{ message: string }>): void {
    if (response.status >= 200 && response.status < 300) {
      this.setState('success');
      return;
    }
    this.setState('error', 'Password reset link is invalid or expired.');
  }

  private resolveErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse && typeof error.error?.detail === 'string') {
      return error.error.detail;
    }
    return 'Password reset link is invalid or expired.';
  }

  private setState(status: ResetStatus, errorMessage = ''): void {
    this.status = status;
    this.errorMessage = errorMessage;
    this.cdr.detectChanges();
  }
}
