// What the red-flag mark and its card say (src/app/shared/coin-screening).
//
// The backend answers `clean` or `flagged`, with reason codes and the level it
// read for each holder rule. The card shows the readings as ranges and reddens
// the flags; it never sums the coin up in words. A coin with no answer, or a
// flag the site cannot show, shows nothing: a bare red mark with no reason under
// it would be worse than none.
import assert from 'node:assert/strict';
import {
  REASON_ROW,
  SCREENING_TITLE,
  badgeLabel,
  cardLabel,
  checkedAgo,
  checkedLine,
  flagCount,
  screeningRows,
  flagsLabel,
  sourceOf,
  toCoinScreening
} from './coin-screening.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const AT = '2026-10-02T12:00:00Z';
const AT_MS = Date.parse(AT);
const MINUTE = 60_000;
const QUIET = { dev: 'low', bundle: 'low', bundled_launch: 'low', top10: 'low', insiders: 'low' };
const lines = (screening) => screeningRows(screening).map((row) => `${row.flagged ? '!' : ''}${row.label}: ${row.value}`);

t('an answer the site can show', () => {
  const clean = toCoinScreening({ status: 'clean', reasons: [], levels: QUIET, on_curve: true, source: 'tracced', checked_at: AT });
  assert.deepEqual(clean, { status: 'clean', reasons: [], levels: QUIET, source: 'tracced', checkedAtMs: AT_MS });
  const old = toCoinScreening({ status: 'flagged', reasons: ['creator_over_20'], source: 'solana_tracker', checked_at: AT });
  assert.deepEqual(old.levels, {}, 'a check from before the levels were kept');
});

t('nothing to show is nothing', () => {
  assert.equal(toCoinScreening(null), null);
  assert.equal(toCoinScreening(undefined), null);
  assert.equal(toCoinScreening({ status: 'pending', checked_at: AT }), null);
  assert.equal(toCoinScreening({ status: 'clean', checked_at: 'not a date' }), null);
  // A flag the site cannot show: no bare red mark. The first version's codes are such flags now.
  assert.equal(toCoinScreening({ status: 'flagged', reasons: ['something_new'], checked_at: AT }), null);
  assert.equal(toCoinScreening({ status: 'flagged', reasons: ['bundle_cluster', 'liquidity_gone'], checked_at: AT }), null);
  assert.equal(toCoinScreening({ status: 'flagged', reasons: [], checked_at: AT }), null);
});

t('levels the site does not know are left out', () => {
  const screening = toCoinScreening({ status: 'clean', levels: { dev: 'low', top10: 'huge', snipers: 'high', bundle: 7 }, checked_at: AT });
  assert.deepEqual(screening.levels, { dev: 'low' });
});

t('Krackpot at its first commit: a bundled launch is the flag, the rest are plain readings', () => {
  // tracced on 2026-10-02: dev low, bundle medium, bundled at launch high, top 10 low.
  const levels = { dev: 'low', bundle: 'medium', bundled_launch: 'high', top10: 'low', insiders: 'low' };
  const screening = toCoinScreening({ status: 'flagged', reasons: ['bundled_launch'], levels, on_curve: true, source: 'tracced', checked_at: AT });
  assert.deepEqual(lines(screening), [
    'Dev: under 5%',
    'Bundlers: 5–20%',
    '!Bundled at launch: over 50%',
    'Top 10: under 20%',
    'Insiders: under 5%'
  ]);
  assert.equal(flagsLabel(screening), '1 red flag');
});

t('a clean card reads like pump.fun\'s numbers, with no verdict and no liquidity line', () => {
  const screening = toCoinScreening({ status: 'clean', levels: { ...QUIET, top10: 'medium' }, on_curve: true, source: 'tracced', checked_at: AT });
  assert.deepEqual(lines(screening), [
    'Dev: under 5%',
    'Bundlers: under 5%',
    'Bundled at launch: under 20%',
    'Top 10: 20–40%',
    'Insiders: under 5%',
    'Mint & freeze: revoked'
  ]);
  assert.equal(flagsLabel(screening), null, 'a clean coin has no count');
  assert.ok(screeningRows(screening).every((row) => !row.flagged));
});

t('the ranges are the backend\'s cuts', () => {
  const high = toCoinScreening({ status: 'flagged', reasons: ['creator_over_20', 'bundles_over_20', 'insiders_over_15', 'top10_over_40_on_curve'],
    levels: { dev: 'high', bundle: 'high', bundled_launch: 'high', top10: 'high', insiders: 'high' }, checked_at: AT });
  assert.deepEqual(lines(high), [
    '!Dev: over 20%',
    '!Bundlers: over 20%',
    'Bundled at launch: over 50%',
    '!Top 10: over 40%',
    '!Insiders: over 15%'
  ]);
  assert.equal(flagsLabel(high), '4 red flags');
  const medium = toCoinScreening({ status: 'clean', levels: { dev: 'medium', bundle: 'medium', bundled_launch: 'medium', top10: 'medium', insiders: 'medium' }, checked_at: AT });
  assert.deepEqual(lines(medium).slice(0, 5), ['Dev: 5–20%', 'Bundlers: 5–20%', 'Bundled at launch: 20–50%', 'Top 10: 20–40%', 'Insiders: 5–15%']);
});

t('no data is said as no data', () => {
  const screening = toCoinScreening({ status: 'clean', levels: { ...QUIET, bundle: 'unknown', insiders: 'unknown' }, checked_at: AT });
  const rows = screeningRows(screening);
  assert.deepEqual(rows.filter((row) => row.unknown).map((row) => `${row.label}: ${row.value}`), ['Bundlers: no data', 'Insiders: no data']);
});

t('a check from before the levels were kept shows its flag alone', () => {
  const screening = toCoinScreening({ status: 'flagged', reasons: ['creator_over_20'], source: 'tracced', checked_at: AT });
  assert.deepEqual(lines(screening), ['!Dev: over 20%']);
});

t('the mint\'s powers, one line each, in the words traders use', () => {
  const screening = toCoinScreening({ status: 'flagged', reasons: ['freeze_authority', 'mint_authority', 'permanent_delegate', 'non_transferable', 'frozen_by_default', 'pausable'], source: 'chain', checked_at: AT });
  assert.deepEqual(lines(screening), [
    '!Freeze authority: active',
    '!Mint authority: active',
    '!Permanent delegate: set',
    '!Transfers: disabled',
    '!New accounts: frozen',
    '!Transfers: can be paused'
  ]);
  assert.equal(flagsLabel(screening), '6 red flags');
});

t('liquidity has a line only when it was pulled', () => {
  const pulled = toCoinScreening({ status: 'flagged', reasons: ['liquidity_pulled'], levels: QUIET, on_curve: false, checked_at: AT });
  assert.deepEqual(lines(pulled).slice(-1), ['!Liquidity: pulled']);
  for (const screening of [
    toCoinScreening({ status: 'clean', levels: QUIET, on_curve: true, checked_at: AT }),
    toCoinScreening({ status: 'clean', levels: QUIET, on_curve: false, checked_at: AT }),
    toCoinScreening({ status: 'flagged', reasons: ['creator_over_20'], levels: { ...QUIET, dev: 'high' }, on_curve: true, checked_at: AT })
  ]) {
    assert.ok(!lines(screening).some((line) => /liquidity/i.test(line)), lines(screening).join(' | '));
  }
});

t('unknown codes are left out of the count and the card', () => {
  const screening = toCoinScreening({ status: 'flagged', reasons: ['creator_over_20', 'something_new'], levels: { ...QUIET, dev: 'high' }, checked_at: AT });
  assert.equal(flagCount(screening), 1);
  assert.equal(flagsLabel(screening), '1 red flag');
  assert.equal(lines(screening).filter((line) => line.startsWith('!')).length, 1);
});

t('every reason the backend can send reddens exactly one line', () => {
  for (const code of Object.keys(REASON_ROW)) {
    const screening = toCoinScreening({ status: 'flagged', reasons: [code], levels: QUIET, checked_at: AT });
    assert.equal(screeningRows(screening).filter((row) => row.flagged).length, 1, code);
  }
});

t('no word a reader could take for a verdict or a promise', () => {
  const words = [
    ...Object.values(REASON_ROW).flatMap((row) => [row.label, row.value]),
    ...lines(toCoinScreening({ status: 'clean', levels: QUIET, checked_at: AT })),
    SCREENING_TITLE,
    badgeLabel('X'),
    cardLabel('X')
  ].join(' ').toLowerCase();
  for (const word of ['safe', 'scam', 'verified', 'guarantee', 'rug', 'no red flags', 'in place', 'legit', 'trusted']) {
    assert.ok(!words.includes(word), word);
  }
});

t('a source the site does not know reads as the chain', () => {
  const screening = toCoinScreening({ status: 'clean', source: 'somebody', checked_at: AT });
  assert.equal(screening.source, null);
  assert.deepEqual(sourceOf(screening), { label: 'Read from the coin’s own account', href: null });
});

t('sources link to their products', () => {
  assert.deepEqual(sourceOf({ source: 'tracced' }), { label: 'Checked by tracced', href: 'https://tracced.xyz' });
  assert.deepEqual(sourceOf({ source: 'solana_tracker' }), { label: 'Checked by Solana Tracker', href: 'https://www.solanatracker.io' });
});

t('the mark says the same to a screen reader for every coin', () => {
  // The same words for every coin, as the mark is the same: the flags are in the card.
  assert.equal(badgeLabel('MOCHI'), 'Coin check on $MOCHI. Show the check');
  assert.equal(badgeLabel(''), 'Coin check on this coin. Show the check');
  assert.equal(cardLabel('MOCHI'), 'Coin check on $MOCHI');
});

t('when it was checked', () => {
  assert.equal(checkedAgo(AT_MS, AT_MS + 30_000), 'just now');
  assert.equal(checkedAgo(AT_MS, AT_MS - 5 * MINUTE), 'just now'); // a clock behind the server's
  assert.equal(checkedAgo(AT_MS, AT_MS + 12 * MINUTE), '12 min ago');
  assert.equal(checkedAgo(AT_MS, AT_MS + 59 * MINUTE + 59_000), '59 min ago');
  assert.equal(checkedAgo(AT_MS, AT_MS + 60 * MINUTE), '1 h ago');
  assert.equal(checkedAgo(AT_MS, AT_MS + 26 * 60 * MINUTE), '1 day ago');
  assert.equal(checkedAgo(AT_MS, AT_MS + 3 * 24 * 60 * MINUTE), '3 days ago');
  const screening = toCoinScreening({ status: 'clean', checked_at: AT });
  assert.equal(checkedLine(screening, AT_MS + 12 * MINUTE), 'At the first commit in this pool, 12 min ago');
});

console.log(`\n${n} screening checks passed`);
