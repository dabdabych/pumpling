/**
 * The burn section of the verification window, worked out from the backend's
 * `burns` block. Pure: the template renders this, the scene tests check it.
 *
 * What it must never do is claim more than the numbers show. "The supply went
 * down by exactly this much" is said only when it did; anyone else burning the
 * same coin during the round makes it "at least", and a supply that went up
 * (a mint with an authority still minting) is said plainly rather than
 * explained away.
 */

import { compactTokens, exactTokens, tokenValue } from '../../pool/token-amount';

export interface VerificationBurn {
  mint: string;
  name: string;
  symbol: string;
  decimals: number | null;
  coin_sol: number;
  burn_bps: number;
  bets: Array<{ wallet: string; sol: number; burn_bps: number; signature: string | null }>;
  bought_raw: string | null;
  owed_raw: string | null;
  burned_raw: string | null;
  supply_at_start: string | null;
  supply_at_end: string | null;
  blocked_reason: string | null;
  transactions: Array<{ signature: string; raw_amount: string; at: string }>;
  final: boolean;
}

export type BurnVerdict = 'ok' | 'bad' | 'neutral';

export interface BurnView {
  mint: string;
  symbol: string;
  /** Exact whole tokens ("52,313,440") and the same compact ("52.3M") for a narrow screen. */
  burned: string;
  burnedCompact: string;
  owed: string;
  /** How far the fuse has burned, 0..100. Null when there is nothing to measure against. */
  progress: number | null;
  caption: string;
  verdict: BurnVerdict;
  verdictText: string;
  supplyBefore: string;
  supplyAfter: string;
  /** Who asked, with their share as text ("100%", "50%"). */
  bets: Array<{ wallet: string; sol: number; percent: string; signature: string | null }>;
  coinSol: number;
  coinPercent: string;
  transactions: Array<{ signature: string; amount: string; atMs: number }>;
}

export function percentText(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) {
    return '0%';
  }
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1).replace(/\.0$/, '')}%`;
}

export function buildBurnView(burn: VerificationBurn): BurnView {
  const decimals = burn.decimals;
  const burnedRaw = burn.burned_raw ?? '0';
  const owedRaw = burn.owed_raw;
  const burned = BigInt(/^\d+$/.test(burnedRaw) ? burnedRaw : '0');
  const owed = owedRaw && /^\d+$/.test(owedRaw) ? BigInt(owedRaw) : null;

  let progress: number | null = null;
  if (owed !== null && owed > 0n) {
    progress = Math.min(100, Number((burned * 10_000n) / owed) / 100);
  } else if (owed === 0n) {
    progress = 0;
  }

  const complete = owed !== null && burned >= owed && owed > 0n;
  let caption: string;
  if (burn.blocked_reason) {
    caption = 'destroyed on chain · burning stopped';
  } else if (!burn.final) {
    caption = 'destroyed on chain · the buying is still running';
  } else if (complete) {
    caption = 'destroyed on chain · everything that was asked for';
  } else {
    caption = 'destroyed on chain';
  }

  let verdict: BurnVerdict;
  let verdictText: string;
  if (burn.blocked_reason) {
    verdict = 'bad';
    verdictText = `Burning stopped: ${burn.blocked_reason}. The rest of the burn share stays with the buyer and is delivered to no one.`;
  } else if (!burn.final) {
    verdict = 'ok';
    verdictText = 'Burning as the buying goes: every burn so far is a transaction on chain';
  } else {
    const drop = supplyDrop(burn.supply_at_start, burn.supply_at_end);
    if (drop === null) {
      verdict = complete ? 'ok' : 'neutral';
      verdictText = 'Every burn is a transaction on chain';
    } else if (drop === burned && complete) {
      verdict = 'ok';
      verdictText = 'Every burn is a transaction on chain, and the supply went down by exactly this much';
    } else if (drop > burned && complete) {
      verdict = 'ok';
      verdictText = 'Every burn is a transaction on chain. The supply went down by at least this much: others burned this coin too';
    } else if (drop < burned) {
      verdict = 'neutral';
      verdictText = 'Every burn is a transaction on chain. The supply did not go down by as much: the coin was minted during the round';
    } else {
      verdict = 'neutral';
      verdictText = 'Every burn is a transaction on chain';
    }
  }

  return {
    mint: burn.mint,
    symbol: burn.symbol,
    burned: exactTokens(burnedRaw, decimals) || '—',
    burnedCompact: compactTokens(tokenValue(burnedRaw, decimals)) || '—',
    owed: owedRaw ? exactTokens(owedRaw, decimals) || '—' : '—',
    progress,
    caption,
    verdict,
    verdictText,
    supplyBefore: exactTokens(burn.supply_at_start, decimals) || '—',
    supplyAfter: exactTokens(burn.supply_at_end, decimals) || (burn.final ? '—' : 'after the round'),
    bets: burn.bets.map((bet) => ({ wallet: bet.wallet, sol: bet.sol, percent: percentText(bet.burn_bps), signature: bet.signature })),
    coinSol: burn.coin_sol,
    coinPercent: percentText(burn.burn_bps),
    transactions: burn.transactions.map((tx) => ({
      signature: tx.signature,
      amount: exactTokens(tx.raw_amount, decimals) || '—',
      atMs: Date.parse(tx.at) || 0
    }))
  };
}

/** start − end, raw; null when either is unknown. */
function supplyDrop(start: string | null, end: string | null): bigint | null {
  if (!start || !end || !/^\d+$/.test(start) || !/^\d+$/.test(end)) {
    return null;
  }
  return BigInt(start) - BigInt(end);
}

/** Where the flame sits on the fuse: never half off either end. */
export function fuseLeft(progress: number | null): string {
  const p = progress ?? 0;
  return `clamp(12px, ${p}%, calc(100% - 12px))`;
}
