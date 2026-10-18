/**
 * Where each coin's bubble goes in its card. Pure, so the scene tests check it.
 *
 * Sizes: the biggest bubble is twice the smallest across, never more (a card
 * too short for that at a readable size gets a little less), and the ones
 * between are spread by the square root of their SOL, so the order of size is
 * still the order of SOL. Georgiy's call on 2026-10-16: with the area in
 * proportion to the SOL (the data-to-viz.com rule, the first version) a 20 SOL
 * coin dwarfed the rest and the small ones were dots. This is a picture of
 * who is in the pools, not a chart to read amounts off; the amounts are in the
 * line under it and in each link's name. No bubble smaller than a ticker can be
 * read in, none wider than most of the card's height.
 *
 * The bubbles are placed biggest first. The first sits in the middle; each next
 * one takes, of all the spots touching a bubble already placed, the free one
 * nearest the middle, measured in proportion to the card's sides so a wide
 * card fills sideways rather than in a round blob. The scale is the largest
 * at which every bubble fits, found by halving. When even the smallest scale
 * cannot hold them all, the smallest coins are left out, the two-to-one is
 * taken again over the ones left, and the caller says how many went.
 *
 * Deterministic: the same coins in the same card always land in the same
 * places, so nothing jumps when the list is fetched again.
 */

export interface BubbleInput {
  key: string;
  value: number;
}

export interface Bubble {
  key: string;
  x: number;
  y: number;
  r: number;
}

export interface BubbleBox {
  width: number;
  height: number;
}

export interface BubbleOptions {
  /** Kept free along every edge, px. */
  padding: number;
  /** Between two bubbles, px: room for the gentle float and for a ticker hanging 7px below its bubble. */
  gap: number;
  /** The smallest radius, px: a ticker has to fit. */
  minR: number;
  /** The largest bubble's width as a share of the card's shorter side, inside the padding. */
  maxShare: number;
  /** The biggest bubble across, over the smallest. */
  spread: number;
}

export const BUBBLE_DEFAULTS: BubbleOptions = { padding: 10, gap: 10, minR: 26, maxShare: 0.78, spread: 2 };

/** Directions tried around each bubble already placed. */
const DIRECTIONS = 36;
/** Halvings of the scale: past this the difference is under a pixel. */
const SEARCH_STEPS = 18;

export function layoutBubbles(items: BubbleInput[], box: BubbleBox, options: BubbleOptions = BUBBLE_DEFAULTS): Bubble[] {
  const sorted = items
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const inner = Math.min(box.width, box.height) - 2 * options.padding;
  if (sorted.length === 0 || inner < 2 * options.minR) {
    return [];
  }
  const maxR = Math.max(options.minR, (inner * options.maxShare) / 2);

  // As many as fit at the smallest size, biggest first.
  for (let count = sorted.length; count > 0; count--) {
    const chosen = sorted.slice(0, count);
    const values = chosen.map((item) => item.value);
    // `base` is the smallest bubble's radius; the rest are that times their size.
    const radiiAt = (base: number, spread: number) =>
      relativeSizes(values, spread).map((size) => Math.min(maxR, base * size));
    const fits = (base: number, spread: number) => place(radiiAt(base, spread), box, options);

    // Not even all alike at the smallest size: a coin less.
    let best = fits(options.minR, 1);
    if (!best) {
      continue;
    }
    // The widest spread, up to the asked-for one, that fits at the smallest
    // size: a card too short for two to one (1024x600) gets a little less
    // rather than losing a coin.
    let spread = options.spread;
    const atFull = fits(options.minR, spread);
    if (atFull) {
      best = atFull;
    } else {
      let low = 1;
      let high = spread;
      for (let step = 0; step < SEARCH_STEPS; step++) {
        const middle = (low + high) / 2;
        const placed = fits(options.minR, middle);
        if (placed) {
          best = placed;
          low = middle;
        } else {
          high = middle;
        }
      }
      spread = low;
    }
    // Then the biggest scale at that spread.
    let low = options.minR;
    let high = Math.max(options.minR, maxR / spread);
    const atHigh = fits(high, spread);
    if (atHigh) {
      best = atHigh;
    } else {
      for (let step = 0; step < SEARCH_STEPS; step++) {
        const middle = (low + high) / 2;
        const placed = fits(middle, spread);
        if (placed) {
          best = placed;
          low = middle;
        } else {
          high = middle;
        }
      }
    }
    return centre(best, box).map((circle, index) => ({ key: chosen[index].key, ...circle }));
  }
  return [];
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

/**
 * Each value's size against the smallest, from 1 to `spread`, by the square
 * root of the value. All alike: all 1.
 */
export function relativeSizes(values: number[], spread: number): number[] {
  const roots = values.map((value) => Math.sqrt(value));
  const low = Math.min(...roots);
  const high = Math.max(...roots);
  if (high - low < 1e-12) {
    return roots.map(() => 1);
  }
  return roots.map((root) => 1 + ((spread - 1) * (root - low)) / (high - low));
}

/**
 * Every bubble placed, in order, or null if one of them finds no room.
 *
 * What has to fit is the group, not each bubble where it first lands: the
 * group is moved to the middle afterwards. Checking each bubble against the
 * card's edges from a first one fixed in the middle made a row grow evenly both
 * ways, and a wide short card (436x133 at 1024x600) lost a coin that fitted
 * once the row was allowed to lean to one side.
 */
function place(radii: number[], box: BubbleBox, options: BubbleOptions): Circle[] | null {
  const { width, height } = box;
  const { padding, gap } = options;
  const roomX = width - 2 * padding + 1e-6;
  const roomY = height - 2 * padding + 1e-6;
  const cx = width / 2;
  const cy = height / 2;
  const placed: Circle[] = [];
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const fits = (x: number, y: number, r: number) =>
    Math.max(right, x + r) - Math.min(left, x - r) <= roomX && Math.max(bottom, y + r) - Math.min(top, y - r) <= roomY;
  const free = (x: number, y: number, r: number) =>
    placed.every((other) => Math.hypot(other.x - x, other.y - y) >= other.r + r + gap - 1e-6);
  const distance = (x: number, y: number) => ((x - cx) / width) ** 2 + ((y - cy) / height) ** 2;
  const add = (circle: Circle) => {
    placed.push(circle);
    left = Math.min(left, circle.x - circle.r);
    right = Math.max(right, circle.x + circle.r);
    top = Math.min(top, circle.y - circle.r);
    bottom = Math.max(bottom, circle.y + circle.r);
  };

  for (const r of radii) {
    if (placed.length === 0) {
      if (2 * r > roomX || 2 * r > roomY) {
        return null;
      }
      add({ x: cx, y: cy, r });
      continue;
    }
    let best: Circle | null = null;
    let bestDistance = Infinity;
    for (const other of placed) {
      const reach = other.r + r + gap;
      for (let turn = 0; turn < DIRECTIONS; turn++) {
        const angle = (turn / DIRECTIONS) * 2 * Math.PI;
        const x = other.x + reach * Math.cos(angle);
        const y = other.y + reach * Math.sin(angle);
        const d = distance(x, y);
        if (d < bestDistance && fits(x, y, r) && free(x, y, r)) {
          best = { x, y, r };
          bestDistance = d;
        }
      }
    }
    if (!best) {
      return null;
    }
    add(best);
  }
  return placed;
}

/** The group moved to the middle of the card: it grows from one side otherwise. */
function centre(circles: Circle[], box: BubbleBox): Circle[] {
  const left = Math.min(...circles.map((c) => c.x - c.r));
  const right = Math.max(...circles.map((c) => c.x + c.r));
  const top = Math.min(...circles.map((c) => c.y - c.r));
  const bottom = Math.max(...circles.map((c) => c.y + c.r));
  const dx = box.width / 2 - (left + right) / 2;
  const dy = box.height / 2 - (top + bottom) / 2;
  return circles.map((c) => ({ x: c.x + dx, y: c.y + dy, r: c.r }));
}
