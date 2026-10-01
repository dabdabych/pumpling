/**
 * The "Transactions" feed: every transaction the round makes, newest first.
 *
 * Four kinds, told apart by their backing, mark and chip:
 *   - a purchase: SOL in, the venue it went through;
 *   - a delivery: tokens out to up to five wallets in one transaction;
 *   - a burn: tokens destroyed on chain;
 *   - a refund: the SOL the buying did not spend, back to the people behind
 *     the coin, at the end of the round.
 *
 * Pure: the page renders what this returns, and the scene tests check it.
 */

import { compactTokens, tokenValue } from './token-amount';

export type FeedRowKind = 'buy' | 'send' | 'burn' | 'refund';

export interface FeedRow {
  kind: FeedRowKind;
  /** Stable across polls: the transaction, plus the kind (a signature is unique on chain anyway). */
  key: string;
  atMs: number;
  mint: string;
  symbol: string;
  name: string;
  signature: string;
  /** buy: SOL spent; refund: SOL returned. */
  sol?: number;
  /** buy: where it was bought. */
  venue?: string | null;
  /** send and burn: tokens, compact ("4.1M"). Empty when the decimals are unknown. */
  amount?: string;
  /** send and refund: how many wallets the transaction reached. */
  recipients?: number;
  /** send and refund: whether one of them is the person looking. */
  toYou?: boolean;
}

/** A feed, not an archive: the same ceiling the buyer applies to each list. */
export const MAX_FEED_ROWS = 200;

interface FeedInput {
  coins: Array<{ mint: string; decimals: number | null }>;
  purchases: Array<{ mint: string; symbol: string; name: string; signature: string; sol: number; venue: string | null; atMs: number }>;
  deliveries: Array<{ mint: string; symbol: string; name: string; signature: string; raw: string; decimals: number | null; recipients: string[]; atMs: number }>;
  burns: Array<{ mint: string; symbol: string; name: string; signature: string; raw: string; decimals: number | null; atMs: number }>;
  refunds?: Array<{ mint: string; symbol: string; name: string; signature: string; sol: number; recipients: string[]; atMs: number }>;
}

export function buildFeedRows(feed: FeedInput, myWallets: readonly string[] = []): FeedRow[] {
  const decimalsOf = new Map(feed.coins.map((coin) => [coin.mint, coin.decimals]));
  const mine = new Set(myWallets);
  const amount = (raw: string, own: number | null, mint: string) =>
    compactTokens(tokenValue(raw, own ?? decimalsOf.get(mint) ?? null));

  const rows: FeedRow[] = [
    ...feed.purchases.map((item): FeedRow => ({
      kind: 'buy', key: `buy:${item.signature}`, atMs: item.atMs, mint: item.mint, symbol: item.symbol,
      name: item.name, signature: item.signature, sol: item.sol, venue: item.venue
    })),
    ...feed.deliveries.map((item): FeedRow => ({
      kind: 'send', key: `send:${item.signature}`, atMs: item.atMs, mint: item.mint, symbol: item.symbol,
      name: item.name, signature: item.signature, amount: amount(item.raw, item.decimals, item.mint),
      recipients: item.recipients.length, toYou: item.recipients.some((wallet) => mine.has(wallet))
    })),
    ...feed.burns.map((item): FeedRow => ({
      kind: 'burn', key: `burn:${item.signature}`, atMs: item.atMs, mint: item.mint, symbol: item.symbol,
      name: item.name, signature: item.signature, amount: amount(item.raw, item.decimals, item.mint)
    })),
    // One refund transaction can carry several coins: the key keeps them apart.
    ...(feed.refunds ?? []).map((item): FeedRow => ({
      kind: 'refund', key: `refund:${item.signature}:${item.mint}`, atMs: item.atMs, mint: item.mint, symbol: item.symbol,
      name: item.name, signature: item.signature, sol: item.sol,
      recipients: item.recipients.length, toYou: item.recipients.some((wallet) => mine.has(wallet))
    }))
  ];
  // Newest first, all three kinds mixed; a stable order for equal times.
  rows.sort((a, b) => b.atMs - a.atMs || a.key.localeCompare(b.key));
  return rows.slice(0, MAX_FEED_ROWS);
}

/** "to 5 wallets", "to you + 4", "to you". */
export function recipientsText(row: FeedRow): string {
  const count = row.recipients ?? 0;
  if (row.toYou) {
    return count > 1 ? `to you + ${count - 1}` : 'to you';
  }
  return `to ${count} ${count === 1 ? 'wallet' : 'wallets'}`;
}

/** The same for the chip on a phone, where the row has no room: "to 5", "to you + 4". */
export function recipientsShort(row: FeedRow): string {
  const count = row.recipients ?? 0;
  if (row.toYou) {
    return count > 1 ? `to you + ${count - 1}` : 'to you';
  }
  return `to ${count}`;
}
