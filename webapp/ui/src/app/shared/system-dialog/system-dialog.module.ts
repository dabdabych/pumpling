import {NgModule} from '@angular/core';
import {MatDialogModule} from '@angular/material/dialog';
import {MatInputModule} from '@angular/material/input';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {MatFormFieldModule} from '@angular/material/form-field';
import {CommonModule} from '@angular/common';
import {FormsModule, ReactiveFormsModule} from '@angular/forms';

import {SystemDialog} from './system-dialog';
import {InfoDialogComponent} from './info-dialog/info-dialog.component';
import {ConfirmationDialogComponent} from './confirmation-dialog/confirmation-dialog.component';
import {WalletConnectDialogComponent} from './wallet-connect-dialog/wallet-connect-dialog.component';

@NgModule({
    imports: [
        MatDialogModule,
        MatInputModule,
        MatButtonModule,
        MatIconModule,
        MatFormFieldModule,
        CommonModule,
        FormsModule,
        ReactiveFormsModule
    ],
    declarations: [
      InfoDialogComponent,
      ConfirmationDialogComponent,
      WalletConnectDialogComponent
    ],
    providers: [
        SystemDialog
    ]
})
export class SystemDialogModule {
}
