import { Injectable } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';

import { AuthDialogComponent, AuthDialogData } from './auth-dialog.component';

/** Opens sign-in as a dialog from anywhere: the main page header, the chat. */
@Injectable({ providedIn: 'root' })
export class AuthDialogService {
  private ref: MatDialogRef<AuthDialogComponent> | null = null;

  constructor(private readonly dialog: MatDialog) {}

  open(data: AuthDialogData = {}): MatDialogRef<AuthDialogComponent> {
    // A second press while the dialog is open must not open a second dialog.
    if (this.ref) {
      return this.ref;
    }
    const phone = window.matchMedia('(max-width: 599px)').matches;
    this.ref = this.dialog.open(AuthDialogComponent, {
      data,
      panelClass: ['auth-dialog-panel', phone ? 'auth-dialog-panel--sheet' : 'auth-dialog-panel--center'],
      backdropClass: 'auth-dialog-backdrop',
      width: phone ? '100vw' : 'min(440px, calc(100vw - 32px))',
      maxWidth: '100vw',
      // At the top rather than centred: the dialog changes height between steps,
      // and centred it would jump up and down. This way it only grows downwards.
      position: phone ? { bottom: '0' } : { top: 'max(24px, 11vh)' },
      autoFocus: 'first-heading',
      restoreFocus: true,
      ariaLabelledBy: 'auth-flow-title'
    });
    this.ref.afterClosed().subscribe(() => {
      this.ref = null;
    });
    return this.ref;
  }
}
