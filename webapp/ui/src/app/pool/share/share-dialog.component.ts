import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Inject, OnDestroy, ViewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';

import {
  drawShareCard,
  ShareCardData,
  shareCardBlob,
  shareCardCopy,
  shareCardFileName,
  shareCardLink,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH
} from './share-card';

type Feedback = 'image-copied' | 'link-copied' | 'downloaded' | 'copy-failed' | null;

/** Whether the system can accept an image in "Share": on desktop usually not. */
function canShareFiles(): boolean {
  if (typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    const probe = new File([new Blob([''], { type: 'image/png' })], 'probe.png', { type: 'image/png' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * The card for a post: a preview, a file and a link.
 *
 * X will not pull the image out of the link itself — we have no preview and
 * there is nothing to pretend about. So the order is this: the card is copied to
 * the clipboard or downloaded as a file, and the post button opens X with the text
 * ready, where the image is pasted. On a phone, where the clipboard does not take
 * images, the system "Share" works.
 */
@Component({
  selector: 'app-share-dialog',
  standalone: true,
  templateUrl: './share-dialog.component.html',
  styleUrls: ['./share-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ShareDialogComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas', { static: true }) private canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly width = SHARE_CARD_WIDTH;
  readonly height = SHARE_CARD_HEIGHT;
  readonly copy = shareCardCopy(this.data);
  readonly link = shareCardLink(this.data, location.origin);
  readonly canCopyImage = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
  readonly canShareFile = canShareFiles();

  ready = false;
  failed = false;
  feedback: Feedback = null;

  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private objectUrl: string | null = null;

  constructor(
    private readonly dialogRef: MatDialogRef<ShareDialogComponent>,
    private readonly cdr: ChangeDetectorRef,
    @Inject(MAT_DIALOG_DATA) readonly data: ShareCardData
  ) {}

  static open(dialog: MatDialog, data: ShareCardData): MatDialogRef<ShareDialogComponent> {
    const phone = window.matchMedia('(max-width: 599px)').matches;
    return dialog.open<ShareDialogComponent, ShareCardData>(ShareDialogComponent, {
      data,
      panelClass: ['auth-dialog-panel', phone ? 'auth-dialog-panel--sheet' : 'auth-dialog-panel--center', 'share-dialog-panel'],
      backdropClass: 'auth-dialog-backdrop',
      width: phone ? '100vw' : 'min(680px, calc(100vw - 32px))',
      maxWidth: '100vw',
      position: phone ? { bottom: '0' } : { top: 'max(24px, 8vh)' },
      autoFocus: 'first-heading',
      restoreFocus: true,
      ariaLabelledBy: 'share-dialog-title'
    });
  }

  async ngAfterViewInit(): Promise<void> {
    try {
      await drawShareCard(this.canvasRef.nativeElement, this.data);
      this.ready = true;
    } catch {
      this.failed = true;
    }
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    if (this.feedbackTimer) {
      clearTimeout(this.feedbackTimer);
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
  }

  close(): void {
    this.dialogRef.close();
  }

  async download(): Promise<void> {
    const blob = await this.blob();
    if (!blob) {
      return;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = this.objectUrl;
    link.download = shareCardFileName(this.data);
    link.click();
    this.show('downloaded');
  }

  async copyImage(): Promise<void> {
    const blob = await this.blob();
    if (!blob) {
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      this.show('image-copied');
    } catch {
      this.show('copy-failed');
    }
  }

  async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link);
      this.show('link-copied');
    } catch {
      this.show('copy-failed');
    }
  }

  /** The system "Share": on a phone the image goes into an app whole. */
  async shareFile(): Promise<void> {
    const blob = await this.blob();
    if (!blob) {
      return;
    }
    const file = new File([blob], shareCardFileName(this.data), { type: 'image/png' });
    if (!navigator.canShare?.({ files: [file] })) {
      await this.download();
      return;
    }
    try {
      await navigator.share({ files: [file], text: `${this.copy.post} ${this.link}` });
    } catch {
      // The person closed the system dialog — that is not an error.
    }
  }

  postUrl(): string {
    const params = new URLSearchParams({ text: this.copy.post, url: this.link });
    return `https://x.com/intent/post?${params.toString()}`;
  }

  private async blob(): Promise<Blob | null> {
    try {
      return await shareCardBlob(this.canvasRef.nativeElement);
    } catch {
      this.failed = true;
      this.cdr.markForCheck();
      return null;
    }
  }

  private show(feedback: Feedback): void {
    this.feedback = feedback;
    this.cdr.markForCheck();
    if (this.feedbackTimer) {
      clearTimeout(this.feedbackTimer);
    }
    this.feedbackTimer = setTimeout(() => {
      this.feedback = null;
      this.cdr.markForCheck();
    }, 2400);
  }
}
