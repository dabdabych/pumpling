import { Connection } from '@solana/web3.js';

const SOLANA_SIGNATURE_PATTERN = /(?:signature|Signature)\s+([1-9A-HJ-NP-Za-km-z]{64,88})/;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 90_000;
const DEFAULT_CONFIRMATION_POLL_MS = 2_000;

export function isSolanaConfirmationTimeout(error: unknown): boolean {
  const text = getErrorText(error);
  return /Transaction was not confirmed in \d+(?:\.\d+)? seconds/i.test(text)
    || /It is unknown if it succeeded or failed/i.test(text);
}

export function extractSolanaSignatureFromError(error: unknown): string | null {
  const text = getErrorText(error);
  const match = text.match(SOLANA_SIGNATURE_PATTERN);
  return match?.[1] ?? null;
}

export function buildPendingTransactionMessage(error: unknown): string | null {
  if (!isSolanaConfirmationTimeout(error)) {
    return null;
  }

  const signature = extractSolanaSignatureFromError(error);
  const suffix = signature ? ` Signature: ${shortenSignature(signature)}.` : '';
  return `Transaction was submitted, but confirmation is taking longer than usual. Please wait a moment and check the table before retrying.${suffix}`;
}

export async function recoverConfirmedTransactionSignature(
  connection: Connection,
  error: unknown,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  pollMs = DEFAULT_CONFIRMATION_POLL_MS,
): Promise<string | null> {
  if (!isSolanaConfirmationTimeout(error)) {
    return null;
  }

  const signature = extractSolanaSignatureFromError(error);
  if (!signature) {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return signature;
    }
    await sleep(pollMs);
  }

  return null;
}

export async function waitForConfirmedTransactionSignature(
  connection: Connection,
  signature: string,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  pollMs = DEFAULT_CONFIRMATION_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (status?.err) {
      throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return true;
    }
    await sleep(pollMs);
  }

  return false;
}

function getErrorText(error: unknown): string {
  if (!error) {
    return '';
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String((error as any)?.message || (error as any)?.toString?.() || error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function shortenSignature(signature: string): string {
  return `${signature.slice(0, 8)}...${signature.slice(-8)}`;
}
