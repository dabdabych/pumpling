import {ChangeDetectionStrategy, Component, Inject, TemplateRef} from '@angular/core';

import {MAT_DIALOG_DATA, MatDialogRef} from '@angular/material/dialog';

@Component({
    templateUrl: './info-dialog.component.html',
    styleUrls: ['./info-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class InfoDialogComponent {
  constructor(
    public dialogRef: MatDialogRef<InfoDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: {
      message: TemplateRef<any>,
      confirm: { title: string, color: any },
      cancel: { title: string, color: any },
      [x: string]: any;
    }
  ) {
  }

  onSubmit(): void {
    this.dialogRef.close(true);
  }

  onCancel(): void {
    this.dialogRef.close(false);
  }
}
