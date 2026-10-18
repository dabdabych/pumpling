/**
 * What the Commit SOL card on the main page says, in every phase of a round.
 *
 * Pure: the card renders what this returns, and the scene tests check it.
 *
 * The card is the coins and candles drawn by Gleb, and the whole card is one
 * link. Over the drawing, in the clear band it leaves between the coins, two
 * lines, as Gleb drew it: the action, and where the round is. On 2026-10-16 a
 * panel with steps, a field and buttons covered the drawing whole, and the
 * drawing is the card's signal to press it (preview decision of 2026-09-16: the
 * card should be the liveliest thing on the screen). A third line was tried
 * the same day and measured against the coins: the band holds two lines and
 * no more, at every size from 320px to 2560px.
 *
 * The title is what pressing the card does, so it changes with the phase:
 * "Promote your coin" only while a pool takes SOL. A pool takes SOL for about
 * 65 minutes of every hour and a half, and the rest of the time it would lead to a
 * page where nothing can be committed. It said "Commit SOL" until 2026-10-16,
 * which names the mechanism rather than what a visitor comes for. The card
 * opens the pool page and nothing more: it opened the commit dialog at once,
 * and Georgiy asked for that to go.
 *
 * It never shows a count that is zero: "0 coins · 0 SOL" tells a visitor that
 * nobody does this, and people do what they see others do.
 */

import { formatClock, formatLongCountdown, msUntil, PoolPhase, PoolSnapshot } from '../../../pool/pool-state';

/** The last finished pool that bought something. */
export interface CtaLastPool {
  id: number;
  totalSol: number;
  buys: number;
}

export interface CtaInput {
  snapshot: PoolSnapshot;
  nowMs: number;
  lastPool: CtaLastPool | null;
}

/** Where the card takes you: the pool page, or a finished pool in the archive. */
export type CtaLink =
  | { to: 'pool' }
  | { to: 'archive'; pool: number };

export interface CtaView {
  phase: PoolPhase;
  /** What pressing the card does: "Promote your coin", "Watch the buys". */
  title: string;
  /** "Pool open · closes in 04:46". */
  status: string;
  /** The round is taking part right now: the dot pulses. */
  live: boolean;
  link: CtaLink;
}

export function poolCta(input: CtaInput): CtaView {
  const { snapshot, nowMs } = input;
  switch (snapshot.phase) {
    case 'loading':
      return { phase: 'loading', title: 'Promote your coin', status: '', live: false, link: { to: 'pool' } };
    case 'launch': {
      const left = formatLongCountdown(msUntil(snapshot.launchAtMs, nowMs));
      return {
        phase: 'launch',
        title: 'See the pool',
        status: left ? `First pool opens in ${left}` : 'First pool opens soon',
        live: false,
        link: { to: 'pool' }
      };
    }
    case 'opening':
      return {
        phase: 'opening',
        title: 'Promote your coin',
        status: 'Pool opening',
        live: true,
        link: { to: 'pool' }
      };
    case 'open': {
      const left = formatClock(msUntil(snapshot.closesAtMs, nowMs));
      return {
        phase: 'open',
        title: 'Promote your coin',
        status: left ? `Pool open · closes in ${left}` : 'Pool open',
        live: true,
        link: { to: 'pool' }
      };
    }
    case 'locked':
      return {
        phase: 'locked',
        title: 'Watch the draw',
        status: snapshot.draw === 'running' ? 'Pool locked · draw in progress' : 'Pool locked · draw starting',
        live: true,
        link: { to: 'pool' }
      };
    case 'buying': {
      const leftMs = msUntil(snapshot.buysEndAtMs, nowMs);
      const left = leftMs !== null && leftMs > 0 ? formatClock(leftMs) : '';
      return {
        phase: 'buying',
        title: 'Watch the buys',
        status: left ? `Buying now · ${left} left` : 'Buying now',
        live: true,
        link: { to: 'pool' }
      };
    }
    case 'waiting':
    case 'done': {
      const left = formatClock(msUntil(snapshot.nextPoolAtMs, nowMs));
      // Only the pool that has just ended: an empty one closed a minute ago is
      // not "the last pool" because an older one bought something.
      const ended = input.lastPool && input.lastPool.id === snapshot.poolId ? input.lastPool : null;
      return {
        phase: snapshot.phase,
        title: ended ? 'See how it ended' : 'See the pool',
        status: left ? `Next pool in ${left}` : 'Next pool opens soon',
        live: false,
        link: ended ? { to: 'archive', pool: ended.id } : { to: 'pool' }
      };
    }
  }
}
