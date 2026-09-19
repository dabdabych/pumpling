import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import {AdminAuthGuard} from "./shared/admin.auth.guard";

const routes: Routes = [{
  path: '',
  loadChildren: () => import('./public/public.module').then(module => module.PublicModule)
},{
  path: 'chat',
  loadChildren: () => import('./chat/chat.module').then(module => module.ChatModule)
},{
  path: 'admin',
  loadChildren: () => import('./admin/admin.module').then(module => module.AdminModule),
  canActivate: [AdminAuthGuard]
}];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
