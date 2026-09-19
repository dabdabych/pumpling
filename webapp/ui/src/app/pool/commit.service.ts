import { HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { AnchorProvider, BN, Program } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { Api } from '../api-client/api';
import { placeBetLotteryBetPost } from '../api-client/fn/lottery/place-bet-lottery-bet-post';
import lotteryIdl from '../idl/lottery_v_1_0.json';
import { findExistingLotteryPdas } from '../shared/admin-wallets';
import { AllowTokenResponse, AllowTokenService } from '../shared/allow-token.service';
import { isBlockedBetMint } from '../shared/blocked-bet-mints';
import { SUPPRESS_GLOBAL_ERROR_DIALOG } from '../shared/http-context-tokens';
import { buildPendingTransactionMessage, waitForConfirmedTransactionSignature } from '../shared/solana-transaction-confirmation';
import { isWalletFlowInterruption, WalletService } from '../shared/wallet.service';
import { lamportsToSol } from './lamports';
import { DEPOSIT_COMPUTE_UNITS, PriorityLevel, RECOMMENDED_LEVEL, estimateFromSamples, priceFor } from './priority-fee';
import { PoolAccounts, PoolMarket } from './pool-state';

export interface CheckedCoin {
  mint: string;
  name: string;
  ticker: string;
  logoUrl: string | null;
  /** Where the coin trades now: the pump.fun curve or a DEX. Empty means the source stayed silent. */
  venue: string | null;
  /** The coin's market: price, market cap, liquidity. Empty if the source stayed silent. */
  market: CoinMarket | null;
}

export interface CoinMarket {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24h: number | null;
  dexId: string | null;
  pairUrl: string | null;
}

export interface CommitRequest {
  poolId: number;
  market: PoolMarket;
  accounts: PoolAccounts | null;
  mint: string;
  lamports: bigint;
  /** How much of a hurry we are in to land in a block. Empty means the recommended level. */
  priority?: PriorityLevel;
}

export type CommitOutcome =
  /** Solana confirmed and the backend recorded it — the commit is already in the list. */
  | 'recorded'
  /** Solana confirmed, but recording it right away did not work. The events worker will record it from the chain. */
  | 'confirmed'
  /** No confirmation in a minute and a half. The transaction may still go through. */
  | 'unconfirmed';

export interface SentCommit {
  signature: string;
  walletAddress: string;
  /** What exactly went into the pool: the card for a post and the toast need it. */
  mint: string;
  lamports: bigint;
  /** How the confirmation and the recording end. Never rejects. */
  settled: Promise<CommitOutcome>;
}

/** An error that can be shown to a person as it is. */
export class CommitError extends Error {}

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** How long a network fee estimate lives: longer and it is no longer about "now". */
const FEE_ESTIMATE_TTL_MS = 60_000;

/**
 * A commit to the pool: checking the coin, the `deposit_sol` transaction in the
 * wallet, confirmation on the network and recording on the backend.
 *
 * Recording goes two ways, and that was the backend's design: after the
 * confirmation the frontend sends `/lottery/bet` (the backend checks the
 * transaction on chain itself), while the events worker catches the same Deposit
 * from the program logs. So a recording failure after confirmation is not a lost
 * commit, it is a delay.
 */
@Injectable({ providedIn: 'root' })
export class CommitService {
  private readonly programId = new PublicKey((lotteryIdl as { address: string }).address);
  private readonly checkedCoins = new Map<string, CheckedCoin>();
  private feeEstimate: { at: number; value: number | null } | null = null;

  constructor(
    private readonly api: Api,
    private readonly allowToken: AllowTokenService,
    private readonly wallet: WalletService
  ) {}

  looksLikeMint(value: string): boolean {
    return MINT_PATTERN.test(value.trim());
  }

  async checkCoin(rawMint: string, market: PoolMarket): Promise<CheckedCoin> {
    const mint = rawMint.trim();
    if (isBlockedBetMint(mint)) {
      throw new CommitError('SOL, wSOL and USDC are not memecoins. Paste the address of the coin you want bought.');
    }
    if (!this.looksLikeMint(mint)) {
      throw new CommitError('That is not a Solana token address.');
    }
    const cacheKey = `${market}:${mint}`;
    const cached = this.checkedCoins.get(cacheKey);
    if (cached) {
      return cached;
    }
    let response: AllowTokenResponse;
    try {
      response = await this.allowToken.checkMint({ mint_address: mint, lottery_type: market });
    } catch (error) {
      throw new CommitError(mintCheckError(error));
    }
    const canonical = (response.mint_address || mint).trim();
    const ticker = (response.token_symbol || '').trim().replace(/^\$/, '').toUpperCase() || canonical.slice(0, 4).toUpperCase();
    const coin: CheckedCoin = {
      mint: canonical,
      name: (response.token_name || '').trim() || ticker,
      ticker,
      logoUrl: /^https?:\/\//i.test(response.token_image_url || '') ? response.token_image_url!.trim() : null,
      venue: market === 'dex' ? coinVenue(response) : null,
      market: coinMarket(response)
    };
    this.checkedCoins.set(cacheKey, coin);
    this.checkedCoins.set(`${market}:${canonical}`, coin);
    return coin;
  }

  /**
   * Sign and send the commit. It returns as soon as the transaction has gone
   * out: the dialog can close and the confirmation can be waited for on the page.
   * null means the person closed the wallet themselves.
   */
  async send(request: CommitRequest): Promise<SentCommit | null> {
    let walletAddress: string;
    try {
      // We reconnect before every transaction: some wallets remember the address
      // after a page reload but refuse to sign without connect().
      walletAddress = await this.wallet.connect();
    } catch (error) {
      if (isWalletFlowInterruption(error)) {
        return null;
      }
      throw new CommitError(walletError(error));
    }

    const connection = new Connection(environment.solanaRpcUrl, 'confirmed');
    const payer = new PublicKey(walletAddress);
    const mint = new PublicKey(request.mint);
    const accounts = await this.resolveAccounts(request, connection);

    const program = new Program(
      { ...(lotteryIdl as object), address: this.programId.toBase58() } as any,
      new AnchorProvider(connection, readOnlyWallet(payer) as any, { preflightCommitment: 'confirmed' })
    );
    const deposit = await program.methods
      .depositSol(mint, new BN(request.lamports.toString()))
      .accounts({ lottery: accounts.lottery, vault: accounts.vault, payer, mint, systemProgram: SystemProgram.programId })
      .transaction();
    // The budget instructions go first: that is where both the runtime and the wallet read them.
    const microLamports = priceFor(request.priority ?? RECOMMENDED_LEVEL, await this.priorityEstimate(request.accounts, connection));
    const transaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEPOSIT_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...deposit.instructions
    );

    let signature: string;
    try {
      signature = await this.signAndSend(transaction, connection, payer);
    } catch (error) {
      if (isWalletFlowInterruption(error) || isUserRejection(error)) {
        return null;
      }
      throw new CommitError(transactionError(error));
    }

    return {
      signature,
      walletAddress,
      mint: request.mint,
      lamports: request.lamports,
      settled: this.settle(request, signature, walletAddress, connection)
    };
  }

  /**
   * What people are paying for queue position now, microlamports per compute unit.
   *
   * The answer lives for a minute: the price changes more slowly than somebody
   * fills in the dialog, and an extra call to the node on every keystroke is not
   * needed. The network stayed silent means `null`, and the levels are computed
   * from the lower bound.
   */
  async priorityEstimate(accounts?: PoolAccounts | null, connection?: Connection): Promise<number | null> {
    const now = Date.now();
    if (this.feeEstimate && now - this.feeEstimate.at < FEE_ESTIMATE_TTL_MS) {
      return this.feeEstimate.value;
    }
    let value: number | null = null;
    try {
      const node = connection ?? new Connection(environment.solanaRpcUrl, 'confirmed');
      // Asking "what does queue position cost in general" is pointless: the
      // network answers with the minimum across all accounts, and that is almost
      // always zero (measured on mainnet 2026-09-19: 150 samples, all zeros). The
      // price lives at a particular hot account, and for a commit that is the
      // pool vault: when fifty people enter a pool at once, the vault is the hot account.
      const writable = [accounts?.lotteryPda, accounts?.vaultPda]
        .filter((value): value is string => !!value)
        .map((value) => new PublicKey(value));
      const samples = await node.getRecentPrioritizationFees(
        writable.length > 0 ? { lockedWritableAccounts: writable } : undefined
      );
      value = estimateFromSamples(samples as { prioritizationFee?: number }[]);
    } catch {
      // The node did not answer or the method is closed: we pay the lower bound.
      value = null;
    }
    this.feeEstimate = { at: now, value };
    return value;
  }

  /** A link to the transaction in an explorer. */
  explorerUrl(signature: string): string {
    return `https://solscan.io/tx/${signature}${environment.solanaExplorerQuery || ''}`;
  }

  private async settle(request: CommitRequest, signature: string, walletAddress: string, connection: Connection): Promise<CommitOutcome> {
    try {
      const confirmed = await waitForConfirmedTransactionSignature(connection, signature);
      if (!confirmed) {
        return 'unconfirmed';
      }
    } catch {
      return 'unconfirmed';
    }
    try {
      await firstValueFrom(this.api.invoke(placeBetLotteryBetPost, {
        body: {
          lottery_id: request.poolId,
          lottery_type: request.market,
          meme_coin_address: request.mint,
          sol_amount: lamportsToSol(request.lamports),
          wallet_address: walletAddress,
          tx_signature: signature
        }
      }, new HttpContext().set(SUPPRESS_GLOBAL_ERROR_DIALOG, true)));
      return 'recorded';
    } catch {
      return 'confirmed';
    }
  }

  private async resolveAccounts(request: CommitRequest, connection: Connection): Promise<{ lottery: PublicKey; vault: PublicKey }> {
    const { lotteryPda, vaultPda } = request.accounts ?? { lotteryPda: null, vaultPda: null };
    if (lotteryPda && vaultPda) {
      return { lottery: new PublicKey(lotteryPda), vault: new PublicKey(vaultPda) };
    }
    const found = await findExistingLotteryPdas(connection, this.programId, request.poolId);
    if (!found) {
      throw new CommitError('Could not find this pool on Solana. Reload the page and try again.');
    }
    return { lottery: found.lottery, vault: found.vault };
  }

  private async signAndSend(transaction: Transaction, connection: Connection, payer: PublicKey): Promise<string> {
    const provider = this.wallet.getProvider() as any;
    if (!provider) {
      throw new CommitError('Connect a wallet first.');
    }
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.feePayer = payer;
    transaction.recentBlockhash = blockhash;

    // We sign in the wallet and send ourselves. That matters, and here is why.
    //
    // `signAndSendTransaction` sends the transaction through the wallet's own
    // node, into whichever network the person has selected in the extension. The
    // blockhash, meanwhile, came from our node. A wallet on mainnet plus a stand
    // on devnet and the signature goes into a different network with a foreign
    // blockhash: "Blockhash not found" out of nowhere. That is exactly how it was
    // caught on Solflare, which defaults to mainnet.
    //
    // Our own `sendRawTransaction` keeps the network, the preflight and the
    // retries under our control. The wallet stays what it should be: a signer.
    if (typeof provider.signTransaction === 'function') {
      const signed = await provider.signTransaction(transaction);
      return connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    }

    // A fallback for wallets that can only "sign and send": those turn up in the
    // in-app browsers of mobile apps.
    if (typeof provider.signAndSendTransaction === 'function') {
      const result = await provider.signAndSendTransaction(transaction);
      const signature = extractSignature(result);
      if (!signature) {
        throw new CommitError('The wallet did not return a transaction signature.');
      }
      return signature;
    }

    throw new CommitError('This wallet cannot sign transactions.');
  }
}

/** Anchor needs a wallet, but the real provider signs separately. */
function readOnlyWallet(publicKey: PublicKey) {
  return {
    publicKey,
    signTransaction: async (transaction: Transaction) => transaction,
    signAllTransactions: async (transactions: Transaction[]) => transactions
  };
}

function extractSignature(result: unknown): string | null {
  if (typeof result === 'string' && result.trim()) {
    return result.trim();
  }
  const signature = (result as { signature?: unknown })?.signature;
  if (typeof signature === 'string' && signature.trim()) {
    return signature.trim();
  }
  if (signature instanceof Uint8Array) {
    return encodeBase58(signature);
  }
  return null;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }
  return '1'.repeat(leadingZeroes) + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('');
}

function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const text = errorText(error);
  return code === 4001 || /user rejected|rejected the request|request rejected|declined/i.test(text);
}

/** The coin's market from the check response; nothing arrived means null and the card copes. */
function coinMarket(response: AllowTokenResponse): CoinMarket | null {
  const priceUsd = positive(response.price_usd);
  const marketCapUsd = positive(response.market_cap_usd);
  const liquidityUsd = positive(response.liquidity_usd);
  const volume24hUsd = positive(response.volume_24h_usd);
  const priceChange24h = Number.isFinite(response.price_change_24h as number) ? Number(response.price_change_24h) : null;
  const dexId = (response.dex_id || '').trim() || null;
  const pairUrl = /^https?:\/\//i.test(response.pair_url || '') ? response.pair_url!.trim() : null;
  if (priceUsd === null && marketCapUsd === null && liquidityUsd === null) {
    return null;
  }
  return { priceUsd, marketCapUsd, liquidityUsd, volume24hUsd, priceChange24h, dexId, pairUrl };
}

function positive(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The line under the coin card.
 *
 * Nobody is warned here. At this moment a person is deciding whether to pay, and
 * the absence of a DEX pool means nothing bad: a young coin does not have one,
 * and the buying goes over the pump.fun curve. The old text "no SOL pool found,
 * the buying may not go through" popped up on almost every fresh coin and put
 * people off. That unspent SOL comes back is said in the round rules, not as a
 * separate caveat next to every coin.
 *
 * What remains is one calm fact: where the coin trades now.
 */
function coinVenue(response: AllowTokenResponse): string | null {
  if (response.is_pumpfun_mint === true) {
    return 'On the pump.fun curve';
  }
  if (response.has_dex_liquidity === true) {
    const venue = (response.dex_id || '').trim();
    return venue ? `Trading on ${venue}` : 'Trading on a DEX';
  }
  return null;
}

function mintCheckError(error: unknown): string {
  const detail = httpDetail(error);
  if (/invalid mint/i.test(detail)) {
    return 'That is not a Solana token address.';
  }
  if (/USDC|wSOL|SOL\/wSOL/i.test(detail)) {
    return 'SOL, wSOL and USDC are not memecoins. Paste the address of the coin you want bought.';
  }
  if (/bonding curve is not denominated in SOL/i.test(detail)) {
    return 'This coin trades against something other than SOL on pump.fun, so it cannot be bought until it graduates.';
  }
  if (/no tradable liquidity/i.test(detail)) {
    return 'This coin has no liquidity to buy from.';
  }
  if (error instanceof HttpErrorResponse && error.status === 401) {
    return 'Sign in again to check coins.';
  }
  return 'Could not check this coin. Try again in a moment.';
}

function walletError(error: unknown): string {
  const text = errorText(error);
  if (/not been authorized|not authorized|unauthorized/i.test(text)) {
    return 'The wallet did not allow the connection. Approve it in the wallet and try again.';
  }
  return text || 'Could not connect the wallet.';
}

/** Program (IDL) and network errors, in human words. */
function transactionError(error: unknown): string {
  if (error instanceof CommitError) {
    return error.message;
  }
  const pending = buildPendingTransactionMessage(error);
  if (pending) {
    return pending;
  }
  const text = errorText(error);
  if (/NotOpen|not open|Ended|ended|WrongPhase|Paused|paused/.test(text)) {
    return 'This pool no longer takes SOL.';
  }
  if (/TotalLimitExceeded|Total limit exceeded/.test(text)) {
    return 'That would take the pool over its cap. Try a smaller amount.';
  }
  if (/InvalidAmount|Invalid amount/.test(text)) {
    return 'The amount is below the minimum of 0.05 SOL.';
  }
  if (/BlockedBetMint/.test(text)) {
    return 'SOL, wSOL and USDC are not memecoins. Paste the address of the coin you want bought.';
  }
  if (/insufficient (funds|lamports)|Attempt to debit an account but found no record/i.test(text)) {
    return 'Not enough SOL in the wallet to cover the amount and the network fee.';
  }
  if (/blockhash not found|Blockhash not found/i.test(text)) {
    return 'The network moved on before the wallet signed. Try again.';
  }
  const anchor = /Error Message:\s*([^\n]+)/.exec(text)?.[1];
  return anchor ? `Solana rejected the transaction: ${anchor.trim()}` : 'Could not send the transaction. Try again.';
}

function httpDetail(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const detail = (error.error as { detail?: unknown })?.detail;
    return typeof detail === 'string' ? detail : '';
  }
  return errorText(error);
}

function errorText(error: unknown): string {
  if (!error) {
    return '';
  }
  const logs = (error as { logs?: unknown })?.logs;
  const logText = Array.isArray(logs) ? logs.join('\n') : '';
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  return `${message}\n${logText}`.trim();
}
