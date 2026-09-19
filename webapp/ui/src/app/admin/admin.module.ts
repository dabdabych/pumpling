import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { LotteriesComponent } from './lotteries/lotteries.component';
import {RouterModule} from "@angular/router";
import { RootComponent } from './root.component';
import { UsersComponent } from './users/users.component';
import { CreateLotteryComponent } from './create-lottery/create-lottery.component';
import { LotteryDetailsComponent } from './lottery-details/lottery-details.component';
import {SharedModule} from "../shared/shared.module";
import { SmartContractEventsComponent } from './smart-contract-events/smart-contract-events.component';


@NgModule({
  declarations: [
    LotteriesComponent,
    RootComponent,
    UsersComponent,
    CreateLotteryComponent,
    LotteryDetailsComponent,
    SmartContractEventsComponent
  ],
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    SharedModule,
    RouterModule.forChild([
      {
        path: '',
        component: RootComponent,
        children: [
          {
            path: '',
            redirectTo: 'lotteries',
            pathMatch: 'full'
          },
          {
            path: 'lotteries',
            component: LotteriesComponent
          },
          {
            path: 'lotteries/:id',
            component: LotteryDetailsComponent
          },
          {
            path: 'create-lottery',
            component: CreateLotteryComponent
          },
          {
            path: 'users',
            component: UsersComponent
          },
          {
            path: 'smart-contract-events',
            component: SmartContractEventsComponent
          }
        ]
      }])
  ]
})
export class AdminModule { }
