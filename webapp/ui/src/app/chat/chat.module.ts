import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';

import { ChatComponent } from './chat.component';
import { ChatFeatureModule } from './chat-feature.module';

@NgModule({
  imports: [
    ChatFeatureModule,
    RouterModule.forChild([{ path: '', component: ChatComponent }]),
  ],
})
export class ChatModule {}
