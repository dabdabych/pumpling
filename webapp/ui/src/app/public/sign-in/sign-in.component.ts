import { Component } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthHelper } from '../../helpers/auth.helper';
import { AuthMode, AuthView } from '../../auth/auth-flow.component';

/**
 * The sign-in, registration and password reset page. The flow itself is
 * `AuthFlowComponent`, the same as in the sign-in dialog; here there is only the
 * layout with the brand mark and where to go after signing in. Which step to open
 * is set by the route through `data`.
 *
 * The routes are needed in their own right, quite apart from the dialog: emails,
 * direct links and protected sections send people here with a `returnUrl`.
 */
@Component({
  selector: 'app-sign-in',
  templateUrl: './sign-in.component.html',
  styleUrls: ['./sign-in.component.scss'],
  standalone: false
})
export class SignInComponent {
  readonly mode: AuthMode;
  readonly view: AuthView;

  constructor(private router: Router, private route: ActivatedRoute) {
    this.mode = route.snapshot.data['authMode'] ?? 'sign-in';
    this.view = route.snapshot.data['authView'] ?? 'email-sign-in';
  }

  async navigateAfterSignIn(): Promise<void> {
    // Wherever somebody came from is where we send them back. That is how
    // signing in from the chat works: it passes a returnUrl and the person lands
    // back in the conversation. The // check guards against being taken to
    // somebody else's domain.
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    if (returnUrl?.startsWith('/') && !returnUrl.startsWith('//')) {
      await this.router.navigateByUrl(returnUrl);
      return;
    }

    // Admins stay in the admin area — that is their workplace.
    if (AuthHelper.hasAdminRole()) {
      await this.router.navigate(['/admin']);
      return;
    }

    await this.router.navigate(['/']);
  }
}
