import {Injectable, TemplateRef} from '@angular/core';

import {MatDialog} from '@angular/material/dialog';

import {InfoDialogComponent} from './info-dialog/info-dialog.component';
import {ConfirmationDialogComponent} from './confirmation-dialog/confirmation-dialog.component';

export interface DialogOptions {
  confirm?: string | { title: string, color: any };
  cancel?: string | { title: string, color: any };

  [x: string]: any;
}

export const DeleteConfirm: DialogOptions = {
  confirm: {title: 'Delete', color: 'warn'}
};

export const SignOutConfirm: DialogOptions = {
  title: 'Sign out?',
  confirm: {title: 'Sign out', color: 'accent'}
};

export const CloseLotteryConfirm: DialogOptions = {
  confirm: {title: 'Close Lottery', color: 'warn'}
};

@Injectable()
export class SystemDialog {
  constructor(
    private readonly dialog: MatDialog
  ) {
  }

  async confirm(message: string | TemplateRef<any>, options?: DialogOptions): Promise<boolean> {
    const result = await this.dialog.open(ConfirmationDialogComponent, {
      panelClass: 'qres-confirm-panel',
      backdropClass: 'qres-confirm-backdrop',
      maxWidth: '100vw',
      ariaLabelledBy: 'qres-confirm-title',
      data: {
        message,
        ...this.normalizeOptions(options)
      }
    }).beforeClosed().toPromise();
    return result || false;
  }

  async info(message: string): Promise<void> {
    await this.dialog.open(InfoDialogComponent, {data: message}).beforeClosed().toPromise();
  }

  private normalizeOptions(options: DialogOptions | undefined): any {
    const defaultOptions = {
      confirm: {
        title: 'Confirm',
        color: 'info'
      },
      cancel: {
        title: 'Cancel',
        color: undefined
      }
    };

    if (!options) {
      return defaultOptions;
    }

    options.confirm = Object.assign(defaultOptions.confirm, typeof options.confirm === 'string' ? {title: options.confirm} : options.confirm);
    options.cancel = Object.assign(defaultOptions.cancel, typeof options.cancel === 'string' ? {title: options.cancel} : options.cancel);
    return options;
  }
}
