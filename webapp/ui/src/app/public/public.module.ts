import { NgModule } from '@angular/core';
import {CommonModule, NgOptimizedImage} from '@angular/common';
import {RouterModule} from "@angular/router";
import { SignInComponent } from './sign-in/sign-in.component';
import { AuthFlowComponent } from '../auth/auth-flow.component';
import { StoryWhatComponent } from './main-page/story/story-what.component';
import { StoryHowComponent } from './main-page/story/story-how.component';
import { MascotLogoComponent } from './main-page/mascot/mascot-logo.component';
import {FormsModule, ReactiveFormsModule} from "@angular/forms";
import {RootComponent} from "./root.component";
import { TermsOfUseComponent } from './terms-of-use/terms-of-use.component';
import { PrivacyPolicyComponent } from './privacy-policy/privacy-policy.component';
import {SharedModule} from "../shared/shared.module";
import {LegalModule} from "../shared/legal";
import { MainPageComponent } from './main-page/main-page.component';
import { PoolPageComponent } from '../pool/pool-page/pool-page.component';
import { DesignPreviewSharedModule } from './design-preview-shared.module';
import { EmailConfirmationSentComponent } from './email-confirmation-sent/email-confirmation-sent.component';
import { ConfirmEmailComponent } from './confirm-email/confirm-email.component';
import { ResetPasswordComponent } from './reset-password/reset-password.component';
import { ChatFeatureModule } from '../chat/chat-feature.module';
import { ComingSoonComponent } from './coming-soon/coming-soon.component';


@NgModule({
  declarations: [
    SignInComponent,
    RootComponent,
    TermsOfUseComponent,
    PrivacyPolicyComponent,
    MainPageComponent,
    EmailConfirmationSentComponent,
    ConfirmEmailComponent,
    ResetPasswordComponent,
    ComingSoonComponent
  ],
  imports: [
    CommonModule,
    RouterModule.forChild([
      {
        path: '',
        component: RootComponent,
        children: [
          {
            // The ordinary main page: the pool card, the chat and the scroll screens.
            // The pre-launch placeholder (ComingSoonComponent) stayed on /soon —
            // putting it back on the root is a matter of changing component here.
            path: '',
            component: MainPageComponent
          },
          {
            path: 'soon',
            component: ComingSoonComponent
          },
          {
            path: 'home',
            component: MainPageComponent
          },
          {
            // The pool. A commit is a dialog on this same page, it has no page of its own.
            path: 'pool',
            component: PoolPageComponent
          },
          {
            // Old addresses: /lottery/dex and /lottery/pumpfun were the pool page,
            // /make-bet was the commit form. Links to them may still exist out there.
            path: 'lottery/:market',
            redirectTo: 'pool'
          },
          {
            path: 'make-bet',
            redirectTo: 'pool'
          },
          {
            // Round history. The link lives in the footer: it is evidence rather
            // than a main path for a user.
            path: 'archive',
            loadComponent: () => import('../archive/archive-page.component').then((m) => m.ArchivePageComponent)
          },
          {
            // My commits. The page shows a sign-in itself when somebody is not
            // signed in, so we do not put a guard on it: that way it is clearer why to sign in.
            path: 'me',
            loadComponent: () => import('../me/my-page.component').then((m) => m.MyPageComponent)
          },
          {
            path: 'sign-in',
            component: SignInComponent,
            data: { authMode: 'sign-in', authView: 'email-sign-in' }
          },
          {
            path: 'sign-up',
            component: SignInComponent,
            data: { authMode: 'sign-up', authView: 'email-sign-up' }
          },
          {
            path: 'email-confirmation-sent',
            component: EmailConfirmationSentComponent
          },
          {
            path: 'confirm-email',
            component: ConfirmEmailComponent
          },
          {
            path: 'forgot-password',
            component: SignInComponent,
            data: { authMode: 'sign-in', authView: 'forgot' }
          },
          {
            path: 'reset-password',
            component: ResetPasswordComponent
          },
          {
            path: 'terms',
            component: TermsOfUseComponent
          },
          {
            path: 'privacy-policy',
            component: PrivacyPolicyComponent
          }
        ]
      }
    ]),
    FormsModule,
    ReactiveFormsModule,
    SharedModule,
    LegalModule,
    ChatFeatureModule,
    DesignPreviewSharedModule,
    NgOptimizedImage,
    AuthFlowComponent,
    StoryWhatComponent,
    StoryHowComponent,
    MascotLogoComponent
  ]
})
export class PublicModule { }
