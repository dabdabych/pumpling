/**
 * Wallet Standard: wallets that announce themselves.
 *
 * How it used to be. Every wallet injected its own object into the page under
 * its own name (`window.solflare`, `window.phantom.solana`), and the site knew
 * about each one separately. Hence the whole class of "who injected themselves
 * and when" problems: a wallet that appeared later was invisible to the site,
 * and an unknown wallet was invisible always.
 *
 * How the standard works. The page announces readiness with a
 * `wallet-standard:app-ready` event carrying a receiver; wallets that loaded
 * earlier register at once. A wallet that loads later sends its own
 * `wallet-standard:register-wallet` and gets the same receiver. Both directions
 * are mandatory: without the first we miss the fast ones, without the second the
 * slow ones.
 *
 * What we get from it. First, the wallet list stops being hardcoded: an unknown
 * wallet turns up in the chooser with its own name and icon. Second, the
 * standard gives everyone the same capabilities, and our code works with them
 * through the adapter below without knowing the brand.
 *
 * What is deliberately absent: `solana:signIn` (SIWS). Signing in in one step
 * instead of "connect and sign" is the right goal, but the backend verifies the
 * signature and it parses our own message format. Moving to SIWS means new
 * parsing on the server, and that cannot be done alongside this change.
 */

interface StandardAccount {
  address: string;
  publicKey?: Uint8Array;
  chains?: readonly string[];
  features?: readonly string[];
}

interface StandardWallet {
  name: string;
  icon?: string;
  version?: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, any>;
}

/** Capabilities without which a wallet is no use to us. */
const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const EVENTS = 'standard:events';
const SIGN_MESSAGE = 'solana:signMessage';
const SIGN_TRANSACTION = 'solana:signTransaction';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';

const registry = new Map<string, StandardWallet>();
let started = false;

/** Subscriptions to new wallets appearing: the chooser refreshes its list. */
const listeners = new Set<() => void>();

function remember(wallets: unknown[]): void {
  let added = false;
  for (const candidate of wallets) {
    const wallet = candidate as StandardWallet;
    if (!wallet || typeof wallet.name !== 'string' || !wallet.features) {
      continue;
    }
    // We only care about Solana wallets: the standard is shared across networks.
    if (!Array.isArray(wallet.chains) || !wallet.chains.some((chain) => String(chain).startsWith('solana:'))) {
      continue;
    }
    if (!registry.has(wallet.name)) {
      added = true;
    }
    registry.set(wallet.name, wallet);
  }
  if (added) {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A subscriber must not break the registration of the others.
      }
    }
  }
}

/** Start listening for wallets. Called lazily and exactly once. */
export function startWalletStandard(): void {
  if (started || typeof window === 'undefined') {
    return;
  }
  started = true;

  const api = {
    version: '1.0.0' as const,
    register: (...wallets: unknown[]) => {
      remember(wallets);
      return () => undefined;
    },
    get: () => Array.from(registry.values()),
    on: () => () => undefined,
  };

  window.addEventListener('wallet-standard:register-wallet', (event: Event) => {
    const callback = (event as CustomEvent).detail;
    if (typeof callback === 'function') {
      try {
        callback(api);
      } catch {
        // A wallet with broken registration must not take the page down.
      }
    }
  });

  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch {
    // An old browser with no CustomEvent: the window.<wallet> path remains.
  }
}

export function standardWallets(): StandardWallet[] {
  startWalletStandard();
  return Array.from(registry.values());
}

export function onStandardWallet(listener: () => void): () => void {
  startWalletStandard();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A standard wallet by name: we compare loosely, ignoring case. */
export function findStandardWallet(name: string): StandardWallet | null {
  const needle = name.trim().toLowerCase();
  for (const wallet of standardWallets()) {
    const candidate = wallet.name.trim().toLowerCase();
    if (candidate === needle || candidate.startsWith(needle) || needle.startsWith(candidate)) {
      return wallet;
    }
  }
  return null;
}

export function isUsableStandardWallet(wallet: StandardWallet | null | undefined): boolean {
  if (!wallet) {
    return false;
  }
  return !!wallet.features[CONNECT]
    && !!wallet.features[SIGN_MESSAGE]
    && (!!wallet.features[SIGN_TRANSACTION] || !!wallet.features[SIGN_AND_SEND]);
}

/**
 * An adapter to the shape the rest of the code understands: the same `connect`,
 * `signMessage` and `signTransaction` as the wallets injected into the page. That
 * way the standard is added without rewriting the service and the commit dialog.
 */
export function standardProvider(wallet: StandardWallet, chain: string): any {
  let account: StandardAccount | null = wallet.accounts[0] ?? null;
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  let unsubscribeChange: (() => void) | null = null;

  const publicKeyOf = (value: StandardAccount | null) =>
    value ? { toString: () => value.address, toBase58: () => value.address } : null;

  const provider: any = {
    get publicKey() {
      return publicKeyOf(account);
    },
    get isConnected() {
      return !!account;
    },
    isStandardWallet: true,
    standardName: wallet.name,

    connect: async () => {
      const result = await wallet.features[CONNECT].connect();
      const accounts: StandardAccount[] = result?.accounts ?? wallet.accounts ?? [];
      account = accounts[0] ?? null;
      return { publicKey: publicKeyOf(account) };
    },

    disconnect: async () => {
      account = null;
      await wallet.features[DISCONNECT]?.disconnect?.();
    },

    signMessage: async (message: Uint8Array) => {
      if (!account) {
        throw new Error('Wallet is not connected');
      }
      const [result] = await wallet.features[SIGN_MESSAGE].signMessage({ account, message });
      return result.signature as Uint8Array;
    },

    signTransaction: wallet.features[SIGN_TRANSACTION]
      ? async (transaction: any) => {
          if (!account) {
            throw new Error('Wallet is not connected');
          }
          // The standard takes and returns bytes while our code has an object
          // with `serialize()`. There is not a single signature here yet, so we
          // serialize without checking signatures.
          const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
          const [signed] = await wallet.features[SIGN_TRANSACTION].signTransaction({
            account,
            chain,
            transaction: new Uint8Array(bytes),
          });
          const output: Uint8Array = signed.signedTransaction;
          return { serialize: () => output };
        }
      : undefined,

    signAndSendTransaction: wallet.features[SIGN_AND_SEND]
      ? async (transaction: any) => {
          if (!account) {
            throw new Error('Wallet is not connected');
          }
          const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
          const [result] = await wallet.features[SIGN_AND_SEND].signAndSendTransaction({
            account,
            chain,
            transaction: new Uint8Array(bytes),
          });
          return { signature: result.signature };
        }
      : undefined,

    on: (event: string, handler: (...args: any[]) => void) => {
      (handlers[event] = handlers[event] ?? []).push(handler);
      if (unsubscribeChange || !wallet.features[EVENTS]?.on) {
        return;
      }
      // The standard has one event for everything: the accounts changed. An
      // empty list means "disconnected", a non-empty one "switched account".
      unsubscribeChange = wallet.features[EVENTS].on('change', (changed: { accounts?: readonly StandardAccount[] }) => {
        if (!changed || !('accounts' in changed)) {
          return;
        }
        const next = changed.accounts?.[0] ?? null;
        account = next;
        const name = next ? 'accountChanged' : 'disconnect';
        for (const listener of handlers[name] ?? []) {
          listener(publicKeyOf(next));
        }
      });
    },

    off: (event: string, handler: (...args: any[]) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((item) => item !== handler);
    },
  };

  return provider;
}

/** The network in the standard's terms: `solana:devnet` or `solana:mainnet`. */
export function standardChain(explorerQuery: string | undefined): string {
  return String(explorerQuery ?? '').includes('devnet') ? 'solana:devnet' : 'solana:mainnet';
}

export type { StandardWallet };
