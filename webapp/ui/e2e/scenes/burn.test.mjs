// The burn, without a browser: the memo the site signs, the words around the
// choice, token amounts, the feed rows, the verification window's section.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BURN_CHOICES, MEMO_PROGRAM_ID, burnCard, burnChipLabel, burnChipText, burnKeepLabel, burnMemoText, burnSentence, burnSummary, isBurnPercent } from './burn.mjs';
import { compactTokens, exactTokens, tokenValue } from './token-amount.mjs';
import { buildFeedRows, recipientsShort, recipientsText, MAX_FEED_ROWS } from './feed-rows.mjs';
import { buildBurnView, fuseLeft, percentText } from './burn-view.mjs';
import { DEPOSIT_COMPUTE_UNITS, MEASURED_DEPOSIT_UNITS, MEASURED_MEMO_UNITS } from './fee.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

// --- the memo ----------------------------------------------------------------

t('the memo the site signs is exactly what the backend reads', () => {
  // The Python side's fixture is keyed by the memo texts it parses from the
  // real memo program's log (webapp/backend/tests/fixtures/burn_memo_logs.json).
  const fixture = JSON.parse(readFileSync(join(here, '..', '..', '..', 'backend', 'tests', 'fixtures', 'burn_memo_logs.json'), 'utf8'));
  const parsed = Object.keys(fixture.memo_frames).sort();
  const signed = BURN_CHOICES.map(burnMemoText).filter(Boolean).sort();
  assert.deepEqual(signed, parsed);
  // And the program is the one the backend reads.
  assert.ok(JSON.stringify(fixture.memo_frames).includes(MEMO_PROGRAM_ID));
});

t('no burn, no memo', () => {
  assert.equal(burnMemoText(0), null);
});

t('the choices are 0, 25, 50, 100 and nothing else', () => {
  assert.deepEqual([...BURN_CHOICES], [0, 25, 50, 100]);
  for (const bad of [1, 75, '50', null, undefined, 150]) {
    assert.equal(isBurnPercent(bad), false);
  }
});

t('each card and sentence says what happens to the tokens', () => {
  assert.deepEqual(BURN_CHOICES.map(burnKeepLabel), ['keep all', 'keep 75%', 'keep half', 'keep none']);
  const sentences = BURN_CHOICES.map((p) => { const s = burnSentence(p); return s.before + s.bold + s.after; });
  assert.equal(sentences[0], 'Every token bought for you comes to your wallet.');
  assert.equal(sentences[1], 'A quarter of the tokens bought for you is burned on chain. The rest comes to your wallet.');
  assert.equal(sentences[2], 'Half of the tokens bought for you are burned on chain. The other half comes to your wallet.');
  assert.equal(sentences[3], 'Every token bought for you is burned on chain. Nothing comes to your wallet.');
  assert.equal(burnSummary(0), '');
  assert.equal(burnSummary(50), "half of what's bought for you is burned");
});

t('the coin chip rounds to whole percent and never says 0 for a burn', () => {
  assert.equal(burnChipText(0), null);
  assert.equal(burnChipText(null), null);
  assert.equal(burnChipText(5000), '50% BURN');
  assert.equal(burnChipText(3333.33), '33% BURN');
  assert.equal(burnChipText(12), '1% BURN');
  assert.equal(burnChipText(10_000), '100% BURN');
  assert.equal(burnChipText(20_000), '100% BURN');
});

t('the card under a coin\'s chip says how much of the coin is burned, and whose', () => {
  const card = burnCard(5000, 'MOCHI', { live: true });
  assert.deepEqual(card, {
    title: '50% burn',
    lead: '50% of the $MOCHI this pool buys is burned on chain during the buy.',
    note: 'Each backer chose how much of their own share to burn. The rest goes to their wallets.',
    live: 'It changes with every commit until the pool closes.'
  });
  assert.equal(burnCard(5000, 'MOCHI', { live: false }).live, null, 'a pool that no longer takes commits: the share is fixed');
  assert.deepEqual(burnCard(10_000, 'ZAPZ'), {
    title: '100% burn',
    lead: 'All the $ZAPZ this pool buys is burned on chain during the buy.',
    note: 'Every backer chose to burn their whole share. Nothing goes to wallets.',
    live: null
  });
  assert.equal(burnCard(0, 'MOCHI'), null);
  assert.equal(burnCard(null, 'MOCHI'), null);
  assert.equal(burnCard(3333.33, '').lead, '33% of the tokens this pool buys is burned on chain during the buy.');
  // The card's number is the chip's.
  for (const bps of [12, 2500, 3333.33, 5000, 9999, 10_000]) {
    assert.ok(burnCard(bps, 'X').title.toUpperCase() === burnChipText(bps), String(bps));
  }
});

t('the card under my own chip speaks of my tokens only', () => {
  assert.deepEqual(burnCard(2500, 'MOCHI', { mine: true, live: true }), {
    title: '25% burn',
    lead: '25% of the $MOCHI bought for you is burned on chain during the buy.',
    note: 'You chose it when you committed. The rest comes to your wallet.',
    live: null
  });
  assert.equal(burnCard(10_000, 'MOCHI', { mine: true }).note, 'You chose it when you committed. Nothing comes to your wallet.');
});

t('the chip\'s name for a screen reader starts with its own words', () => {
  assert.equal(burnChipLabel(5000), '50% burn. What it means');
  assert.ok(burnChipLabel(5000).toUpperCase().startsWith(burnChipText(5000)));
  assert.equal(burnChipLabel(0), null);
});

t('the coin\'s percent is the share the buyer burns (the payload contract)', () => {
  // offchain/orchestrator/shares.ts: burned = B × Σ(s × bps) / (S × 10000). The
  // backend's burn_bps_avg is Σ(sol × bps) / Σ sol. Same numbers from the file
  // both sides test against: the card's percent is what leaves the coin's buy.
  const contract = JSON.parse(readFileSync(join(here, '..', '..', '..', '..', 'offchain', 'tests', 'unit', 'fixtures', 'payload-contract.json'), 'utf8'));
  const stake = contract.shares.reduce((sum, share) => sum + BigInt(share.stake), 0n);
  const burn = contract.shares.reduce((sum, share) => sum + BigInt(share.burn), 0n);
  const burnedShare = Number(burn) / (Number(stake) * 10_000);
  const sol = contract.bets.reduce((sum, bet) => sum + bet.sol, 0);
  const avgBps = contract.bets.reduce((sum, bet) => sum + bet.sol * bet.burn_bps, 0) / sol;
  assert.ok(Math.abs(avgBps / 10_000 - burnedShare) < 1e-9, `${avgBps} bps vs ${burnedShare}`);
  assert.equal(burnChipText(avgBps), '38% BURN');
  assert.equal(burnCard(avgBps, 'X').lead, '38% of the $X this pool buys is burned on chain during the buy.');
});

t('the compute limit covers the worst deposit and the memo, with room for a wallet', () => {
  // Measured on mainnet; see priority-fee.ts.
  assert.ok(DEPOSIT_COMPUTE_UNITS >= MEASURED_DEPOSIT_UNITS + MEASURED_MEMO_UNITS + 150 + 10_000,
    `${DEPOSIT_COMPUTE_UNITS} < ${MEASURED_DEPOSIT_UNITS} + ${MEASURED_MEMO_UNITS} + headroom`);
});

// --- token amounts -------------------------------------------------------------

t('raw units and decimals, exactly', () => {
  assert.equal(tokenValue('52313440000000', 6), 52_313_440);
  assert.equal(tokenValue('1', 6), 0.000001);
  assert.equal(tokenValue('123', null), null);
  assert.equal(tokenValue('12.5', 6), null);
  assert.equal(exactTokens('52313440123456', 6), '52,313,440');
  assert.equal(exactTokens('999', 6), '0');
  assert.equal(exactTokens('1000000000000000000000', 6), '1,000,000,000,000,000');
  assert.equal(exactTokens('5', null), '');
});

t('compact amounts for a feed row', () => {
  assert.equal(compactTokens(5_200_000), '5.2M');
  assert.equal(compactTokens(4_100_000), '4.1M');
  assert.equal(compactTokens(41_300), '41.3K');
  assert.equal(compactTokens(1_000_000), '1M');
  assert.equal(compactTokens(1_240_000_000), '1.24B');
  assert.equal(compactTokens(812.9), '812');
  assert.equal(compactTokens(0.00042), '0.00042');
  assert.equal(compactTokens(null), '');
});

// --- the feed ---------------------------------------------------------------------

const feed = {
  coins: [{ mint: 'M', decimals: 6 }],
  purchases: [{ mint: 'M', symbol: 'MOCHI', name: 'Mochi', signature: 'buy1', sol: 0.4, venue: 'dex', atMs: 1000 }],
  deliveries: [{ mint: 'M', symbol: 'MOCHI', name: 'Mochi', signature: 'send1', raw: '4100000000000', decimals: null, recipients: ['A', 'B', 'C', 'D', 'ME'], atMs: 2000 }],
  burns: [{ mint: 'M', symbol: 'MOCHI', name: 'Mochi', signature: 'burn1', raw: '5200000000000', decimals: 6, atMs: 1500 }]
};

t('three kinds, newest first, amounts from the coin decimals when the row has none', () => {
  const rows = buildFeedRows(feed, []);
  assert.deepEqual(rows.map((r) => r.kind), ['send', 'burn', 'buy']);
  assert.equal(rows[0].amount, '4.1M');
  assert.equal(rows[1].amount, '5.2M');
  assert.equal(rows[2].sol, 0.4);
  assert.equal(recipientsText(rows[0]), 'to 5 wallets');
});

t('a delivery that reached the person looking says so', () => {
  const [send] = buildFeedRows(feed, ['ME']);
  assert.equal(send.toYou, true);
  assert.equal(recipientsText(send), 'to you + 4');
  assert.equal(recipientsText({ ...send, recipients: 1 }), 'to you');
  assert.equal(recipientsText({ ...send, toYou: false, recipients: 1 }), 'to 1 wallet');
  assert.equal(recipientsShort(send), 'to you + 4');
  assert.equal(recipientsShort({ ...send, toYou: false }), 'to 5');
});

t('a refund row: SOL back, to whom, by time among the rest', () => {
  const rows = buildFeedRows({ ...feed, refunds: [{ mint: 'M', symbol: 'MOCHI', name: 'Mochi', signature: 'ref1', sol: 0.48, recipients: ['ME', 'X'], atMs: 3000 }] }, ['ME']);
  assert.deepEqual(rows.map((r) => r.kind), ['refund', 'send', 'burn', 'buy']);
  assert.equal(rows[0].sol, 0.48);
  assert.equal(rows[0].key, 'refund:ref1:M');
  assert.equal(recipientsText(rows[0]), 'to you + 1');
  assert.equal(recipientsShort(rows[0]), 'to you + 1');
  // A feed without refunds at all (an older backend) still builds.
  assert.equal(buildFeedRows({ ...feed, refunds: undefined }, []).length, 3);
});

t('the feed is capped', () => {
  const many = { ...feed, purchases: Array.from({ length: 300 }, (_, i) => ({ ...feed.purchases[0], signature: `b${i}`, atMs: i })) };
  assert.equal(buildFeedRows(many, []).length, MAX_FEED_ROWS);
});

// --- the verification window ----------------------------------------------------

const base = {
  mint: 'M', name: 'CMC', symbol: 'CMC', decimals: 6, coin_sol: 10.45, burn_bps: 9569.38,
  bets: [{ wallet: 'PrpNxdeSX8SwyUNv4H2pA7aZ6PRYzfAyEPPogCgCDnQ', sol: 10, burn_bps: 10000, signature: 's' }],
  bought_raw: '100000000000000', owed_raw: '52313440000000', burned_raw: '52313440000000',
  supply_at_start: '1000000000000000', supply_at_end: '947686560000000',
  blocked_reason: null, transactions: [{ signature: 'b1', raw_amount: '18204112000000', at: '2026-09-25T16:31:00Z' }], final: true
};

t('a finished burn whose supply dropped by exactly the burn says exactly', () => {
  const view = buildBurnView(base);
  assert.equal(view.burned, '52,313,440');
  assert.equal(view.burnedCompact, '52.3M');
  assert.equal(view.progress, 100);
  assert.equal(view.verdict, 'ok');
  assert.match(view.verdictText, /went down by exactly this much/);
  assert.equal(view.caption, 'destroyed on chain · everything that was asked for');
  assert.equal(view.supplyBefore, '1,000,000,000');
  assert.equal(view.supplyAfter, '947,686,560');
  assert.equal(view.coinPercent, '95.7%');
  assert.equal(view.bets[0].percent, '100%');
  assert.equal(view.transactions[0].amount, '18,204,112');
});

t('someone else burning the same coin makes it "at least", never "exactly"', () => {
  const view = buildBurnView({ ...base, supply_at_end: '947000000000000' });
  assert.match(view.verdictText, /at least this much/);
  assert.doesNotMatch(view.verdictText, /exactly/);
});

t('a coin minted during the round is said plainly', () => {
  const view = buildBurnView({ ...base, supply_at_end: '999000000000000' });
  assert.equal(view.verdict, 'neutral');
  assert.match(view.verdictText, /minted during the round/);
});

t('during the buying the fuse measures against what is owed so far', () => {
  const view = buildBurnView({ ...base, final: false, burned_raw: '32434333000000', supply_at_end: null });
  assert.equal(view.progress, 62);
  assert.equal(view.caption, 'destroyed on chain · the buying is still running');
  assert.match(view.verdictText, /Burning as the buying goes/);
  assert.equal(view.supplyAfter, 'after the round');
});

t('a blocked burn is red and says where the tokens are', () => {
  const view = buildBurnView({ ...base, burned_raw: '0', blocked_reason: 'the coin\'s mint is paused' });
  assert.equal(view.verdict, 'bad');
  assert.match(view.verdictText, /Burning stopped: the coin's mint is paused/);
  assert.match(view.verdictText, /delivered to no one/);
});

t('nothing read yet is dashes, not zeros', () => {
  const view = buildBurnView({ ...base, decimals: null, owed_raw: null, burned_raw: null, final: false });
  assert.equal(view.burned, '—');
  assert.equal(view.owed, '—');
  assert.equal(view.progress, null);
});

t('the flame stays on the fuse at both ends', () => {
  assert.equal(fuseLeft(0), 'clamp(12px, 0%, calc(100% - 12px))');
  assert.equal(fuseLeft(null), 'clamp(12px, 0%, calc(100% - 12px))');
  assert.equal(percentText(0), '0%');
  assert.equal(percentText(2500), '25%');
});

console.log(`\n${n} burn checks passed`);
