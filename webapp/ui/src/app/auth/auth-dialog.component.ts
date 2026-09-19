import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

import { AuthFlowComponent, AuthMode, AuthView } from './auth-flow.component';

export interface AuthDialogData {
  mode?: AuthMode;
  view?: AuthView;
}

/**
 * Signing in as a dialog over the page. A person does not lose their place and
 * stays there afterwards. The dialog body, the backdrop and the bottom sheet mode
 * on a phone are set by the global `.auth-dialog-panel` styles in styles.scss:
 * MatDialog draws the overlay outside the component's encapsulation.
 */
@Component({
  selector: 'app-auth-dialog',
  standalone: true,
  imports: [AuthFlowComponent],
  template: `
    <div class="auth-dialog">
      <button type="button" class="auth-dialog__close" (click)="close()" aria-label="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <app-auth-flow [mode]="data.mode ?? 'sign-in'" [view]="data.view ?? 'methods'" (completed)="close()"></app-auth-flow>
    </div>
  `,
  styleUrls: ['./auth-dialog.component.scss']
})
export class AuthDialogComponent {
  constructor(
    private readonly dialogRef: MatDialogRef<AuthDialogComponent>,
    @Inject(MAT_DIALOG_DATA) readonly data: AuthDialogData
  ) {}

  close(): void {
    this.dialogRef.close();
  }
}
