import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Inject, OnDestroy, ViewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { filter, take } from 'rxjs/operators';

export type LegalDocument = 'privacy' | 'terms';

export interface LegalDialogData {
  document: LegalDocument;
}

const DOCUMENTS: Record<LegalDocument, { title: string; page: string }> = {
  privacy: { title: 'Privacy Policy', page: '/privacy-policy' },
  terms: { title: 'Terms of Use', page: '/terms' }
};

/**
 * Legal text in a dialog: a quick read, not a replacement for the page. The
 * canonical versions live at /privacy-policy and /terms: those can be linked and
 * a search engine sees them. The dialog is there so somebody on the sign-in form
 * can read the text without losing what they filled in. It used to open only the
 * policy, while the terms took people away to the /terms page.
 *
 * Links between the documents inside the dialog switch the text in the dialog
 * itself: the terms link to the policy, and following those would again take
 * somebody away from the sign-in page.
 *
 * The button says "I agree", which is a product decision. Technically the button
 * only closes the dialog: the press is recorded nowhere, not on the server and
 * not in localStorage. It cannot be cited as proof that consent was obtained — it
 * records no consent. If that is ever really needed, it takes a separate flag
 * with a date and the text version.
 */
@Component({
  selector: 'app-legal-dialog',
  templateUrl: './legal-dialog.component.html',
  styleUrls: ['./legal-dialog.component.scss'],
  standalone: false
})
export class LegalDialogComponent implements AfterViewInit, OnDestroy {
  document: LegalDocument;

  @ViewChild('body') private bodyRef?: ElementRef<HTMLElement>;

  /**
   * Intercepting in the capture phase: routerLink listens for a click on the
   * link itself, and by the time it bubbled to the dialog body the navigation
   * would have started. The capture phase cannot be set in an Angular template,
   * so the listener is attached here.
   */
  private readonly onBodyClick = (event: MouseEvent): void => {
    const link = (event.target as Element | null)?.closest?.('a[href]');
    const path = link?.getAttribute('href');
    const target = (Object.keys(DOCUMENTS) as LegalDocument[]).find((key) => DOCUMENTS[key].page === path);
    if (!target || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.document = target;
    // The listener was not attached by the template, and change detection does
    // not run after it by itself: the title and the text would stay as they were.
    this.cdr.detectChanges();
    this.bodyRef?.nativeElement.scrollTo({ top: 0 });
  };

  constructor(
    private readonly dialogRef: MatDialogRef<LegalDialogComponent>,
    private readonly cdr: ChangeDetectorRef,
    @Inject(MAT_DIALOG_DATA) data: LegalDialogData
  ) {
    this.document = data?.document ?? 'privacy';
  }

  static open(dialog: MatDialog, document: LegalDocument): MatDialogRef<LegalDialogComponent> {
    const ref = dialog.open<LegalDialogComponent, LegalDialogData>(LegalDialogComponent, {
      data: { document },
      panelClass: 'legal-dialog-panel',
      backdropClass: 'legal-dialog-backdrop',
      width: 'min(92vw, 720px)',
      maxWidth: 'none',
      maxHeight: '88vh',
      // Focus on the dialog itself rather than the first button: otherwise the
      // close cross opens already highlighted and reads as pressed. A screen
      // reader announces the dialog title anyway, and Tab still starts its walk
      // from inside.
      autoFocus: 'dialog',
      restoreFocus: true,
      ariaLabelledBy: 'legal-dialog-title',
      // We do not let a backdrop click close it: the text is long, a person
      // scrolls it and misses the dialog — losing the place they had read to
      // would be annoying. Escape stays: with no keyboard exit the dialog traps
      // focus.
      disableClose: true
    });

    // take(1): the dialog closes on the first Escape, there is no point catching
    // a second. preventDefault repeats what stock Material does: the browser must
    // not also leave full screen or reset a form's autofill.
    ref.keydownEvents()
      .pipe(filter(event => event.key === 'Escape'), take(1))
      .subscribe(event => {
        event.preventDefault();
        ref.close();
      });

    return ref;
  }

  get title(): string {
    return DOCUMENTS[this.document].title;
  }

  get page(): string {
    return DOCUMENTS[this.document].page;
  }

  ngAfterViewInit(): void {
    this.bodyRef?.nativeElement.addEventListener('click', this.onBodyClick, { capture: true });
  }

  ngOnDestroy(): void {
    this.bodyRef?.nativeElement.removeEventListener('click', this.onBodyClick, { capture: true });
  }

  close(): void {
    this.dialogRef.close();
  }
}
