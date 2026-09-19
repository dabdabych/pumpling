import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { BehaviorSubject } from 'rxjs';
import { firstValueFrom } from 'rxjs';

import {
  WalletConnectDialogComponent,
  WalletConnectDialogResult,
} from './system-dialog/wallet-connect-dialog/wallet-connect-dialog.component';
import { environment } from '../../environments/environment';
import {
  findStandardWallet,
  isUsableStandardWallet,
  standardChain,
  standardProvider,
  standardWallets,
  startWalletStandard,
} from './wallet-standard';

/**
 * A wallet name in the list. We know four by sight: they have their own icons
 * and install links. The rest arrive from Wallet Standard under their own
 * names — which is exactly why this is a string and not an enum.
 */
export type SupportedWalletName = string;
export const KNOWN_WALLETS = ['Phantom', 'Solflare', 'Backpack', 'Coinbase Wallet'] as const;
export type WalletChoiceTheme = 'phantom' | 'solflare' | 'backpack' | 'coinbase';

export class WalletFlowCancelledError extends Error {
  constructor() {
    super('Wallet selection was cancelled');
    this.name = 'WalletFlowCancelledError';
  }
}

export class WalletExternalNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletExternalNavigationError';
  }
}

export function isWalletFlowInterruption(error: unknown): boolean {
  return error instanceof WalletFlowCancelledError || error instanceof WalletExternalNavigationError;
}

export interface WalletChoice {
  name: SupportedWalletName;
  theme: WalletChoiceTheme;
  monogram: string;
  iconPath: string;
  detected: boolean;
  connectable: boolean;
  interactive: boolean;
  /** The site is using this wallet right now. */
  connected: boolean;
  actionLabel: 'Connect' | 'Open App' | 'Install' | 'Not detected';
  externalUrl: string | null;
}

interface WalletPublicKeyLike {
  toString(): string;
  toBase58?(): string;
}

interface InjectedSolanaProvider {
  publicKey?: WalletPublicKeyLike | null;
  isConnected?: boolean;
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  isCoinbaseWallet?: boolean;
  connect?: (options?: Record<string, unknown>) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  signMessage?: (
    message: Uint8Array,
    display?: 'utf8' | 'hex'
  ) => Promise<Uint8Array | { signature: Uint8Array }>;
  signTransaction?: (...args: any[]) => Promise<unknown>;
  signAllTransactions?: (...args: any[]) => Promise<unknown>;
  signAndSendTransaction?: (...args: any[]) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  off?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
}

interface WalletDefinition {
  name: SupportedWalletName;
  theme: WalletChoiceTheme;
  monogram: string;
  iconPath: string;
  installUrl: string;
  mobileOpenUrl: (url: string, ref: string) => string;
  detect: (hostWindow: any) => InjectedSolanaProvider | null;
}

const SELECTED_WALLET_STORAGE_KEY = 'qres.wallet.selectedName';

/**
 * Extensions do not appear in `window` instantly or all at once: each injects
 * its own script and announces itself with its own event. Solflare is the
 * slowest of them — it shows up later than the rest, and a chooser assembled
 * immediately honestly wrote "Not detected" next to an installed wallet.
 */
const WALLET_INJECTION_EVENTS = [
  'solflare#initialized',
  'phantom#initialized',
  'backpack#initialized',
  'wallet-standard:register-wallet',
];

/**
 * How long the dialog treats the list as unsettled. During that time a wallet
 * that has not been found shows as "checking" rather than "install": the
 * extension may inject itself right now, and offering an install to somebody
 * who has the wallet is wrong. Clicking such a row is blocked too — otherwise
 * somebody would manage to miss a button that is about to change.
 */
const INJECTION_SETTLE_MS = 1600;
/** How often to re-scan the list while the dialog is open. */
const INJECTION_RESCAN_MS = 400;
/** A silent session restore must not hold up the page starting. */
const SILENT_CONNECT_TIMEOUT_MS = 1500;

const SUPPORTED_WALLETS: WalletDefinition[] = [
  {
    name: 'Phantom',
    theme: 'phantom',
    monogram: 'P',
    iconPath: 'assets/wallets/phantom.png',
    installUrl: 'https://phantom.app/download',
    mobileOpenUrl: (url, ref) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`,
    detect: (hostWindow) => {
      const provider = hostWindow?.phantom?.solana;
      if (looksLikeProvider(provider)) {
        return provider;
      }
      return findMatchingProvider(hostWindow, (candidate) => candidate?.isPhantom === true);
    },
  },
  {
    name: 'Solflare',
    theme: 'solflare',
    monogram: 'S',
    iconPath: 'assets/wallets/solflare.png',
    installUrl: 'https://solflare.com/download',
    mobileOpenUrl: (url, ref) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`,
    detect: (hostWindow) => {
      const provider = hostWindow?.solflare ?? hostWindow?.Solflare;
      if (looksLikeProvider(provider)) {
        return provider;
      }
      return findMatchingProvider(hostWindow, (candidate) => candidate?.isSolflare === true);
    },
  },
  {
    name: 'Backpack',
    theme: 'backpack',
    monogram: 'B',
    iconPath: 'assets/wallets/backpack.png',
    installUrl: 'https://backpack.app/download',
    mobileOpenUrl: (url) => `https://backpack.app/ul/v1/browse/${encodeURIComponent(url)}`,
    detect: (hostWindow) => {
      const provider = hostWindow?.backpack?.solana ?? hostWindow?.xnft?.solana ?? hostWindow?.backpack;
      if (looksLikeProvider(provider)) {
        return provider;
      }
      return findMatchingProvider(hostWindow, (candidate) => candidate?.isBackpack === true);
    },
  },
  {
    name: 'Coinbase Wallet',
    theme: 'coinbase',
    monogram: 'C',
    iconPath: 'assets/wallets/coinbase-wallet.png',
    installUrl: 'https://www.coinbase.com/wallet/downloads',
    mobileOpenUrl: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}`,
    detect: (hostWindow) => {
      const provider = hostWindow?.coinbaseSolana;
      if (looksLikeProvider(provider)) {
        return provider;
      }
      return findMatchingProvider(hostWindow, (candidate) => candidate?.isCoinbaseWallet === true);
    },
  },
];

@Injectable({ providedIn: 'root' })
export class WalletService {
  private walletAddressSubject = new BehaviorSubject<string | null>(null);
  walletAddress$ = this.walletAddressSubject.asObservable();
  /** The connected wallet's name: the commit dialog shows what will sign. */
  private walletNameSubject = new BehaviorSubject<SupportedWalletName | null>(null);
  walletName$ = this.walletNameSubject.asObservable();

  private currentProvider: InjectedSolanaProvider | null = null;
  /** Adapters for Wallet Standard wallets, one per wallet. */
  private readonly standardProviders = new Map<string, InjectedSolanaProvider>();
  private switchDepth = 0;
  private currentWalletName: SupportedWalletName | null = null;
  private providerUnsubscribers: Array<() => void> = [];

  constructor(private readonly dialog: MatDialog) {}

  /**
   * A deliberate wallet switch is under way.
   *
   * The session watchdog signs somebody out when the wallet address stops
   * matching the one they signed in with: one gave the signature, another would
   * pay. But exactly the same thing happens when a person asked to switch
   * wallets themselves, and throwing them out in the middle of that is not on —
   * we reissue the session for the new address immediately.
   */
  get isSwitchingWallet(): boolean {
    return this.switchDepth > 0;
  }

  /** Perform a wallet switch as one whole action. */
  async duringSwitch<T>(action: () => Promise<T>): Promise<T> {
    this.switchDepth += 1;
    try {
      return await action();
    } finally {
      this.switchDepth -= 1;
    }
  }

  getProvider(): InjectedSolanaProvider | null {
    if (this.currentProvider) {
      return this.currentProvider;
    }

    const selectedProvider = this.getSelectedProvider();
    if (selectedProvider) {
      this.setCurrentProvider(selectedProvider.provider, selectedProvider.name);
    }

    return this.currentProvider;
  }

  getWalletChoices(): WalletChoice[] {
    // We start listening to the standard on the first request for the list:
    // earlier it is not needed, later would be too late — wallets send their
    // announcement at once.
    startWalletStandard();
    return [...this.knownChoices(), ...this.standardOnlyChoices()];
  }

  /** Unknown wallets: we take the name and icon from the wallets themselves. */
  private standardOnlyChoices(): WalletChoice[] {
    const known = new Set(SUPPORTED_WALLETS.map((definition) => definition.name.toLowerCase()));
    return standardWallets()
      .filter((wallet) => isUsableStandardWallet(wallet))
      .filter((wallet) => {
        const name = wallet.name.trim().toLowerCase();
        return !Array.from(known).some((item) => name === item || name.startsWith(item) || item.startsWith(name));
      })
      .map((wallet) => ({
        name: wallet.name,
        theme: 'phantom' as WalletChoiceTheme,
        monogram: wallet.name.trim().charAt(0).toUpperCase() || '?',
        iconPath: wallet.icon ?? '',
        detected: true,
        connectable: true,
        connected: this.currentWalletName === wallet.name && !!this.walletAddressSubject.value,
        interactive: true,
        actionLabel: 'Connect' as const,
        externalUrl: null,
      }));
  }

  private knownChoices(): WalletChoice[] {
    return SUPPORTED_WALLETS.map((definition) => {
      const provider = this.detectProvider(definition);
      const detected = !!provider;
      const connectable = detected && this.isProviderConnectable(provider);
      const isMobile = this.isMobileBrowser();
      const externalUrl = connectable ? null : this.getMobileWalletUrl(definition);

      return {
        name: definition.name,
        theme: definition.theme,
        monogram: definition.monogram,
        iconPath: definition.iconPath,
        detected,
        connectable,
        connected: this.currentWalletName === definition.name && !!this.walletAddressSubject.value,
        interactive: connectable || !!externalUrl,
        // A person reads "Not detected" as "something is broken on my side". A
        // click takes them to the install page anyway, so that is what we write.
        // A wallet that simply had not managed to inject itself is already
        // visible by then: the list stays live while the dialog is open.
        actionLabel: connectable ? 'Connect' : isMobile ? 'Open App' : externalUrl ? 'Install' : 'Not detected',
        externalUrl,
      };
    });
  }

  async checkConnection(): Promise<string | null> {
    const selected = this.getSelectedProvider();
    if (!selected) {
      return null;
    }

    this.setCurrentProvider(selected.provider, selected.name);

    if (typeof selected.provider.connect === 'function') {
      try {
        if (!this.isProviderSessionConnected(selected.provider)) {
          // Restoring the session on page load. The onlyIfTrusted flag was
          // invented by Phantom; wallets that do not know it simply ignore it,
          // and some of them open a confirmation dialog at that moment. A person
          // may never answer it, so we wait only so long: starting the page must
          // not depend on a wallet.
          await this.withTimeout(
            selected.provider.connect({ onlyIfTrusted: true }),
            SILENT_CONNECT_TIMEOUT_MS
          );
        }
      } catch {
        // Silent reconnect is best-effort only.
      }
    }

    const restoredAddress = this.readProviderAddress(selected.provider);
    if (restoredAddress && this.isProviderSessionConnected(selected.provider)) {
      this.setWalletAddress(restoredAddress);
      return restoredAddress;
    }

    return null;
  }

  /**
   * Connect a wallet.
   *
   * `chooser` means the person came for a connection themselves (sign-in, a
   * wallet switch): we always show the list, even when a wallet is already
   * connected. Without that, switching wallets was impossible in principle: the
   * service silently returned the current one and the choice in the dialog
   * changed nothing.
   *
   * Without `chooser` (signing a commit) we take the connected one: there is no
   * reason to ask about the wallet before every transaction.
   */
  async connect(options: { chooser?: boolean } = {}): Promise<string> {
    if (!options.chooser && this.currentProvider) {
      const activeAddress = await this.connectProvider(this.currentProvider, this.currentWalletName);
      if (activeAddress) {
        return activeAddress;
      }
    }

    const result = await this.openWalletSelectionDialog();
    if (result.action === 'external') {
      if (typeof window !== 'undefined' && result.externalUrl) {
        if (this.isMobileBrowser()) {
          window.location.assign(result.externalUrl);
        } else {
          window.open(result.externalUrl, '_blank', 'noopener,noreferrer');
        }
      }

      throw new WalletExternalNavigationError(
        this.isMobileBrowser()
          ? `Opening ${result.walletName}. Continue the connection inside the wallet app and return here.`
          : `Opening ${result.walletName} installation page. Install the wallet and try again.`
      );
    }

    const definition = this.findDefinitionByName(result.walletName);
    // An unknown wallet from Wallet Standard: it has no definition, but we do
    // have the wallet itself.
    const provider = definition
      ? this.detectProvider(definition)
      : this.standardProviderFor(result.walletName);
    const walletName = definition ? definition.name : result.walletName;
    if (!provider || !this.isProviderConnectable(provider)) {
      throw new Error(`${walletName} is not available in this browser`);
    }

    // We leave the previous wallet honestly: drop the subscriptions, clear the
    // address and tell the extension to disconnect. Otherwise two connections
    // stay in the page at once and it is anyone's guess which one signs.
    if (this.currentWalletName && this.currentWalletName !== walletName) {
      await this.disconnect();
    }

    this.persistSelectedWalletName(walletName);
    this.setCurrentProvider(provider, walletName);

    const address = await this.connectProvider(provider, walletName);
    if (!address) {
      throw new Error('Wallet did not provide public key');
    }

    return address;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const provider = await this.requireConnectedProvider();
    if (typeof provider.signMessage !== 'function') {
      throw new Error('Selected wallet does not support message signing');
    }

    const result = await provider.signMessage(message, 'utf8');
    if (result instanceof Uint8Array) {
      return result;
    }
    if (result?.signature instanceof Uint8Array) {
      return result.signature;
    }

    throw new Error('Wallet returned an unsupported signature payload');
  }

  async disconnect(): Promise<void> {
    const provider = this.currentProvider;
    this.clearProviderListeners();
    this.currentProvider = null;
    this.currentWalletName = null;
    this.walletNameSubject.next(null);

    try {
      await provider?.disconnect?.();
    } finally {
      this.clearSelectedWalletName();
      this.setWalletAddress(null);
    }
  }

  private async requireConnectedProvider(): Promise<InjectedSolanaProvider> {
    const address = await this.connect();
    const provider = this.getProvider();
    if (!provider || !address) {
      throw new Error('Wallet is not connected');
    }
    return provider;
  }

  private async connectProvider(
    provider: InjectedSolanaProvider,
    walletName: SupportedWalletName | null
  ): Promise<string | null> {
    const existingAddress = this.readProviderAddress(provider);
    if (existingAddress && this.isProviderSessionConnected(provider)) {
      this.setWalletAddress(existingAddress);
      if (walletName) {
        this.persistSelectedWalletName(walletName);
      }
      return existingAddress;
    }

    if (typeof provider.connect !== 'function') {
      throw new Error('Selected wallet does not support direct connection');
    }

    const connectResult = await provider.connect();

    const connectedAddress = this.readProviderAddress(provider) || this.readAddressFromConnectResult(connectResult);
    if (connectedAddress) {
      this.setWalletAddress(connectedAddress);
      if (walletName) {
        this.persistSelectedWalletName(walletName);
      }
    }
    return connectedAddress;
  }

  private isProviderSessionConnected(provider: InjectedSolanaProvider | null): boolean {
    if (!provider) {
      return false;
    }

    if (typeof provider.isConnected === 'boolean') {
      return provider.isConnected;
    }

    return !!this.readProviderAddress(provider);
  }

  private detectProvider(definition: WalletDefinition): InjectedSolanaProvider | null {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const injected = definition.detect(window as any);
      if (injected) {
        return injected;
      }
    } catch {
      // A wallet with a broken injection must not get in the way of the rest.
    }

    return this.standardProviderFor(definition.name);
  }

  /**
   * A wallet that announced itself through Wallet Standard.
   *
   * The adapter is created once per wallet and remembered: the list is
   * re-scanned several times a second while the chooser is open, and the
   * service recognises the current provider by object reference.
   */
  private standardProviderFor(name: SupportedWalletName): InjectedSolanaProvider | null {
    const cached = this.standardProviders.get(name);
    if (cached) {
      return cached;
    }
    const wallet = findStandardWallet(name);
    if (!isUsableStandardWallet(wallet)) {
      return null;
    }
    const adapter = standardProvider(wallet!, standardChain(environment.solanaExplorerQuery)) as InjectedSolanaProvider;
    this.standardProviders.set(name, adapter);
    return adapter;
  }

  private getSelectedProvider(): { name: SupportedWalletName; provider: InjectedSolanaProvider } | null {
    const selectedName = this.getSelectedWalletName();
    if (!selectedName) {
      return null;
    }

    const definition = this.findDefinitionByName(selectedName);
    const provider = definition ? this.detectProvider(definition) : this.standardProviderFor(selectedName);
    if (!provider) {
      return null;
    }

    return { name: definition ? definition.name : selectedName, provider };
  }

  private setCurrentProvider(provider: InjectedSolanaProvider, walletName: SupportedWalletName | null): void {
    if (this.currentProvider === provider && this.currentWalletName === walletName) {
      return;
    }

    this.clearProviderListeners();
    this.currentProvider = provider;
    this.currentWalletName = walletName;
    this.walletNameSubject.next(walletName);

    const handleConnect = () => {
      this.setWalletAddress(this.readProviderAddress(provider));
    };
    const handleDisconnect = () => {
      this.setWalletAddress(null);
    };
    const handleAccountChanged = (nextPublicKey?: WalletPublicKeyLike | null) => {
      const nextAddress = this.normalizeWalletAddress(nextPublicKey) ?? this.readProviderAddress(provider);
      this.setWalletAddress(nextAddress ?? null);
    };

    this.subscribeProviderEvent(provider, 'connect', handleConnect);
    this.subscribeProviderEvent(provider, 'disconnect', handleDisconnect);
    this.subscribeProviderEvent(provider, 'accountChanged', handleAccountChanged);
  }

  private subscribeProviderEvent(
    provider: InjectedSolanaProvider,
    event: string,
    handler: (...args: any[]) => void
  ): void {
    if (typeof provider.on !== 'function') {
      return;
    }

    provider.on(event, handler);
    this.providerUnsubscribers.push(() => {
      if (typeof provider.off === 'function') {
        provider.off(event, handler);
        return;
      }

      if (typeof provider.removeListener === 'function') {
        provider.removeListener(event, handler);
      }
    });
  }

  private clearProviderListeners(): void {
    for (const unsubscribe of this.providerUnsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // Best effort cleanup only.
      }
    }
  }

  private isProviderConnectable(provider: InjectedSolanaProvider | null): provider is InjectedSolanaProvider {
    if (!provider) {
      return false;
    }

    return typeof provider.connect === 'function'
      && typeof provider.signMessage === 'function'
      && (
        typeof provider.signTransaction === 'function'
        || typeof provider.signAndSendTransaction === 'function'
      );
  }

  private readProviderAddress(provider: InjectedSolanaProvider | null): string | null {
    return this.normalizeWalletAddress(provider?.publicKey);
  }

  private readAddressFromConnectResult(result: unknown): string | null {
    const publicKeyCandidate =
      (result as any)?.publicKey ??
      (result as any)?.address ??
      (result as any)?.account?.publicKey ??
      null;
    return this.normalizeWalletAddress(publicKeyCandidate);
  }

  private normalizeWalletAddress(candidate: unknown): string | null {
    if (!candidate) {
      return null;
    }

    const rawValue =
      typeof (candidate as any)?.toBase58 === 'function'
        ? (candidate as any).toBase58()
        : typeof (candidate as any)?.toString === 'function'
          ? (candidate as any).toString()
          : typeof candidate === 'string'
            ? candidate
            : null;

    const address = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!address || address === 'null' || address === 'undefined' || address === '[object Object]') {
      return null;
    }

    // Keep wallet address state canonical and only accept valid Solana pubkeys.
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return null;
    }

    return address;
  }

  private async openWalletSelectionDialog(): Promise<WalletConnectDialogResult> {
    // The dialog opens at the top right rather than centred: centred, it
    // covered the very form it was opened for. The position is set through the
    // dialog config rather than CSS — otherwise the overlay centres the panel
    // anyway and the calculations disagree.
    //
    // We look at the screen width rather than the device type: the layout
    // depends on exactly that. On a narrow screen "top right" is meaningless —
    // there we push the dialog to the bottom, closer to the thumb.
    const narrow = typeof window !== 'undefined' && window.innerWidth <= 600;
    const position = narrow
      ? { bottom: '16px', left: '16px', right: '16px' }
      : { top: '24px', right: '24px' };

    const dialogRef = this.dialog.open(WalletConnectDialogComponent, {
      panelClass: 'qres-confirm-panel',
      backdropClass: 'qres-confirm-backdrop',
      autoFocus: false,
      restoreFocus: false,
      position,
      width: narrow ? 'calc(100vw - 32px)' : undefined,
      // MatDialog defaults to max-width: 80vw, which on a narrow screen cut the
      // dialog to 80% of the width and made the right margin three times the left.
      maxWidth: narrow ? '100vw' : undefined,
      data: {
        wallets: this.getWalletChoices(),
        // The list stays live: an extension that appears while the dialog is
        // open becomes available without closing and reopening.
        refresh: () => this.getWalletChoices(),
        rescanMs: INJECTION_RESCAN_MS,
        settleMs: INJECTION_SETTLE_MS,
        injectionEvents: WALLET_INJECTION_EVENTS,
      },
    });

    const result = (await firstValueFrom(dialogRef.beforeClosed())) as WalletConnectDialogResult | undefined;
    if (!result) {
      throw new WalletFlowCancelledError();
    }

    return result;
  }

  /** We cannot wait for a wallet forever: a person may not answer its dialog. */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    return Promise.race([
      promise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  }

  private findDefinitionByName(name: string | null | undefined): WalletDefinition | null {
    if (!name) {
      return null;
    }

    const normalized = name.trim().toLowerCase();
    return SUPPORTED_WALLETS.find((wallet) => wallet.name.toLowerCase() === normalized) ?? null;
  }

  private getMobileWalletUrl(definition: WalletDefinition): string | null {
    if (typeof window === 'undefined') {
      return definition.installUrl;
    }

    if (!this.isMobileBrowser()) {
      return definition.installUrl;
    }

    return definition.mobileOpenUrl(window.location.href, window.location.origin);
  }

  private isMobileBrowser(): boolean {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return false;
    }

    const userAgent = navigator.userAgent || navigator.vendor || '';
    return /android|iphone|ipad|ipod|mobile/i.test(userAgent);
  }

  private getSelectedWalletName(): SupportedWalletName | null {
    if (typeof window === 'undefined') {
      return null;
    }

    const raw = window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    // The name may belong to an unknown Wallet Standard wallet too.
    return this.findDefinitionByName(raw)?.name ?? raw.trim() ?? null;
  }

  private persistSelectedWalletName(name: SupportedWalletName | null): void {
    if (typeof window === 'undefined' || !name) {
      return;
    }

    window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, name);
  }

  private clearSelectedWalletName(): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.removeItem(SELECTED_WALLET_STORAGE_KEY);
  }

  private setWalletAddress(address: string | null): void {
    this.walletAddressSubject.next(address);
  }
}

function findMatchingProvider(
  hostWindow: any,
  matcher: (provider: InjectedSolanaProvider | null) => boolean
): InjectedSolanaProvider | null {
  for (const candidate of collectInjectedProviders(hostWindow)) {
    if (matcher(candidate)) {
      return candidate;
    }
  }
  return null;
}

function looksLikeProvider(provider: any): provider is InjectedSolanaProvider {
  return !!provider && typeof provider === 'object' && typeof provider.connect === 'function';
}

function collectInjectedProviders(hostWindow: any): InjectedSolanaProvider[] {
  const candidates = [
    hostWindow?.solana,
    hostWindow?.phantom?.solana,
    hostWindow?.solflare,
    hostWindow?.Solflare,
    hostWindow?.backpack?.solana,
    hostWindow?.xnft?.solana,
    hostWindow?.backpack,
    hostWindow?.coinbaseSolana,
  ];

  const solanaProviders = Array.isArray(hostWindow?.solana?.providers) ? hostWindow.solana.providers : [];
  const extraProviders = Array.isArray(hostWindow?.phantom?.providers) ? hostWindow.phantom.providers : [];

  const unique = new Set<InjectedSolanaProvider>();
  for (const candidate of [...candidates, ...solanaProviders, ...extraProviders]) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }
    unique.add(candidate);
  }

  return Array.from(unique);
}
