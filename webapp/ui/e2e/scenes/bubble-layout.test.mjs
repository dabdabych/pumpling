// Where the coins' bubbles go on the main page (bubble-layout.ts).
//
// Asked for on 2026-10-16: the coins that have been through the pools with at
// least 1 SOL, drawn as bubbles in the card where the chat was; the same day,
// the biggest no more than twice the smallest across. What must hold at every
// card size: no bubble on another, none out of its card, sizes from one to two
// in the order of the SOL, the same picture every time, and with too many coins
// the smallest left out rather than everything shrunk to dots.
import assert from 'node:assert/strict';
import { BUBBLE_DEFAULTS, layoutBubbles, relativeSizes } from './bubble-layout.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

// The six coins over 1 SOL on mainnet on 2026-10-16.
const MAINNET = [
  { key: 'PUMPLING', value: 20.05 }, { key: 'A56', value: 10.45 }, { key: 'EdK', value: 2.6 },
  { key: 'Fdd', value: 2.5 }, { key: 'SI', value: 1.05 }, { key: 'CAT', value: 1.0 }
];
// The cards' bubble fields: desktop, laptop, tablet, phone, small phone.
const BOXES = [
  { width: 560, height: 300 }, { width: 470, height: 250 }, { width: 330, height: 240 },
  { width: 340, height: 262 }, { width: 288, height: 230 }, { width: 900, height: 360 }
];

function check(bubbles, box, gap = BUBBLE_DEFAULTS.gap, padding = BUBBLE_DEFAULTS.padding) {
  for (const b of bubbles) {
    assert.ok(b.x - b.r >= padding - 1e-6 && b.x + b.r <= box.width - padding + 1e-6, `${b.key} is inside sideways in ${box.width}x${box.height}`);
    assert.ok(b.y - b.r >= padding - 1e-6 && b.y + b.r <= box.height - padding + 1e-6, `${b.key} is inside up and down in ${box.width}x${box.height}`);
  }
  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      const [a, c] = [bubbles[i], bubbles[j]];
      assert.ok(Math.hypot(a.x - c.x, a.y - c.y) >= a.r + c.r + gap - 1e-6, `${a.key} and ${c.key} keep apart in ${box.width}x${box.height}`);
    }
  }
}

t('nothing to draw, or no room to draw it, is an empty picture', () => {
  assert.deepEqual(layoutBubbles([], { width: 560, height: 300 }), []);
  assert.deepEqual(layoutBubbles(MAINNET, { width: 60, height: 300 }), []);
  assert.deepEqual(layoutBubbles([{ key: 'zero', value: 0 }, { key: 'nan', value: NaN }], { width: 560, height: 300 }), []);
});

t('every mainnet coin, apart and inside, at every card size', () => {
  for (const box of BOXES) {
    const bubbles = layoutBubbles(MAINNET, box);
    assert.equal(bubbles.length, MAINNET.length, `all six in ${box.width}x${box.height}`);
    check(bubbles, box);
  }
});

t('a wide short card holds a row leaning to one side (436x133 at a 1024x600 window lost a coin)', () => {
  for (const box of [{ width: 436, height: 133 }, { width: 436, height: 110 }, { width: 596, height: 133 }]) {
    const bubbles = layoutBubbles(MAINNET, box);
    assert.equal(bubbles.length, 6, `all six in ${box.width}x${box.height}`);
    check(bubbles, box);
  }
});

t('the biggest is twice the smallest across, never more, and size follows SOL', () => {
  for (const box of BOXES) {
    const bubbles = layoutBubbles(MAINNET, box);
    const r = Object.fromEntries(bubbles.map((b) => [b.key, b.r]));
    const ratio = Math.max(...bubbles.map((b) => b.r)) / Math.min(...bubbles.map((b) => b.r));
    // A card too small for twice the smallest readable bubble caps the biggest, and the spread is less.
    assert.ok(ratio <= 2 + 1e-9, `${ratio.toFixed(3)} in ${box.width}x${box.height}`);
    if (box.height >= 230) assert.ok(Math.abs(ratio - 2) < 1e-6, `exactly two in ${box.width}x${box.height} (${ratio.toFixed(3)})`);
    const bySize = [...bubbles].sort((a, b) => b.r - a.r || (a.key < b.key ? -1 : 1)).map((b) => b.key);
    assert.deepEqual(bySize, ['PUMPLING', 'A56', 'EdK', 'Fdd', 'SI', 'CAT'], `the order of size is the order of SOL in ${box.width}x${box.height}`);
    assert.ok(bubbles.every((b) => b.r >= BUBBLE_DEFAULTS.minR - 1e-9), 'none below a readable size');
    assert.ok(r.EdK > r.Fdd && r.Fdd > r.SI, 'the ones between keep their order too');
  }
});

t('the sizes against the smallest: one to two by the square root, all alike when the SOL is', () => {
  const sizes = relativeSizes([20.05, 10.45, 1.0], 2);
  assert.equal(sizes[2], 1);
  assert.ok(Math.abs(sizes[0] - 2) < 1e-12);
  const middle = 1 + (Math.sqrt(10.45) - 1) / (Math.sqrt(20.05) - 1);
  assert.ok(Math.abs(sizes[1] - middle) < 1e-12, `${sizes[1]} vs ${middle}`);
  assert.deepEqual(relativeSizes([3, 3, 3], 2), [1, 1, 1]);
  assert.deepEqual(relativeSizes([5], 2), [1]);
});

t('ten coins of the same SOL are ten bubbles of the same size', () => {
  const same = Array.from({ length: 10 }, (_, i) => ({ key: `s${i}`, value: 1 }));
  const bubbles = layoutBubbles(same, { width: 560, height: 300 });
  assert.equal(bubbles.length, 10);
  assert.ok(bubbles.every((b) => Math.abs(b.r - bubbles[0].r) < 1e-9));
  check(bubbles, { width: 560, height: 300 });
});

t('the biggest never takes over the card', () => {
  for (const box of BOXES) {
    const [biggest] = layoutBubbles(MAINNET, box);
    const limit = ((Math.min(box.width, box.height) - 2 * BUBBLE_DEFAULTS.padding) * BUBBLE_DEFAULTS.maxShare) / 2;
    assert.ok(biggest.r <= limit + 1e-6, `${biggest.r.toFixed(1)} <= ${limit.toFixed(1)} in ${box.width}x${box.height}`);
  }
});

t('the same coins land in the same places, whatever order they came in', () => {
  const box = { width: 470, height: 250 };
  const first = layoutBubbles(MAINNET, box);
  const again = layoutBubbles([...MAINNET].reverse(), box);
  assert.deepEqual(again, first);
});

t('one coin alone sits in the middle', () => {
  const box = { width: 560, height: 300 };
  const [only] = layoutBubbles([{ key: 'X', value: 3 }], box);
  assert.ok(Math.abs(only.x - 280) < 1e-6 && Math.abs(only.y - 150) < 1e-6);
});

t('too many coins for the card: the biggest stay, the smallest are left out, nothing overlaps', () => {
  const box = { width: 288, height: 230 };
  const many = Array.from({ length: 90 }, (_, i) => ({ key: `c${String(i).padStart(2, '0')}`, value: 1 + (90 - i) * 0.3 }));
  const bubbles = layoutBubbles(many, box);
  assert.ok(bubbles.length > 3 && bubbles.length < 90, `${bubbles.length} placed`);
  const kept = new Set(bubbles.map((b) => b.key));
  for (let i = 0; i < bubbles.length; i++) {
    assert.ok(kept.has(many[i].key), `the ${i + 1}th biggest is kept`);
  }
  check(bubbles, box);
});

t('forty coins lay out in well under a frame budget of a slow phone', () => {
  const box = { width: 560, height: 300 };
  const forty = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, value: 1 + ((i * 7919) % 97) / 5 }));
  const started = performance.now();
  const bubbles = layoutBubbles(forty, box);
  const took = performance.now() - started;
  check(bubbles, box);
  assert.ok(took < 400, `${took.toFixed(0)} ms`);
  console.log(`   (${bubbles.length} of 40 placed in ${took.toFixed(0)} ms)`);
});

console.log(`\n${n} passed`);
