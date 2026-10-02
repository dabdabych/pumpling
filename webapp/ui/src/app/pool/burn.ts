/**
 * The burn choice: a participant can have part of what is bought for them
 * burned instead of delivered.
 *
 * The choice is not sent to the backend. It goes into the commit transaction
 * itself as a memo the wallet signs with the deposit, so it is as public and as
 * final as the deposit: `pumpling burn 50%`. The backend and the events worker
 * read it back from that transaction (`webapp/backend/shared/burn_memo.py`), and
 * the buyer burns that share of the wallet's tokens, exactly:
 *
 *   delivered to you = your share of what was bought × (100% − your burn)
 *
 * Nobody else's choice changes what you get. No memo at all is 0%.
 *
 * Pure: no Angular, no web3. The instruction itself is built in
 * `commit.service.ts`; this is what it says and what the dialog says about it.
 */

export type BurnPercent = 0 | 25 | 50 | 100;

export const BURN_CHOICES: readonly BurnPercent[] = [0, 25, 50, 100];

/**
 * The SPL Memo program the backend reads: under the non-upgradeable loader,
 * so what it does cannot change. Other memo versions are not read.
 */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export function isBurnPercent(value: unknown): value is BurnPercent {
  return value === 0 || value === 25 || value === 50 || value === 100;
}

/** The memo that carries the choice, or null for none. Measured: ~21,000 compute units. */
export function burnMemoText(percent: BurnPercent): string | null {
  return percent > 0 ? `pumpling burn ${percent}%` : null;
}

/** Under the percentage on each card. */
export function burnKeepLabel(percent: BurnPercent): string {
  switch (percent) {
    case 0:
      return 'keep all';
    case 25:
      return 'keep 75%';
    case 50:
      return 'keep half';
    case 100:
      return 'keep none';
  }
}

/**
 * The sentence under the cards, in three parts so the middle can be bold.
 * It is the one place the choice is said in full, and on a narrow phone the
 * cards lose their captions, so it has to stand on its own.
 */
export function burnSentence(percent: BurnPercent): { before: string; bold: string; after: string } {
  switch (percent) {
    case 0:
      return { before: 'Every token bought for you comes to your wallet.', bold: '', after: '' };
    case 25:
      return { before: 'A quarter of the tokens bought for you is ', bold: 'burned on chain', after: '. The rest comes to your wallet.' };
    case 50:
      return { before: 'Half of the tokens bought for you are ', bold: 'burned on chain', after: '. The other half comes to your wallet.' };
    case 100:
      return { before: 'Every token bought for you is ', bold: 'burned on chain', after: '. Nothing comes to your wallet.' };
  }
}

/** The end of the summary line, "10 SOL goes behind $MOCHI · …". Empty for none. */
export function burnSummary(percent: BurnPercent): string {
  switch (percent) {
    case 0:
      return '';
    case 25:
      return "a quarter of what's bought for you is burned";
    case 50:
      return "half of what's bought for you is burned";
    case 100:
      return "everything bought for you is burned";
  }
}

/**
 * A coin's burn share as the chip on its row says it: "50% BURN". Whole
 * percent; anything above zero shows at least 1%, so a burn never reads as none.
 */
export function burnChipText(bps: number | null | undefined): string | null {
  const percent = burnChipPercent(bps);
  return percent === null ? null : `${percent}% BURN`;
}

/** The chip's whole percent, or null for no burn. */
export function burnChipPercent(bps: number | null | undefined): number | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) {
    return null;
  }
  return Math.min(100, Math.max(1, Math.round(bps / 100)));
}

/** What the card under a burn chip says. */
export interface BurnCard {
  title: string;
  lead: string;
  note: string;
  /** While the pool takes commits, the coin's share still moves. */
  live: string | null;
}

/**
 * The card a burn chip opens.
 *
 * On a coin's row the chip is the coin's burn so far: the SOL-weighted average
 * of what its backers asked for, Σ(sol × bps) / Σ sol, which is exactly the share
 * of the coin's purchase the buyer burns (`offchain/orchestrator/shares.ts`:
 * burned = B × Σ(s × bps) / (S × 10000)). The card says so, and says that each
 * backer burns only their own share: read alone, "50% burn" sounds like half of
 * everybody's tokens go.
 *
 * On my page (`mine`) the chip is my own choice, weighted the same way over my
 * commits to the coin.
 */
export function burnCard(bps: number | null | undefined, ticker: string, options: { mine?: boolean; live?: boolean } = {}): BurnCard | null {
  const percent = burnChipPercent(bps);
  if (percent === null) {
    return null;
  }
  const coin = ticker ? `$${ticker}` : 'tokens';
  const all = percent === 100;
  const title = `${percent}% burn`;
  if (options.mine) {
    return {
      title,
      lead: all
        ? `All the ${coin} bought for you is burned on chain during the buy.`
        : `${percent}% of the ${coin} bought for you is burned on chain during the buy.`,
      note: all ? 'You chose it when you committed. Nothing comes to your wallet.' : 'You chose it when you committed. The rest comes to your wallet.',
      live: null
    };
  }
  return {
    title,
    lead: all
      ? `All the ${coin} this pool buys is burned on chain during the buy.`
      : `${percent}% of the ${coin} this pool buys is burned on chain during the buy.`,
    note: all
      ? 'Every backer chose to burn their whole share. Nothing goes to wallets.'
      : 'Each backer chose how much of their own share to burn. The rest goes to their wallets.',
    live: options.live ? 'It changes with every commit until the pool closes.' : null
  };
}

/** The chip's accessible name: its own words first, then what pressing it does. */
export function burnChipLabel(bps: number | null | undefined): string | null {
  const percent = burnChipPercent(bps);
  return percent === null ? null : `${percent}% burn. What it means`;
}
