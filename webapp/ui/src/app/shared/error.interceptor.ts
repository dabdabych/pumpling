import { HttpErrorResponse, HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import {Injectable} from '@angular/core';
import {Observable, throwError} from 'rxjs';
import {catchError} from 'rxjs/operators';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from './http-context-tokens';

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(req).pipe(catchError(err => {
      if (req.context.get(SUPPRESS_GLOBAL_ERROR_DIALOG)) {
        return throwError(() => err);
      }

      if (err instanceof HttpErrorResponse && err.status !== 401) {
        // HTTP failures can happen during wallet auth, polling, and transient backend
        // states. Never surface technical modal dialogs to public users.
        console.warn('HTTP request failed', {
          method: req.method,
          url: req.urlWithParams,
          status: err.status,
          message: this.extractErrorMessage(err),
        });
        return throwError(() => err);
      }
      return throwError(() => err);
    }));
  }

  private extractErrorMessage(err: HttpErrorResponse): string {
    // RFC 7807 Problem Details format
    // Priority 1: Check if error.error itself is a Problem Details object (has type and detail/title)
    if (err.error && typeof err.error === 'object') {
      // Standard Problem Details with 'detail' field
      if (err.error.type && err.error.detail && typeof err.error.detail === 'string') {
        return err.error.detail;
      }
      // Problem Details with 'title' as fallback
      if (err.error.type && err.error.title && typeof err.error.title === 'string') {
        return err.error.title;
      }
      // Check if detail is nested object (Problem Details inside detail)
      if (err.error.detail && typeof err.error.detail === 'object') {
        return err.error.detail.detail || err.error.detail.title || 'An error occurred';
      }
      // Simple string in detail field
      if (err.error.detail && typeof err.error.detail === 'string') {
        return err.error.detail;
      }
    }

    // Fallback to HTTP error message
    return 'An error occurred';
  }
}
