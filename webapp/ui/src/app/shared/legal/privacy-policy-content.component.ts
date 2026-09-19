import { Component } from '@angular/core';

/**
 * Only the policy text, with no wrapper. A separate component because the same
 * text is shown by the /privacy-policy page and by the dialog from the sign-in
 * page, and keeping 1200 words of legal text in two copies means one day fixing
 * one of them and forgetting the other.
 */
@Component({
    selector: 'app-privacy-policy-content',
    templateUrl: './privacy-policy-content.component.html',
    styleUrls: ['./privacy-policy-content.component.scss'],
    standalone: false
})
export class PrivacyPolicyContentComponent {
}
