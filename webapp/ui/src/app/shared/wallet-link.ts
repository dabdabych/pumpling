/**
 * The wallet this browser signed in with.
 *
 * The address is needed so that signing out disconnects the wallet, and so that
 * swapping the wallet in the extension does not leave somebody else's session
 * open: one address gave the signature and another would pay. The key used to be
 * declared in five files, and the dialog sign-in never wrote it at all — signing
 * out then did not disconnect the wallet and an address swap went unnoticed.
 *
 * Stored in localStorage: it is only the browser's memory of the last sign-in,
 * while the right to act comes from the signature and the token, not this record.
 */

export const WALLET_LINKED_ADDRESS_STORAGE_KEY = 'qres.wallet.linkedAddress';

export function rememberLinkedWallet(address: string): void {
  try {
    localStorage.setItem(WALLET_LINKED_ADDRESS_STORAGE_KEY, address);
  } catch {
    // A private window: the sign-in happened anyway, it is simply forgotten on exit.
  }
}

export function linkedWalletAddress(): string | null {
  try {
    return localStorage.getItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function forgetLinkedWallet(): void {
  try {
    localStorage.removeItem(WALLET_LINKED_ADDRESS_STORAGE_KEY);
  } catch {
    // see above
  }
}
