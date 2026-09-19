import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Inject, NgZone, OnDestroy, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

import type { WalletChoice, SupportedWalletName } from '../../wallet.service';

export type WalletConnectDialogResult =
  | {
      action: 'connect';
      walletName: SupportedWalletName;
    }
  | {
      action: 'external';
      walletName: SupportedWalletName;
      externalUrl: string;
    };

@Component({
  templateUrl: './wallet-connect-dialog.component.html',
  styleUrls: ['./wallet-connect-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class WalletConnectDialogComponent implements OnInit, OnDestroy {
  private rescanTimer = 0;
  private settleTimer = 0;
  /** The list may still grow: extensions do not appear at the same time. */
  settling = true;
  private readonly onInjection = () => this.rescan();

  /** What to write on a wallet row right now. */
  label(wallet: WalletChoice): string {
    if (this.pending(wallet)) {
      return 'Checking…';
    }
    // It shows what we are using now: otherwise a person does not understand
    // that the choice changes anything and is afraid to press a neighbour.
    return wallet.connected ? 'Connected' : wallet.actionLabel;
  }

  /** A row with no wallet cannot be pressed until we have finished looking: they would miss. */
  pending(wallet: WalletChoice): boolean {
    return this.settling && !wallet.connectable;
  }

  constructor(
    @Inject(MAT_DIALOG_DATA)
    public readonly data: {
      wallets: WalletChoice[];
      /** Rebuild the list: an extension may have appeared with the dialog already open. */
      refresh?: () => WalletChoice[];
      rescanMs?: number;
      settleMs?: number;
      injectionEvents?: string[];
    },
    private readonly dialogRef: MatDialogRef<WalletConnectDialogComponent, WalletConnectDialogResult | undefined>,
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly zone: NgZone
  ) {}

  /**
   * The wallet list stays live while the dialog is open.
   *
   * An extension injects itself into the page and does not always manage it
   * before somebody presses "connect". The dialog used to show a snapshot from the
   * moment it opened, and an installed wallet stayed "Not detected" forever — only
   * closing and reopening helped.
   */
  ngOnInit(): void {
    if (typeof window === 'undefined' || !this.data.refresh) {
      return;
    }
    for (const name of this.data.injectionEvents ?? []) {
      window.addEventListener(name, this.onInjection);
    }
    // Outside the Angular zone: this is a background check and there is no reason
    // to trigger change detection on every tick — it is called only when the list changed.
    this.zone.runOutsideAngular(() => {
      this.rescanTimer = window.setInterval(() => this.rescan(), this.data.rescanMs ?? 400);
      this.settleTimer = window.setTimeout(() => {
        this.zone.run(() => {
          this.settling = false;
          this.changeDetectorRef.markForCheck();
        });
      }, this.data.settleMs ?? 1600);
    });
  }

  ngOnDestroy(): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.clearInterval(this.rescanTimer);
    window.clearTimeout(this.settleTimer);
    for (const name of this.data.injectionEvents ?? []) {
      window.removeEventListener(name, this.onInjection);
    }
  }

  private rescan(): void {
    const next = this.data.refresh?.();
    if (!next) {
      return;
    }
    // The list changes by more than the state of its rows: a Wallet Standard
    // wallet can add a whole row, so we compare the whole list.
    const signature = (wallets: WalletChoice[]) =>
      wallets.map((w) => `${w.name}:${w.detected}:${w.connectable}:${w.connected}:${w.actionLabel}`).join('|');
    if (signature(next) === signature(this.data.wallets)) {
      return;
    }
    this.zone.run(() => {
      this.data.wallets = next;
      this.changeDetectorRef.markForCheck();
    });
  }

  trackWallet(_: number, wallet: WalletChoice): SupportedWalletName {
    return wallet.name;
  }

  selectWallet(wallet: WalletChoice): void {
    if (this.pending(wallet)) {
      return;
    }
    if (wallet.actionLabel === 'Connect') {
      this.dialogRef.close({
        action: 'connect',
        walletName: wallet.name,
      });
      return;
    }

    if (!wallet.externalUrl) {
      return;
    }

    this.dialogRef.close({
      action: 'external',
      walletName: wallet.name,
      externalUrl: wallet.externalUrl,
    });
  }
}
