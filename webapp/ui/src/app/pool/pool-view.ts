import { formatClock, formatLongCountdown, formatShortClock, formatSol, msUntil, PoolPhase, PoolSnapshot } from './pool-state';
import type { PurchaseFeed } from './purchases.service';

/**
 * What to say about a pool in words: the title, the timer, the caption on the
 * main page. Kept apart from the templates so the pool page and the card on the
 * main page say the same thing, and so the texts can be checked without a browser.
 */

export type PoolTone = 'soon' | 'open' | 'locked' | 'buying' | 'done';

export interface PoolView {
  phase: PoolPhase;
  chip: { label: string; tone: PoolTone };
  title: { lead: string; plate: string };
  lede: string;
  timer: { label: string; value: string; note: string | null; ticking: boolean };
  /**
   * The bar: how much SOL of the cap is in the pool, or how much of the buying window has passed.
   *
   * `pct` is the honest share, `fillPct` is the width of the bar. For a pool they
   * differ deliberately (see `capFill`), and then we do not print the percentage
   * next to the bar, so the number does not argue with the picture: the exact
   * figures are in `label`.
   */
  progress: { label: string; pct: number; fillPct: number; showPct: boolean } | null;
  /** The step number on the scale: 0 open, 1 locked, 2 buying, 3 done; null means there is no pool. */
  step: number | null;
  canCommit: boolean;
}

export function buildPoolView(snapshot: PoolSnapshot, nowMs: number, feed?: PurchaseFeed): PoolView {
  const cap = formatSol(snapshot.capSol);
  const total = formatSol(snapshot.totalSol);
  const capPct = percent(snapshot.totalSol, snapshot.capSol);
  const capProgress = { label: `${total} of ${cap} SOL`, pct: capPct, fillPct: capFill(capPct), showPct: false };

  switch (snapshot.phase) {
    case 'loading':
      return {
        phase: 'loading',
        chip: { label: 'Loading', tone: 'soon' },
        title: { lead: 'The pool', plate: 'is loading' },
        lede: '',
        timer: { label: '', value: '', note: null, ticking: false },
        progress: null,
        step: null,
        canCommit: false
      };
    case 'launch':
      return {
        phase: 'launch',
        chip: { label: 'Soon', tone: 'soon' },
        title: { lead: 'The first pool', plate: 'opens soon' },
        lede: 'When it opens, anyone can name a Solana memecoin and add SOL for an hour. Then that SOL goes into public buys of those coins.',
        timer: { label: 'Opens in', value: formatLongCountdown(msUntil(snapshot.launchAtMs, nowMs)), note: null, ticking: true },
        progress: null,
        step: null,
        canCommit: false
      };
    case 'waiting':
      return {
        phase: 'waiting',
        chip: { label: 'Soon', tone: 'soon' },
        title: { lead: 'The next pool', plate: 'opens soon' },
        lede: 'A new pool opens about every two hours. It starts on its own, and this page switches over the moment it does.',
        timer: { label: 'Next pool', value: 'Opening', note: 'this page switches on its own', ticking: false },
        progress: null,
        step: null,
        canCommit: false
      };
    case 'opening':
      return {
        phase: 'opening',
        chip: { label: 'Soon', tone: 'soon' },
        title: { lead: 'The pool', plate: 'is opening' },
        lede: 'It is being created on Solana right now. SOL can go in within a minute.',
        timer: { label: 'Status', value: 'Opening', note: null, ticking: false },
        progress: null,
        step: 0,
        canCommit: false
      };
    case 'open':
      return {
        phase: 'open',
        chip: { label: 'Open', tone: 'open' },
        title: { lead: 'The pool', plate: 'is open' },
        lede: 'Name any Solana memecoin and add SOL. Everyone sees which coins are in and how much SOL stands behind each. Once SOL is in, nobody can take it back.',
        timer: { label: 'Closes in', value: formatClock(msUntil(snapshot.closesAtMs, nowMs)) || 'Soon', note: `or at ${cap} SOL, whichever comes first`, ticking: snapshot.closesAtMs !== null },
        progress: capProgress,
        step: 0,
        canCommit: true
      };
    case 'locked': {
      const running = snapshot.draw === 'running';
      // The draw takes a few seconds, and without a counter it is unclear how
      // much longer to wait. The exact duration is nobody's to promise: it is
      // an oracle answering. So we count down to the expected moment, and once
      // it has passed we say "any moment now" instead of showing a negative.
      const drawLeftMs = msUntil(snapshot.drawEndsAtMs, nowMs);
      const overdue = drawLeftMs !== null && drawLeftMs <= 0;
      const drawSpanMs = snapshot.drawStartedAtMs !== null && snapshot.drawEndsAtMs !== null
        ? snapshot.drawEndsAtMs - snapshot.drawStartedAtMs
        : null;
      return {
        phase: 'locked',
        chip: { label: 'Locked', tone: 'locked' },
        title: { lead: 'The pool', plate: 'is locked' },
        lede: running
          ? 'No more SOL can go in. The draw is running on ORAO VRF. It sets each coin\'s share of the buy.'
          : 'No more SOL can go in. The draw starts in a moment and sets each coin\'s share of the buy.',
        timer: drawLeftMs !== null && !overdue
          ? { label: 'Draw ends in', value: `~${formatShortClock(drawLeftMs)}`, note: null, ticking: true }
          : { label: 'Draw', value: overdue ? 'Any moment now' : (running ? 'In progress' : 'Starting'), note: overdue ? 'The oracle is taking longer than usual' : null, ticking: false },
        progress: drawSpanMs !== null && drawSpanMs > 0 && drawLeftMs !== null
          ? linear('Draw', percent(drawSpanMs - drawLeftMs, drawSpanMs))
          : capProgress,
        step: 1,
        canCommit: false
      };
    }
    case 'buying': {
      const windowMs = snapshot.buysStartedAtMs !== null && snapshot.buysEndAtMs !== null
        ? snapshot.buysEndAtMs - snapshot.buysStartedAtMs
        : null;
      const leftMs = msUntil(snapshot.buysEndAtMs, nowMs);
      // While the buyer is silent we honestly show the window time. As soon as it
      // answers, the bar becomes real: how much SOL has already been spent.
      const bought = feed && feed.available && feed.targetSol > 0
        ? linear(`${formatSol(feed.boughtSol)} of ${formatSol(feed.targetSol)} SOL bought`, percent(feed.boughtSol, feed.targetSol))
        : null;
      const progress = bought ?? (windowMs !== null && leftMs !== null && windowMs > 0
        ? linear('Buy window', percent(windowMs - leftMs, windowMs))
        : null);

      // The second pass. The main window is over and something could not be
      // bought in full, so those coins are being bought again. It is its own
      // countdown: the main one has already run out, and leaving it at zero
      // while purchases are still going out reads as a stuck page.
      if (feed?.phase === 'fallback') {
        const fallbackLeftMs = msUntil(feed.fallbackEndsAtMs, nowMs);
        return {
          phase: 'buying',
          chip: { label: 'Buying', tone: 'buying' },
          title: { lead: 'Buying what is', plate: 'left' },
          lede: 'Some of the buys did not go through the first time round, so the coins that came up short are being bought again. Everything that gets bought goes to the people who backed those coins, exactly as before.',
          timer: fallbackLeftMs === null
            ? { label: 'Second pass', value: 'Running', note: 'buying what the first pass missed', ticking: false }
            : fallbackLeftMs > 0
              ? { label: 'Second pass ends in', value: formatClock(fallbackLeftMs), note: 'then this pool wraps up', ticking: true }
              : { label: 'Second pass', value: 'Finishing', note: 'the last purchases are going through', ticking: false },
          progress,
          step: 2,
          canCommit: false
        };
      }

      // Nothing is left to buy. The pool still closes at the end of its
      // window and not before, so the countdown goes on, to the close: in a
      // small round that can be twenty-five minutes, which "shortly" was not.
      // Past the end the close is a matter of seconds and there is nothing to
      // count.
      const wrapUp: PoolView['timer'] = leftMs !== null && leftMs > 0
        ? { label: 'Pool wraps up in', value: formatClock(leftMs), note: null, ticking: true }
        : { label: 'Pool', value: 'Wrapping up', note: null, ticking: false };

      // "Nothing left to buy" is two different stories. When not one purchase
      // went through, every coin failed and the SOL is on its way back; saying
      // the buys were made was a lie, and on devnet, where mainnet coins do not
      // exist, it was the only thing the page ever said.
      if (feed?.phase === 'finished' && feed.completed === 0) {
        return {
          phase: 'buying',
          chip: { label: 'Buying', tone: 'buying' },
          title: { lead: 'Nothing could be', plate: 'bought' },
          lede: 'None of the coins in this pool could be bought. The SOL goes back to the wallets that put it in, less the pool fee and the network fees.',
          timer: { ...wrapUp, note: 'the SOL is on its way back' },
          progress,
          step: 2,
          canCommit: false
        };
      }
      if (feed?.phase === 'finished') {
        return {
          phase: 'buying',
          chip: { label: 'Buying', tone: 'buying' },
          title: { lead: 'The buys are', plate: 'done' },
          lede: 'The buying is over. The tokens are on their way to the wallets that backed each coin, and whatever could not be spent goes back to them.',
          timer: { ...wrapUp, note: 'nothing more to buy' },
          progress,
          step: 2,
          canCommit: false
        };
      }

      return {
        phase: 'buying',
        chip: { label: 'Buying', tone: 'buying' },
        title: { lead: 'Buys are', plate: 'running' },
        lede: 'The SOL goes into public on-chain buys, in small batches spread across the hour. What gets bought goes to the people who backed each coin.',
        // Past the end of the window with the buyer still at it: the last
        // purchase is on its way, and the pool waits for it. A clock frozen at
        // 00:00:00 would say the buying is over while it is not.
        timer: leftMs === null
          ? { label: 'Buys', value: 'Starting', note: null, ticking: false }
          : leftMs > 0
            ? { label: 'Buys end in', value: formatClock(leftMs), note: 'then this pool wraps up', ticking: true }
            : { label: 'Buys', value: 'Finishing', note: 'the last purchases are going through', ticking: false },
        progress,
        step: 2,
        canCommit: false
      };
    }
    case 'done': {
      // The round is over: bought, delivered, the change returned.
      //
      // What this used to say was that the next pool opens on its own, with a
      // countdown to it. That is only true while the cycle is running, and the
      // cycle is a switch of its own — after the launch round of 2026-09-25 it
      // was turned off on purpose, and the page went on promising a pool that
      // nothing was going to open. The countdown here comes from this round's
      // own buying window, so it cannot tell a stopped cycle from a running
      // one and there is nothing honest to count down to.
      //
      // So it says what is true either way and points at the archive, and the
      // page still switches by itself the moment a pool does open.
      const nextLeftMs = msUntil(snapshot.nextPoolAtMs, nowMs);
      return {
        phase: 'done',
        chip: { label: 'Done', tone: 'done' },
        title: { lead: 'This pool', plate: 'is done' },
        lede: 'The buys are over. The tokens went to the wallets that backed each coin, and the SOL that was not spent went back.',
        // Never null: the card reads `timer.label` without a guard, and a null
        // here threw on every render and left the page on its loading skeleton.
        timer: nextLeftMs !== null && nextLeftMs > 0
          ? { label: 'Next pool in', value: formatShortClock(nextLeftMs), note: 'this page switches on its own', ticking: true }
          : { label: 'This pool', value: 'Closed', note: 'the page switches on its own when a pool opens', ticking: false },
        progress: null,
        step: 3,
        canCommit: false
      };
    }
  }
}

/** One line for the card on the main page: what the pool is doing right now. */
export function poolCardLine(snapshot: PoolSnapshot, nowMs: number): string {
  switch (snapshot.phase) {
    case 'loading':
      return '';
    case 'launch':
      return `First pool opens in ${formatLongCountdown(msUntil(snapshot.launchAtMs, nowMs))}`;
    case 'opening':
      return 'Pool opening';
    case 'open': {
      const left = formatClock(msUntil(snapshot.closesAtMs, nowMs));
      return left ? `Pool open · closes in ${left}` : 'Pool open';
    }
    case 'locked':
      return snapshot.draw === 'running' ? 'Pool locked · draw in progress' : 'Pool locked · draw starting';
    case 'buying': {
      // Zero left does not mean the buying is over: what the first pass could
      // not buy is bought again afterwards, and that has its own clock, which
      // this card does not follow. Better to drop the number than to show a
      // countdown stuck at nothing.
      const leftMs = msUntil(snapshot.buysEndAtMs, nowMs);
      const left = leftMs !== null && leftMs > 0 ? formatClock(leftMs) : '';
      return left ? `Buys running · ${left} left` : 'Buys running';
    }
    case 'waiting':
    case 'done':
      return 'Next pool opens soon';
  }
}

/**
 * A second line for the card, while there is no pool to look at.
 *
 * "Next pool opens soon" says nothing about when, and a person who has come
 * between rounds has nothing to do with that. This is the one thing they can
 * do: the X account is where a pool is announced before it opens. It is not
 * shown while a pool is running — then the card has the round itself to talk
 * about, and a second line would only get in the way.
 */
export function poolCardNote(snapshot: PoolSnapshot): string | null {
  return snapshot.phase === 'waiting' || snapshot.phase === 'done'
    ? 'We announce the next pool on our X'
    : null;
}

/** A bar where the width equals the share: the window time, the bought fraction. */
function linear(label: string, pct: number): { label: string; pct: number; fillPct: number; showPct: boolean } {
  return { label, pct, fillPct: pct, showPct: true };
}

/**
 * The width of the pool bar. It grows faster than the share: half the bar covers
 * 36% of the cap, that is 40 SOL out of 111.
 *
 * Why. A pool does not fill evenly: the first commits arrive one at a time, and
 * with an honest width the bar barely moves for hours — an empty bar reads as
 * "nobody is coming here" and puts people off. The exponent comes from that
 * requirement: 0.36 ^ 0.68 = 0.5.
 *
 * There is nothing to lie about: the exact figures are captioned next to the bar,
 * and the percentage is not printed in this place at all.
 */
function capFill(pct: number): number {
  if (pct <= 0) {
    return 0;
  }
  return Math.min(100, Math.pow(pct / 100, 0.68) * 100);
}

function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (part / whole) * 100));
}
