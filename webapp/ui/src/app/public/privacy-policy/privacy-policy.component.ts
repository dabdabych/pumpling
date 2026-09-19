import { DOCUMENT, Location } from '@angular/common';
import { Component, Inject, OnDestroy, OnInit } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { Router } from '@angular/router';

const PAGE_TITLE = 'Privacy Policy — Pumpling';
const PAGE_DESCRIPTION =
  'How Pumpling handles your data: what we store when you register by email or connect a Solana wallet, what analytics we run, and what you can ask us to delete.';
const PAGE_URL = 'https://pumpling.xyz/privacy-policy';

@Component({
    selector: 'app-privacy-policy',
    templateUrl: './privacy-policy.component.html',
    styleUrls: ['./privacy-policy.component.scss'],
    standalone: false
})
export class PrivacyPolicyComponent implements OnInit, OnDestroy {

  // Whatever was in index.html before us — we put it back when leaving the page.
  private previous: { title: string; description: string; canonical: string; ogUrl: string };

  constructor(
    private readonly location: Location,
    private readonly router: Router,
    private readonly title: Title,
    private readonly meta: Meta,
    @Inject(DOCUMENT) private readonly document: Document
  ) { }

  ngOnInit(): void {
    // index.html is one for the whole app, and its canonical points at the root.
    // Without this substitution a search engine treats the policy as a duplicate of
    // the main page and keeps it out of the results, even though it is in sitemap.xml.
    this.previous = {
      title: this.title.getTitle(),
      description: this.meta.getTag('name="description"')?.content ?? '',
      canonical: this.canonicalLink().getAttribute('href') ?? '',
      ogUrl: this.meta.getTag('property="og:url"')?.content ?? ''
    };

    this.title.setTitle(PAGE_TITLE);
    this.meta.updateTag({ name: 'description', content: PAGE_DESCRIPTION });
    this.meta.updateTag({ property: 'og:title', content: PAGE_TITLE });
    this.meta.updateTag({ property: 'og:description', content: PAGE_DESCRIPTION });
    this.meta.updateTag({ property: 'og:url', content: PAGE_URL });
    this.canonicalLink().setAttribute('href', PAGE_URL);
  }

  ngOnDestroy(): void {
    this.title.setTitle(this.previous.title);
    this.meta.updateTag({ name: 'description', content: this.previous.description });
    this.meta.updateTag({ property: 'og:title', content: this.previous.title });
    this.meta.updateTag({ property: 'og:description', content: this.previous.description });
    this.meta.updateTag({ property: 'og:url', content: this.previous.ogUrl });
    this.canonicalLink().setAttribute('href', this.previous.canonical);
  }

  // The button used to say Confirm: a privacy policy is not confirmed, it tells
  // people what we do with their data rather than asking permission. The button
  // simply takes you back where you came from.
  goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
      return;
    }

    void this.router.navigateByUrl('/');
  }

  private canonicalLink(): HTMLLinkElement {
    return this.document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  }

}
