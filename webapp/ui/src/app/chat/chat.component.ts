import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, Input, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { JwtHelperService } from '@auth0/angular-jwt';
import { Store } from '@ngrx/store';
import { Subscription, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { signOut } from '../store/actions/auth';
import { authSelector } from '../store/selectors/auth';
import { IAppState } from '../store/state/app.state';
import { AuthDialogService } from '../auth/auth-dialog.service';

interface ChatInfo {
  id: number;
  slug: string;
  title: string;
}

interface ChatAuthor {
  id: number;
  name: string;
}

interface ReplyPreview {
  id: number;
  author_name: string;
  content: string;
}

interface ChatAttachment {
  id: string;
  mime_type: string;
}

interface ChatMessage {
  id: number;
  chat_id: number;
  content: string;
  created_at: string;
  author: ChatAuthor;
  reply_to?: ReplyPreview | null;
  attachment?: ChatAttachment | null;
  attachmentUrl?: string;
}

interface MessagesPage {
  items: ChatMessage[];
  has_more: boolean;
}

interface ChatSocketEvent {
  type?: string;
  client_message_id?: string;
  message?: ChatMessage | string;
  code?: string;
  retry_after_seconds?: number;
}

interface PendingMessage {
  clientMessageId: string;
  content: string;
  replyToId?: number;
  attachmentId?: string;
  attempts: number;
  awaitingAck: boolean;
  failed: boolean;
  ackTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const MESSAGE_PAGE_SIZE = 150;
const MAX_MESSAGE_LENGTH = 2000;
const ACK_TIMEOUT_MS = 5000;
const MAX_SEND_ATTEMPTS = 3;
const EMOJIS = ['😀', '😂', '😍', '🤝', '🔥', '🚀', '🎉', '💎', '👍', '👀', '❤️', '🙌'];

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
  standalone: false,
})
export class ChatComponent implements OnInit, OnDestroy, AfterViewChecked {
  @Input() embedded = false;
  @ViewChild('scrollContainer') private scrollContainer?: ElementRef<HTMLElement>;
  @ViewChild('messageInput') private messageInput?: ElementRef<HTMLTextAreaElement>;

  readonly emojis = EMOJIS;
  readonly maxMessageLength = MAX_MESSAGE_LENGTH;
  messages: ChatMessage[] = [];
  chat?: ChatInfo;
  draft = '';
  replyTo?: ChatMessage;
  hasMore = true;
  isLoading = true;
  /** The chat failed to load. Separate from errorMessage: that one lives in the
      composer, which is hidden from unauthenticated visitors, while a guest has
      to see this error too. */
  loadFailed = false;
  isLoadingOlder = false;
  isConnected = false;
  emojiPickerOpen = false;
  errorMessage = '';
  pendingMessageCount = 0;
  failedMessage?: PendingMessage;
  highlightedMessageId?: number;
  isUploadingGif = false;
  isAuthenticated = false;

  private socket?: WebSocket;
  private readonly pendingMessages = new Map<string, PendingMessage>();
  private readonly attachmentUrls = new Map<string, string>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private destroyed = false;
  private pendingScrollToBottom = false;
  private authSubscription?: Subscription;

  constructor(
    private http: HttpClient,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
    private jwtHelper: JwtHelperService,
    private store: Store<IAppState>,
    private authDialog: AuthDialogService,
  ) {}

  async ngOnInit(): Promise<void> {
    this.isAuthenticated = this.hasValidAuthToken();
    this.watchAuthState();
    try {
      const chat = await firstValueFrom(this.http.get<ChatInfo>(`${environment.apiUrl}/chats/default`));
      this.updateView(() => {
        this.chat = chat;
      });
      await this.loadMessages();
      this.openSocket();
    } catch {
      this.updateView(() => {
        this.loadFailed = true;
        this.errorMessage = 'Unable to load the chat. Refresh the page and try again.';
      });
    } finally {
      this.updateView(() => {
        this.isLoading = false;
      });
    }
  }

  ngAfterViewChecked(): void {
    if (this.pendingScrollToBottom) {
      this.pendingScrollToBottom = false;
      this.scrollToBottom();
    }
  }

  /**
   * Watches sign-ins and sign-outs while the chat is mounted.
   *
   * `isAuthenticated` used to be computed once in `ngOnInit`, while the chat
   * lives on the page permanently and is not recreated on sign-out. So after
   * pressing "sign out" the input stayed where it was and it was possible to
   * write in the chat: the flag was unchanged while the socket was already open
   * with a token and kept accepting messages as the previous user.
   *
   * The expiry check here is the same as in coming-soon: the store's initial
   * state only holds the fact that a token exists, not that it is valid.
   */
  private watchAuthState(): void {
    this.authSubscription = this.store.select(authSelector).subscribe((isAuthenticated) => {
      const allowed = isAuthenticated && this.hasValidAuthToken();
      // the token may have gone stale while the tab was open — then we clear the session
      if (isAuthenticated && !allowed) {
        this.store.dispatch(signOut());
        return;
      }
      if (allowed === this.isAuthenticated) {
        return;
      }
      this.updateView(() => {
        this.isAuthenticated = allowed;
      });
      // The socket carries the authentication marker in its subprotocol, so one
      // flag is not enough: it has to be reopened — with a token on sign-in and
      // without one on sign-out.
      this.reopenSocketForAuthChange();
    });
  }

  /**
   * Reopens the socket after the authentication status changes.
   *
   * The handlers are removed from the old socket before closing: otherwise its
   * `onclose` would start a reconnect with a growing pause, and the chat would go
   * quiet for several seconds for nothing.
   */
  private reopenSocketForAuthChange(): void {
    if (!this.isAuthenticated) {
      // Anything unsent belongs to the previous session — repeating it under a
      // new (or anonymous) name is not on.
      this.pendingMessages.forEach((message) => this.clearPendingTimers(message));
      this.pendingMessages.clear();
      this.updateView(() => {
        this.refreshPendingState();
        this.failedMessage = undefined;
      });
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const previous = this.socket;
    this.socket = undefined;
    if (previous) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onclose = null;
      previous.close();
    }
    this.reconnectAttempt = 0;
    this.updateView(() => {
      this.isConnected = false;
    });
    this.openSocket();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.authSubscription?.unsubscribe();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.pendingMessages.forEach((message) => this.clearPendingTimers(message));
    this.attachmentUrls.forEach((url) => URL.revokeObjectURL(url));
    this.socket?.close();
  }

  async onScroll(): Promise<void> {
    const container = this.scrollContainer?.nativeElement;
    if (!container || container.scrollTop > 96 || !this.hasMore || this.isLoadingOlder || !this.messages.length) {
      return;
    }
    await this.loadMessages(this.messages[0].id);
  }

  selectReply(message: ChatMessage): void {
    if (!this.isAuthenticated) {
      return;
    }
    this.replyTo = message;
    this.emojiPickerOpen = false;
    setTimeout(() => this.messageInput?.nativeElement.focus());
  }

  cancelReply(): void {
    this.replyTo = undefined;
  }

  async jumpToReplyTarget(message: ChatMessage): Promise<void> {
    const targetMessageId = message.reply_to?.id;
    if (!targetMessageId || !this.chat) {
      return;
    }

    if (this.messages.some((existingMessage) => existingMessage.id === targetMessageId)) {
      this.scrollToMessage(targetMessageId);
      return;
    }

    try {
      const targetMessage = await firstValueFrom(
        this.http.get<ChatMessage>(`${environment.apiUrl}/chats/${this.chat.id}/messages/${targetMessageId}`),
      );
      await this.loadAttachment(targetMessage);
      this.updateView(() => {
        this.messages = [...this.messages, targetMessage]
          .filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index)
          .sort((left, right) => left.id - right.id);
      });
      this.scrollToMessage(targetMessageId);
    } catch {
      this.updateView(() => {
        this.errorMessage = 'The original message is no longer available.';
      });
    }
  }

  addEmoji(emoji: string): void {
    if (!this.isAuthenticated || this.isUploadingGif) {
      return;
    }
    const input = this.messageInput?.nativeElement;
    if (!input) {
      this.draft += emoji;
      return;
    }

    const start = input.selectionStart ?? this.draft.length;
    const end = input.selectionEnd ?? start;
    this.draft = `${this.draft.slice(0, start)}${emoji}${this.draft.slice(end)}`;
    this.emojiPickerOpen = false;
    setTimeout(() => {
      input.focus();
      const cursor = start + emoji.length;
      input.setSelectionRange(cursor, cursor);
    });
  }

  onKeyDown(event: KeyboardEvent): void {
    if (this.isAuthenticated && event.key === 'Enter' && !event.shiftKey && !this.isUploadingGif) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  sendMessage(): void {
    const content = this.draft.trim();
    if (!this.isAuthenticated || this.isUploadingGif || !content || content.length > MAX_MESSAGE_LENGTH || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.queueMessage(content);
    this.draft = '';
    this.replyTo = undefined;
    this.emojiPickerOpen = false;
    this.errorMessage = '';
  }

  async onPaste(event: ClipboardEvent): Promise<void> {
    if (!this.isAuthenticated) {
      return;
    }
    const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith('image/'));
    if (!imageItem) {
      return;
    }
    event.preventDefault();

    const image = imageItem.getAsFile();
    if (!image || !this.chat || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const content = this.draft.trim();
    const replyToId = this.replyTo?.id;
    if (content.length > MAX_MESSAGE_LENGTH) {
      this.updateView(() => {
        this.errorMessage = `Message must not exceed ${MAX_MESSAGE_LENGTH} characters.`;
      });
      return;
    }

    this.updateView(() => {
      this.isUploadingGif = true;
      this.errorMessage = '';
      this.emojiPickerOpen = false;
    });
    try {
      const formData = new FormData();
      formData.append('file', image, 'clipboard-image');
      const attachment = await firstValueFrom(
        this.http.post<ChatAttachment>(`${environment.apiUrl}/chats/${this.chat.id}/attachments`, formData),
      );
      this.queueMessage(content, { attachmentId: attachment.id, replyToId });
      this.draft = '';
      this.replyTo = undefined;
      this.emojiPickerOpen = false;
    } catch {
      this.updateView(() => {
        this.errorMessage = 'Unable to upload the image. The maximum size is 5 MB.';
      });
    } finally {
      this.updateView(() => {
        this.isUploadingGif = false;
      });
    }
  }

  private queueMessage(
    content: string,
    options: { attachmentId?: string; replyToId?: number } = {},
  ): void {
    const pendingMessage: PendingMessage = {
      clientMessageId: crypto.randomUUID(),
      content,
      replyToId: options.attachmentId === undefined ? this.replyTo?.id : options.replyToId,
      attachmentId: options.attachmentId,
      attempts: 0,
      awaitingAck: false,
      failed: false,
    };
    this.pendingMessages.set(pendingMessage.clientMessageId, pendingMessage);
    this.refreshPendingState();
    this.trySendPendingMessage(pendingMessage);
  }

  retryFailedMessage(): void {
    const pendingMessage = this.failedMessage;
    if (!pendingMessage || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    pendingMessage.attempts = 0;
    pendingMessage.awaitingAck = false;
    pendingMessage.failed = false;
    this.failedMessage = undefined;
    this.errorMessage = '';
    this.refreshPendingState();
    this.trySendPendingMessage(pendingMessage);
  }

  formatTime(value: string): string {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  trackById(_: number, message: ChatMessage): number {
    return message.id;
  }

  private async loadMessages(beforeId?: number): Promise<void> {
    if (!this.chat || this.isLoadingOlder) {
      return;
    }
    const loadingOlder = beforeId !== undefined;
    const container = this.scrollContainer?.nativeElement;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    this.isLoadingOlder = loadingOlder;

    try {
      let params = new HttpParams().set('limit', MESSAGE_PAGE_SIZE);
      if (beforeId) {
        params = params.set('before_id', beforeId);
      }
      const page = await firstValueFrom(
        this.http.get<MessagesPage>(`${environment.apiUrl}/chats/${this.chat.id}/messages`, { params }),
      );
      await Promise.all(page.items.map((message) => this.loadAttachment(message)));
      const existingIds = new Set(this.messages.map((message) => message.id));
      const newMessages = page.items.filter((message) => !existingIds.has(message.id));
      this.updateView(() => {
        this.messages = loadingOlder ? [...newMessages, ...this.messages] : [...this.messages, ...newMessages];
        this.hasMore = page.has_more;

        if (loadingOlder && container) {
          setTimeout(() => {
            container.scrollTop = previousTop + (container.scrollHeight - previousHeight);
          });
        } else {
          this.pendingScrollToBottom = true;
        }
      });
    } finally {
      this.updateView(() => {
        this.isLoadingOlder = false;
      });
    }
  }

  private openSocket(): void {
    if (!this.chat || this.destroyed) {
      return;
    }
    const token = localStorage.getItem('jwt');
    const url = `${this.websocketBaseUrl()}/ws/chats/${this.chat.id}`;
    this.socket = this.isAuthenticated && token
      ? new WebSocket(url, `chat-jwt.${token}`)
      : new WebSocket(url);
    this.socket.onopen = () => {
      this.updateView(() => {
        this.isConnected = true;
        this.reconnectAttempt = 0;
        this.retryPendingMessages();
      });
    };
    this.socket.onmessage = (event) => this.handleSocketEvent(event.data);
    this.socket.onclose = () => {
      this.updateView(() => {
        this.isConnected = false;
        this.preparePendingMessagesForReconnect();
        this.scheduleReconnect();
      });
    };
  }

  private handleSocketEvent(rawEvent: string): void {
    let event: ChatSocketEvent;
    try {
      event = JSON.parse(rawEvent);
    } catch {
      return;
    }

    this.updateView(() => {
      if (event.type === 'message.ack' && event.client_message_id && event.message && typeof event.message !== 'string') {
        this.acknowledgeMessage(event.client_message_id, event.message);
        return;
      }

      const incomingMessage = event.message;
      if (event.type === 'message.created' && incomingMessage && typeof incomingMessage !== 'string') {
        this.appendMessage(incomingMessage);
        return;
      }

      if (event.type === 'error') {
        const retry = event.retry_after_seconds ? ` Try again in ${event.retry_after_seconds} seconds.` : '';
        this.errorMessage = `${typeof event.message === 'string' ? event.message : 'Unable to send the message.'}${retry}`;
        if (event.client_message_id) {
          this.markMessageAsFailed(event.client_message_id);
        }
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(30000, 1000 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private websocketBaseUrl(): string {
    if (environment.apiUrl.startsWith('http://') || environment.apiUrl.startsWith('https://')) {
      return environment.apiUrl.replace(/^http/, 'ws');
    }
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}${environment.apiUrl}`;
  }

  /** Signing in through a dialog: afterwards the person stays in the same conversation. */
  openSignIn(): void {
    this.authDialog.open({ mode: 'sign-in' });
  }

  private hasValidAuthToken(): boolean {
    const token = localStorage.getItem('jwt');
    return !!token && !this.jwtHelper.isTokenExpired(token);
  }

  private scrollToBottom(): void {
    const container = this.scrollContainer?.nativeElement;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private scrollToMessage(messageId: number): void {
    this.updateView(() => {
      this.highlightedMessageId = messageId;
    });
    setTimeout(() => {
      const element = this.scrollContainer?.nativeElement.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    setTimeout(() => {
      if (this.highlightedMessageId === messageId) {
        this.updateView(() => {
          this.highlightedMessageId = undefined;
        });
      }
    }, 1800);
  }

  private trySendPendingMessage(pendingMessage: PendingMessage): void {
    if (pendingMessage.awaitingAck || pendingMessage.failed || this.destroyed) {
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (pendingMessage.attempts >= MAX_SEND_ATTEMPTS) {
      this.updateView(() => this.markMessageAsFailed(pendingMessage.clientMessageId));
      return;
    }

    try {
      pendingMessage.attempts += 1;
      pendingMessage.awaitingAck = true;
      this.socket.send(JSON.stringify({
        type: 'message.create',
        client_message_id: pendingMessage.clientMessageId,
        content: pendingMessage.content,
        reply_to_id: pendingMessage.replyToId ?? null,
        attachment_id: pendingMessage.attachmentId ?? null,
      }));
      pendingMessage.ackTimer = setTimeout(() => {
        pendingMessage.ackTimer = undefined;
        pendingMessage.awaitingAck = false;
        if (pendingMessage.attempts >= MAX_SEND_ATTEMPTS) {
          this.updateView(() => this.markMessageAsFailed(pendingMessage.clientMessageId));
          return;
        }
        this.schedulePendingRetry(pendingMessage);
      }, ACK_TIMEOUT_MS);
    } catch {
      pendingMessage.awaitingAck = false;
      this.schedulePendingRetry(pendingMessage);
    }
  }

  private schedulePendingRetry(pendingMessage: PendingMessage): void {
    if (pendingMessage.failed || pendingMessage.retryTimer || this.destroyed) {
      return;
    }
    const delay = Math.min(4000, 500 * (2 ** Math.max(0, pendingMessage.attempts - 1)));
    pendingMessage.retryTimer = setTimeout(() => {
      pendingMessage.retryTimer = undefined;
      this.trySendPendingMessage(pendingMessage);
    }, delay);
  }

  private retryPendingMessages(): void {
    this.pendingMessages.forEach((pendingMessage) => {
      if (!pendingMessage.failed) {
        this.clearPendingTimers(pendingMessage);
        pendingMessage.awaitingAck = false;
        this.trySendPendingMessage(pendingMessage);
      }
    });
  }

  private preparePendingMessagesForReconnect(): void {
    this.pendingMessages.forEach((pendingMessage) => {
      if (!pendingMessage.failed) {
        this.clearPendingTimers(pendingMessage);
        pendingMessage.awaitingAck = false;
      }
    });
  }

  private acknowledgeMessage(clientMessageId: string, message: ChatMessage): void {
    const pendingMessage = this.pendingMessages.get(clientMessageId);
    if (pendingMessage) {
      this.clearPendingTimers(pendingMessage);
      this.pendingMessages.delete(clientMessageId);
      if (this.failedMessage?.clientMessageId === clientMessageId) {
        this.failedMessage = undefined;
      }
      this.refreshPendingState();
    }
    this.appendMessage(message, true);
  }

  private markMessageAsFailed(clientMessageId: string): void {
    const pendingMessage = this.pendingMessages.get(clientMessageId);
    if (!pendingMessage) {
      return;
    }
    this.clearPendingTimers(pendingMessage);
    pendingMessage.awaitingAck = false;
    pendingMessage.failed = true;
    this.failedMessage = pendingMessage;
    this.refreshPendingState();
  }

  private appendMessage(message: ChatMessage, scrollToBottom = false): void {
    if (this.messages.some((existingMessage) => existingMessage.id === message.id)) {
      if (scrollToBottom) {
        this.scrollToBottomAfterRender();
      }
      return;
    }
    const container = this.scrollContainer?.nativeElement;
    const isNearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    this.messages = [...this.messages, message];
    if (scrollToBottom) {
      this.scrollToBottomAfterRender();
    } else if (isNearBottom) {
      this.pendingScrollToBottom = true;
    }
    void this.loadAttachment(message).then(() => this.updateView(() => undefined));
  }

  private scrollToBottomAfterRender(): void {
    requestAnimationFrame(() => this.scrollToBottom());
  }

  private async loadAttachment(message: ChatMessage): Promise<void> {
    const attachment = message.attachment;
    if (!attachment || message.attachmentUrl || !this.chat) {
      return;
    }
    const cachedUrl = this.attachmentUrls.get(attachment.id);
    if (cachedUrl) {
      message.attachmentUrl = cachedUrl;
      return;
    }
    try {
      const blob = await firstValueFrom(
        this.http.get(`${environment.apiUrl}/chats/${this.chat.id}/attachments/${attachment.id}`, { responseType: 'blob' }),
      );
      const url = URL.createObjectURL(blob);
      this.attachmentUrls.set(attachment.id, url);
      message.attachmentUrl = url;
    } catch {
      // Keep the text message visible when its attachment cannot be loaded.
    }
  }

  private clearPendingTimers(pendingMessage: PendingMessage): void {
    if (pendingMessage.ackTimer) {
      clearTimeout(pendingMessage.ackTimer);
      pendingMessage.ackTimer = undefined;
    }
    if (pendingMessage.retryTimer) {
      clearTimeout(pendingMessage.retryTimer);
      pendingMessage.retryTimer = undefined;
    }
  }

  private refreshPendingState(): void {
    this.pendingMessageCount = Array.from(this.pendingMessages.values()).filter((message) => !message.failed).length;
  }

  /** Browser WebSocket callbacks and awaited promises can run outside Angular's change-detection cycle. */
  private updateView(update: () => void): void {
    this.ngZone.run(() => {
      if (this.destroyed) {
        return;
      }
      update();
      this.cdr.detectChanges();
    });
  }
}
