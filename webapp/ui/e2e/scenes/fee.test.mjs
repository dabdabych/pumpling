// The priority fee: the price comes from the network, but within hard limits.
import assert from 'node:assert/strict';
import {
  estimateFromSamples, priceFor, feeSol, feeLabel, isPriorityLevel,
  MIN_MICRO_LAMPORTS, MAX_ESTIMATE_MICRO_LAMPORTS, MAX_MICRO_LAMPORTS,
  DEPOSIT_COMPUTE_UNITS, PRIORITY_LEVELS, RECOMMENDED_LEVEL
} from './fee.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('the median is taken over non-zero samples', () => {
  // Zeros are slots where nobody paid extra: counting them understates the price.
  const samples = [{ prioritizationFee: 0 }, { prioritizationFee: 0 }, { prioritizationFee: 20000 }, { prioritizationFee: 60000 }, { prioritizationFee: 40000 }];
  assert.equal(estimateFromSamples(samples), 40000);
});

t('the network is silent — there is no estimate', () => {
  assert.equal(estimateFromSamples([]), null);
  assert.equal(estimateFromSamples(null), null);
  assert.equal(estimateFromSamples([{ prioritizationFee: 0 }, { prioritizationFee: 0 }]), null);
  assert.equal(estimateFromSamples([{ prioritizationFee: 'abc' }]), null);
});

t('with no estimate we pay the lower bound', () => {
  assert.equal(priceFor('normal', null), MIN_MICRO_LAMPORTS);
});

t('a cheap network does not push the price below the lower bound', () => {
  assert.equal(priceFor('normal', 10), MIN_MICRO_LAMPORTS);
});

t('an expensive network does not push the normal level above the estimate ceiling', () => {
  assert.equal(priceFor('normal', 5_000_000), MAX_ESTIMATE_MICRO_LAMPORTS);
});

t('the levels ascend and stop at the hard ceiling', () => {
  const estimate = 100_000;
  const prices = PRIORITY_LEVELS.map((level) => priceFor(level, estimate));
  assert.ok(prices[0] < prices[1] && prices[1] < prices[2], prices.join(' '));
  for (const price of prices) {
    assert.ok(price <= MAX_MICRO_LAMPORTS, `${price} > the ceiling`);
  }
  // The most expensive level on the most expensive network does not break the ceiling either.
  assert.ok(priceFor('turbo', 10_000_000) <= MAX_MICRO_LAMPORTS);
});

t('the price in SOL is computed from the requested units', () => {
  // 60000 units × 10000 microlamports = 600 lamports.
  assert.equal(feeSol(MIN_MICRO_LAMPORTS, DEPOSIT_COMPUTE_UNITS), 600 / 1e9);
  // Even the upper limit stays tiny: 0.00012 SOL.
  assert.ok(feeSol(MAX_MICRO_LAMPORTS) < 0.0002, String(feeSol(MAX_MICRO_LAMPORTS)));
});

t('the caption reads for a human, with no exponential notation', () => {
  assert.equal(feeLabel(MIN_MICRO_LAMPORTS), '+0.0000006 SOL');
  assert.equal(feeLabel(MAX_MICRO_LAMPORTS), '+0.00012 SOL');
  assert.ok(!feeLabel(MIN_MICRO_LAMPORTS).includes('e-'));
});

t('the recommended level exists and is known', () => {
  assert.ok(PRIORITY_LEVELS.includes(RECOMMENDED_LEVEL));
  assert.ok(isPriorityLevel(RECOMMENDED_LEVEL));
  assert.equal(isPriorityLevel('cheap'), false);
});

console.log(`\n${n} tests passed`);
