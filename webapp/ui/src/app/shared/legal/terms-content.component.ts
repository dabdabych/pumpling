import { Component } from '@angular/core';

/**
 * The terms of use text. The typography is shared with the privacy policy — the
 * same stylesheet, so the two legal texts look the same and do not drift apart
 * when edited.
 */
@Component({
  selector: 'app-terms-content',
  templateUrl: './terms-content.component.html',
  styleUrls: ['./privacy-policy-content.component.scss'],
  standalone: false
})
export class TermsContentComponent { }
