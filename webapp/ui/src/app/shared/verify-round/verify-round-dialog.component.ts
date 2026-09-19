import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';

import { RoundVerification, VerifyRoundService } from './verify-round.service';

export interface VerifyRoundDialogData {
  lotteryId: number;
}

/**
 * "Verify this round" — a dialog for anyone who does not want to take our word.
 *
 * It shows the three things the whole verification is made of: the weights
 * commitment together with its preimage, the source of the randomness and the
 * fingerprint of the shares algorithm. None of it has to be taken on faith: next
 * to it are a link to the same data in machine-readable form and a link to the
 * instructions for recomputing it all yourself.
 *
 * A dialog rather than a block on the page: there are many fields and a minority
 * reads them. The button sits in the footer next to the addresses — a place for
 * the doubtful rather than for everyone.
 */
@Component({
  selector: 'app-verify-round-dialog',
  standalone: true,
  templateUrl: './verify-round-dialog.component.html',
  styleUrls: ['./verify-round-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class VerifyRoundDialogComponent {
  data: RoundVerification | null = null;
  loading = true;
  failed = false;
  copied: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public readonly input: VerifyRoundDialogData,
    private readonly dialogRef: MatDialogRef<VerifyRoundDialogComponent>,
    private readonly verify: VerifyRoundService,
    private readonly cdr: ChangeDetectorRef
  ) {
    void this.load();
  }

  static open(dialog: MatDialog, lotteryId: number): MatDialogRef<VerifyRoundDialogComponent> {
    const phone = window.matchMedia('(max-width: 599px)').matches;
    return dialog.open<VerifyRoundDialogComponent, VerifyRoundDialogData>(VerifyRoundDialogComponent, {
      data: { lotteryId },
      panelClass: ['auth-dialog-panel', phone ? 'auth-dialog-panel--sheet' : 'auth-dialog-panel--center'],
      backdropClass: 'auth-dialog-backdrop',
      width: phone ? '100vw' : 'min(560px, calc(100vw - 32px))',
      maxWidth: '100vw',
      position: phone ? { bottom: '0' } : { top: 'max(24px, 8vh)' },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      ariaLabelledBy: 'verify-dialog-title'
    });
  }

  get jsonUrl(): string {
    return this.verify.jsonUrl(this.input.lotteryId);
  }

  get docsUrl(): string {
    return this.verify.docsUrl;
  }

  /** A short address: the start and the end, as everywhere on the site. */
  short(value: string | null | undefined): string {
    const text = (value || '').trim();
    return text.length > 16 ? `${text.slice(0, 6)}…${text.slice(-6)}` : text;
  }

  async copy(value: string | null | undefined, key: string): Promise<void> {
    const text = (value || '').trim();
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.copied = key;
      this.cdr.markForCheck();
      setTimeout(() => {
        this.copied = null;
        this.cdr.markForCheck();
      }, 1600);
    } catch {
      // The clipboard is closed by settings: the value is visible anyway and can be selected.
    }
  }

  close(): void {
    this.dialogRef.close();
  }

  private async load(): Promise<void> {
    try {
      this.data = await this.verify.load(this.input.lotteryId);
    } catch {
      this.failed = true;
    } finally {
      this.loading = false;
      this.cdr.markForCheck();
    }
  }
}
