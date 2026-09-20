import { formatClock, formatLongCountdown, formatShortClock, formatSol, msUntil, PoolPhase, PoolSnapshot } from './pool-state';
import { PurchaseFeed } from './purchases.service';

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
        lede: 'When it opens, anyone can name a Solana memecoin and add SOL for two hours. Then that SOL goes into public buys of those coins.',
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
      return {
        phase: 'buying',
        chip: { label: 'Buying', tone: 'buying' },
        title: { lead: 'Buys are', plate: 'running' },
        lede: 'The SOL goes into public on-chain buys, in small batches spread across the hour. What gets bought goes to the people who backed each coin.',
        timer: leftMs !== null
          ? { label: 'Buys end in', value: formatClock(leftMs), note: 'then this pool wraps up', ticking: true }
          : { label: 'Buys', value: 'Starting', note: null, ticking: false },
        progress: bought ?? (windowMs !== null && leftMs !== null && windowMs > 0
          ? linear('Buy window', percent(windowMs - leftMs, windowMs))
          : null),
        step: 2,
        canCommit: false
      };
    }
    case 'done': {
      // The pause between rounds: while it runs, the page shows how long until
      // the next pool rather than a vague "soon".
      const nextLeftMs = msUntil(snapshot.nextPoolAtMs, nowMs);
      return {
        phase: 'done',
        chip: { label: 'Done', tone: 'done' },
        title: { lead: 'This pool', plate: 'is done' },
        lede: 'The buys are over. The next pool opens on its own, and this page switches over the moment it does.',
        timer: nextLeftMs !== null && nextLeftMs > 0
          ? { label: 'Next pool in', value: formatShortClock(nextLeftMs), note: 'this page switches on its own', ticking: true }
          : { label: 'Next pool', value: 'Opening', note: 'this page switches on its own', ticking: false },
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
      const left = formatClock(msUntil(snapshot.buysEndAtMs, nowMs));
      return left ? `Buys running · ${left} left` : 'Buys starting';
    }
    case 'waiting':
    case 'done':
      return 'Next pool opens soon';
  }
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
