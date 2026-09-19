import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

import { PrivacyPolicyContentComponent } from './privacy-policy-content.component';
import { LegalDialogComponent } from './legal-dialog.component';
import { TermsContentComponent } from './terms-content.component';

/**
 * The legal texts and the dialog for them. Imported from PublicModule — nothing
 * else needs it yet, and dragging it through SharedModule would hand these two
 * components to the admin area and the dashboard, which have no use for them.
 *
 * MatDialogModule is not needed here: the dialog template has not a single
 * material directive, and MatDialogRef arrives through DI from whoever opened it.
 */
@NgModule({
  declarations: [
    PrivacyPolicyContentComponent,
    LegalDialogComponent,
    TermsContentComponent
  ],
  imports: [
    CommonModule,
    RouterModule
  ],
  exports: [
    PrivacyPolicyContentComponent,
    TermsContentComponent
  ]
})
export class LegalModule {
}
