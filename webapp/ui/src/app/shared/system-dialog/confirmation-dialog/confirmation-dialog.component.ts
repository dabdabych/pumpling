import {ChangeDetectionStrategy, Component, Inject, TemplateRef} from '@angular/core';

import {MAT_DIALOG_DATA} from '@angular/material/dialog';

@Component({
    templateUrl: './confirmation-dialog.component.html',
    styleUrls: ['./confirmation-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class ConfirmationDialogComponent {
  constructor(
    @Inject(MAT_DIALOG_DATA) public data: {
      message: TemplateRef<any>,
      confirm: { title: string, color: any },
      cancel: { title: string, color: any },
      [x: string]: any;
    }
  ) {
  }

  isString(val): boolean {
    return typeof val === 'string';
  }
}
