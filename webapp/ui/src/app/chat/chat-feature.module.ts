import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';

import { ChatComponent } from './chat.component';

@NgModule({
  declarations: [ChatComponent],
  imports: [CommonModule, FormsModule, RouterModule],
  exports: [ChatComponent],
})
export class ChatFeatureModule {}
