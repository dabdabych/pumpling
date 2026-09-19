import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Inject, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { JwtHelperService } from '@auth0/angular-jwt';
import { Store } from '@ngrx/store';
import { Subject, Subscription } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { AuthDialogService } from '../../auth/auth-dialog.service';
import { LegalDialogComponent } from '../../shared/legal/legal-dialog.component';
import { authSelector } from '../../store/selectors/auth';
import { IAppState } from '../../store/state/app.state';
import { CheckedCoin, CommitError, CommitService, SentCommit } from '../commit.service';
import { PRIORITY_LEVELS, PriorityLevel, RECOMMENDED_LEVEL, feeLabel, isPriorityLevel, priceFor } from '../priority-fee';
import { WalletService, isWalletFlowInterruption } from '../../shared/wallet.service';
import { linkedWalletAddress } from '../../shared/wallet-link';
import { AuthFlowService } from '../../auth/auth-flow.service';
import { formatLamports, parseSolToLamports, solToLamportsFloor } from '../lamports';
import { formatClock, formatSol, MIN_COMMIT_SOL, msUntil, POOL_FEE_BPS, PoolCoin, PoolMarket, PoolSnapshot } from '../pool-state';
import { PoolService } from '../pool.service';

export interface CommitDialogData {
  market: PoolMarket;
  /** The coin chosen before the dialog opened: from a row of the pool table. */
  mint?: string;
}

type CoinState =
  | { kind: 'empty' }
  | { kind: 'checking' }
  | { kind: 'ready'; coin: CheckedCoin }
  | { kind: 'error'; message: string };

type SendState = 'idle' | 'wallet' | 'sending';

const MIN_LAMPORTS = solToLamportsFloor(MIN_COMMIT_SOL);
const PRESETS = ['0.05', '0.5', '1', '5'];
/**
 * The amount that sits in the field straight away. An empty field is an extra
 * step before the button: a person has to decide how much as well, although
 * they came to back a coin. Zero does not work as a hint, and 0.5 SOL is a
 * normal first commit.
 */
const DEFAULT_AMOUNT = '0.5';
/** The chosen priority level is remembered in the browser. */
const PRIORITY_STORAGE_KEY = 'pumpling.commit.priority';
/** How many of the pool's coins we show as quick picks: more pushes the button down. */
const PICK_LIMIT = 5;

/**
 * The commit dialog. Returns a SentCommit once the transaction has gone out:
 * the pool page waits for the confirmation and the record itself, and the
 * dialog does not hold a person for a minute and a half of waiting.
 */
@Component({
  selector: 'app-commit-dialog',
  standalone: true,
  imports: [DecimalPipe, FormsModule],
  templateUrl: './commit-dialog.component.html',
  styleUrls: ['./commit-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommitDialogComponent implements OnInit, OnDestroy {
  readonly presets = PRESETS;
  readonly minText = formatLamports(MIN_LAMPORTS);
  /** The priority levels and the chosen one: how fast the commit lands in a block depends on it. */
  readonly priorityLevels = PRIORITY_LEVELS;
  priority: PriorityLevel = RECOMMENDED_LEVEL;
  /** What the network is paying right now; empty means no answer yet or the node stayed silent. */
  priorityEstimate: number | null = null;
  /** What will sign the commit: the wallet name and address. */
  walletName: string | null = null;
  walletAddress: string | null = null;

  mintInput = '';
  amountInput = '';
  coin: CoinState = { kind: 'empty' };
  send: SendState = 'idle';
  error = '';
  submitted = false;
  signedIn = false;
  snapshot: PoolSnapshot | null = null;
  nowMs = Date.now();

  @ViewChild('mintField') private mintFieldRef?: ElementRef<HTMLInputElement>;
  @ViewChild('amountField') private amountField?: ElementRef<HTMLInputElement>;

  private readonly mint$ = new Subject<string>();
  private checkId = 0;
  private readonly subscriptions = new Subscription();

  constructor(
    private readonly dialogRef: MatDialogRef<CommitDialogComponent, SentCommit>,
    @Inject(MAT_DIALOG_DATA) private readonly data: CommitDialogData,
    private readonly commits: CommitService,
    private readonly pool: PoolService,
    private readonly authDialog: AuthDialogService,
    private readonly dialog: MatDialog,
    private readonly store: Store<IAppState>,
    private readonly jwtHelper: JwtHelperService,
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    private readonly wallet: WalletService,
    private readonly auth: AuthFlowService
  ) {}

  static open(dialog: MatDialog, data: CommitDialogData): MatDialogRef<CommitDialogComponent, SentCommit> {
    const phone = window.matchMedia('(max-width: 599px)').matches;
    return dialog.open<CommitDialogComponent, CommitDialogData, SentCommit>(CommitDialogComponent, {
      data,
      // The dialog body is shared with the sign-in dialog: a transparent
      // Material surface, a bottom sheet on a phone (styles.scss, .auth-dialog-panel).
      panelClass: ['auth-dialog-panel', phone ? 'auth-dialog-panel--sheet' : 'auth-dialog-panel--center'],
      backdropClass: 'auth-dialog-backdrop',
      width: phone ? '100vw' : 'min(480px, calc(100vw - 32px))',
      maxWidth: '100vw',
      position: phone ? { bottom: '0' } : { top: 'max(24px, 9vh)' },
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      ariaLabelledBy: 'commit-dialog-title'
    });
  }

  ngOnInit(): void {
    this.amountInput = DEFAULT_AMOUNT;
    this.restorePriority();
    // The wallet is visible in the dialog: a person has to understand what they
    // are paying with, and be able to move to another without signing out.
    this.subscriptions.add(this.wallet.walletAddress$.subscribe((address) => {
      this.walletAddress = address;
      this.cdr.markForCheck();
    }));
    this.subscriptions.add(this.wallet.walletName$.subscribe((name) => {
      this.walletName = name;
      this.cdr.markForCheck();
    }));
    // The queue price on the network: asked once per dialog opening, over this
    // pool's accounts — that is what the network prices the queue from.
    void this.commits.priorityEstimate(this.snapshot?.accounts).then((estimate) => {
      this.zone.run(() => {
        this.priorityEstimate = estimate;
        this.cdr.markForCheck();
      });
    });
    this.subscriptions.add(this.pool.snapshot$(this.data.market).subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.nowMs = Date.now();
      // If less than a normal commit is left in the pool, we set what fits:
      // otherwise a person presses the button and gets an error for nothing.
      if (this.amountInput === DEFAULT_AMOUNT && snapshot.phase === 'open'
        && snapshot.remainingSol > 0 && snapshot.remainingSol < Number(DEFAULT_AMOUNT)) {
        this.amountInput = formatLamports(this.maxLamports);
      }
      this.cdr.markForCheck();
    }));
    if (this.data.mint) {
      // The coin was chosen in the pool table: we check it at once, with no input pause.
      this.mintInput = this.data.mint;
      this.coin = { kind: 'checking' };
      void this.checkCoin(this.data.mint);
    }
    this.subscriptions.add(this.store.select(authSelector).subscribe((signedIn) => {
      const token = localStorage.getItem('jwt');
      this.signedIn = signedIn && !!token && !this.jwtHelper.isTokenExpired(token);
      this.cdr.markForCheck();
    }));
    // Deliberately no distinctUntilChanged: a person can clear the field and
    // paste the same address again, and the pause would swallow the clearing —
    // the check would not start and the dialog would sit with a spinner. A
    // repeat costs nothing: checked coins are in the CommitService cache.
    this.subscriptions.add(this.mint$.pipe(debounceTime(350)).subscribe((value) => {
      void this.checkCoin(value);
    }));
    // While the wallet is signing, the dialog closes by neither the cross nor
    // the backdrop: otherwise the transaction goes out and the page never learns of it.
    this.subscriptions.add(this.dialogRef.backdropClick().subscribe(() => this.close()));
    this.dialogRef.disableClose = true;
    this.subscriptions.add(this.dialogRef.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    }));
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  // ------------------------------------------------------------ state

  get poolOpen(): boolean {
    return this.snapshot?.phase === 'open';
  }

  get closesIn(): string {
    return formatClock(msUntil(this.snapshot?.closesAtMs ?? null, this.nowMs));
  }

  /** Under ten minutes: the timer stops being a grey caption. */
  get closingSoon(): boolean {
    const left = msUntil(this.snapshot?.closesAtMs ?? null, this.nowMs);
    return this.poolOpen && left > 0 && left <= 10 * 60_000;
  }

  get maxLamports(): bigint {
    return solToLamportsFloor(this.snapshot?.remainingSol ?? 0);
  }

  get maxText(): string {
    return formatSol(this.snapshot?.remainingSol ?? 0);
  }

  get lamports(): bigint | null {
    return parseSolToLamports(this.amountInput);
  }

  get amountError(): string {
    const text = this.amountInput.trim();
    if (!text) {
      return this.submitted ? 'Enter how much SOL to add.' : '';
    }
    const lamports = this.lamports;
    if (lamports === null) {
      return 'Enter an amount like 0.5 or 2.';
    }
    if (lamports < MIN_LAMPORTS) {
      return `The minimum is ${this.minText} SOL.`;
    }
    if (this.snapshot && lamports > this.maxLamports) {
      return `Only ${this.maxText} SOL of room is left in this pool.`;
    }
    return '';
  }

  get coinError(): string {
    if (this.coin.kind === 'error') {
      return this.coin.message;
    }
    if (this.submitted && this.coin.kind === 'empty') {
      return 'Paste the address of a Solana memecoin.';
    }
    return '';
  }

  get readyCoin(): CheckedCoin | null {
    return this.coin.kind === 'ready' ? this.coin.coin : null;
  }

  get amountText(): string {
    const lamports = this.lamports;
    return lamports !== null && !this.amountError ? formatLamports(lamports) : '';
  }

  get submitLabel(): string {
    if (!this.poolOpen) {
      return 'Pool is not open';
    }
    if (!this.signedIn) {
      return 'Sign in to commit';
    }
    if (this.send === 'wallet') {
      return 'Confirm in your wallet…';
    }
    if (this.send === 'sending') {
      return 'Sending…';
    }
    return this.amountText ? `Commit ${this.amountText} SOL` : 'Commit SOL';
  }

  // ------------------------------------------------------------- events

  onMintInput(value: string): void {
    this.error = '';
    // People arrive with a link to a coin rather than a bare address: we pull it
    // out of the link ourselves instead of answering "that is not an address".
    const extracted = extractMint(value);
    this.mintInput = extracted ?? value;
    if (extracted) {
      // We write into the field ourselves: a one-way ngModel binding updates it
      // on the next change detection, and until then the link would stay in it.
      const field = this.mintFieldRef?.nativeElement;
      if (field && field.value !== extracted) {
        field.value = extracted;
      }
    }
    const trimmed = (extracted ?? value).trim();
    if (!trimmed) {
      this.checkId += 1;
      this.coin = { kind: 'empty' };
      this.mint$.next('');
      return;
    }
    this.coin = { kind: 'checking' };
    this.mint$.next(trimmed);
  }

  /**
   * Coins already in the pool: they can be picked with one tap.
   *
   * An empty field asking for an address is the heaviest first step in the whole
   * product: somebody arriving has no address in their clipboard. And most
   * people want to back a coin that has already collected SOL: it is right there
   * on the page.
   */
  get pickCoins(): PoolCoin[] {
    if (!this.poolOpen || this.coin.kind !== 'empty' || this.mintInput.trim()) {
      return [];
    }
    return [...(this.snapshot?.coins ?? [])].sort((a, b) => b.sol - a.sol).slice(0, PICK_LIMIT);
  }

  pickCoin(coin: PoolCoin): void {
    this.mintInput = coin.mint;
    const field = this.mintFieldRef?.nativeElement;
    if (field) {
      field.value = coin.mint;
    }
    this.coin = { kind: 'checking' };
    this.error = '';
    void this.checkCoin(coin.mint);
    this.amountField?.nativeElement.focus();
  }

  /**
   * The share of the pool this commit becomes. An honest "how much is this
   * anyway": without it 0.5 SOL is just a number and it is unclear whether that
   * is a lot.
   */
  get shareText(): string {
    const lamports = this.lamports;
    const total = this.snapshot?.totalSol ?? 0;
    if (lamports === null || this.amountError || !this.poolOpen) {
      return '';
    }
    const sol = Number(formatLamports(lamports));
    const share = sol / (total + sol);
    if (!Number.isFinite(share) || share <= 0) {
      return '';
    }
    return share >= 0.001 ? `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%` : '<0.1%';
  }

  /**
   * How much buying would go to this coin if the pool closed right now, with
   * this commit included.
   *
   * This is the main thing a person is buying: not a prize but an announced
   * purchase. The number is the same as in the pool table and computed the same
   * way — the coin's share of the buying budget. The draw will move the shares,
   * which the line below says.
   */
  get expectedBuyText(): string {
    const coin = this.readyCoin;
    const lamports = this.lamports;
    const snapshot = this.snapshot;
    if (!coin || lamports === null || this.amountError || !snapshot || !this.poolOpen) {
      return '';
    }
    const added = Number(formatLamports(lamports));
    const current = snapshot.coins.find((entry) => entry.mint === coin.mint)?.sol ?? 0;
    const total = snapshot.totalSol + added;
    if (total <= 0) {
      return '';
    }
    const budget = total * (1 - POOL_FEE_BPS / 10_000);
    const expected = ((current + added) / total) * budget;
    return expected > 0 ? formatSol(expected) : '';
  }

  setPreset(value: string): void {
    this.amountInput = value;
    this.error = '';
  }

  setMax(): void {
    this.amountInput = formatLamports(this.maxLamports);
    this.error = '';
  }

  openTerms(): void {
    LegalDialogComponent.open(this.dialog, 'terms');
  }

  /** $412K, $1.2M, $0.00041 — the way exchange cards do it. */
  usd(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
      return '—';
    }
    if (value >= 1_000_000_000) {
      return `$${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
      return `$${(value / 1_000).toFixed(1)}K`;
    }
    if (value >= 1) {
      return `$${value.toFixed(2)}`;
    }
    // Memecoins often cost fractions of a cent: rounding to two decimals would give $0.00.
    return `$${value.toPrecision(2)}`;
  }

  close(): void {
    if (this.send !== 'idle') {
      return;
    }
    this.dialogRef.close();
  }

  /** The wallet address in short: the start and the end. */
  get walletShort(): string {
    const address = this.walletAddress ?? '';
    return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
  }

  /**
   * Switch the wallet that will sign the commit.
   *
   * If the account was signed into with a wallet, the session is tied to its
   * address: one gave the signature, another would pay. So after a switch we
   * immediately reissue the session for the new wallet — one signature, and the
   * person stays signed in. An email sign-in is not tied to a wallet, so there
   * is nothing to change there.
   */
  async changeWallet(): Promise<void> {
    if (this.send !== 'idle') {
      return;
    }
    const linked = linkedWalletAddress();
    try {
      // The switch runs as one action: until it finishes the session watchdog
      // stays quiet, otherwise it would see a foreign address and throw the
      // person out to the main page from inside the commit dialog.
      await this.wallet.duringSwitch(async () => {
        const address = await this.wallet.connect({ chooser: true });
        if (linked && address && address !== linked) {
          await this.auth.signInWithWallet(false);
        }
      });
    } catch (error) {
      if (!isWalletFlowInterruption(error)) {
        this.error = 'Could not switch the wallet. Try again.';
      }
    }
    this.cdr.markForCheck();
  }

  /** The level caption: what it costs on top of the network fee. */
  priorityCost(level: PriorityLevel): string {
    return feeLabel(priceFor(level, this.priorityEstimate));
  }

  priorityTitle(level: PriorityLevel): string {
    return level === 'normal' ? 'Normal' : level === 'fast' ? 'Fast' : 'Turbo';
  }

  selectPriority(level: PriorityLevel): void {
    if (this.send !== 'idle') {
      return;
    }
    this.priority = level;
    try {
      localStorage.setItem(PRIORITY_STORAGE_KEY, level);
    } catch {
      // A private window: the choice simply will not survive a reload.
    }
    this.cdr.markForCheck();
  }

  private restorePriority(): void {
    try {
      const saved = localStorage.getItem(PRIORITY_STORAGE_KEY);
      if (isPriorityLevel(saved)) {
        this.priority = saved;
      }
    } catch {
      // see above
    }
  }

  async submit(): Promise<void> {
    if (this.send !== 'idle' || !this.poolOpen) {
      return;
    }
    if (!this.signedIn) {
      // A commit is recorded against an account: without signing in the backend would not take it.
      this.authDialog.open({ mode: 'sign-in' });
      return;
    }
    this.submitted = true;
    this.error = '';
    const coin = this.readyCoin;
    const lamports = this.lamports;
    const snapshot = this.snapshot;
    if (!coin || lamports === null || this.amountError || !snapshot || snapshot.poolId === null) {
      this.cdr.markForCheck();
      return;
    }

    this.send = 'wallet';
    this.cdr.markForCheck();
    try {
      const sent = await this.commits.send({
        poolId: snapshot.poolId,
        market: this.data.market,
        accounts: snapshot.accounts,
        mint: coin.mint,
        lamports,
        priority: this.priority
      });
      this.zone.run(() => {
        this.send = 'idle';
        if (sent) {
          this.dialogRef.close(sent);
        }
        this.cdr.markForCheck();
      });
    } catch (error) {
      this.zone.run(() => {
        this.send = 'idle';
        this.error = error instanceof CommitError ? error.message : 'Could not send the transaction. Try again.';
        this.cdr.markForCheck();
      });
    }
  }

  private async checkCoin(value: string): Promise<void> {
    const id = ++this.checkId;
    if (!value) {
      return;
    }
    try {
      const coin = await this.commits.checkCoin(value, this.data.market);
      if (id !== this.checkId) {
        return;
      }
      this.coin = { kind: 'ready', coin };
      // The coin is found — the amount is next.
      if (!this.amountInput) {
        setTimeout(() => this.amountField?.nativeElement.focus());
      }
    } catch (error) {
      if (id !== this.checkId) {
        return;
      }
      this.coin = { kind: 'error', message: error instanceof CommitError ? error.message : 'Could not check this coin. Try again in a moment.' };
    } finally {
      if (id === this.checkId) {
        this.cdr.markForCheck();
      }
    }
  }
}

/** A coin address from a pasted link: pump.fun, Solscan, Birdeye, Jupiter. */
const MINT_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const TOKEN_LINK_HOSTS = /(pump\.fun|solscan\.io|birdeye\.so|jup\.ag|explorer\.solana\.com|solanabeach\.io)/i;

function extractMint(value: string): string | null {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) {
    return null;
  }
  if (!TOKEN_LINK_HOSTS.test(text)) {
    // On dexscreener the link holds the pair address rather than the coin's:
    // substituting it silently is not on, the person would get a puzzling error.
    return null;
  }
  const found = text.match(MINT_IN_TEXT);
  return found ? found[0] : null;
}
