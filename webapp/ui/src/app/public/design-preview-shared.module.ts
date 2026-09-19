import { NgModule } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { SharedModule } from '../shared/shared.module';
import { PumpCardAnimationComponent } from './design-preview/pump-card-animation.component';
import { DexCardAnimationComponent } from './design-preview/dex-card-animation.component';

@NgModule({
  declarations: [
    PumpCardAnimationComponent,
    DexCardAnimationComponent
  ],
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    ReactiveFormsModule,
    SharedModule,
    NgOptimizedImage
  ],
  exports: [
    PumpCardAnimationComponent,
    DexCardAnimationComponent
  ]
})
export class DesignPreviewSharedModule { }
