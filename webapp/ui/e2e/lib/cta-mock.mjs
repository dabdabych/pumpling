// Mocks for the main page's Commit SOL card: the pool in a given phase, the
// archive and the finished pools' purchases the card's proof is read from.
import { SCENARIOS, entries, five, summary } from './pool-mock.mjs';

const cors = { 'access-control-allow-origin': '*' };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
export const PROOF_SIG = 'proofsig1'.padEnd(87, 'a');

/** Each phase the card has words for, as `/lottery/current` sends it. */
export const CTA_SCENARIOS = {
  openEmpty: SCENARIOS.openEmpty,
  openWithCoins: SCENARIOS.open,
  locked: SCENARIOS.lockedRunning,
  buying: SCENARIOS.buying,
  done: () => ({ ...SCENARIOS.done(), latest_lotteries: [summary({ id: 128, status: 'closed', total_pool_sol: 21, proceeding_purchases_started_at: iso(-80 * 60_000), next_pool_at: iso(4 * 60_000 + 12_000) })] }),
  doneAfterEmpty: () => ({ ...SCENARIOS.done(), latest_lotteries: [summary({ id: 129, status: 'closed', total_pool_sol: 0, proceeding_purchases_started_at: iso(-80 * 60_000), next_pool_at: iso(4 * 60_000) })] }),
  launch: SCENARIOS.launchAfterPastPools
};

const archive = {
  lottery_type: 'dex', window_days: 30,
  items: [{ id: 128, lottery_type: 'dex', status: 'closed', lottery_pda: 'Pda128'.padEnd(44, 'a'), started_at: iso(-3 * 3600_000), ended_at: iso(-2 * 3600_000), ended_at_source: 'end_date', total_pool_sol: 21,
    entries: [{ rank: 1, mint: 'PumpLing111111111111111111111111111111pump', name: 'pumpling', ticker: 'PUMPLING', total_solana_bet: 20, won_sol: 19.69 }] }]
};

const finishedFeed = () => ({
  lottery_id: 128, available: true, finished: true, phase: 'finished', target_sol: 19.69, bought_sol: 19.67, completed_purchases: 52, planned_purchases: 52,
  coins: [{ mint: 'PumpLing111111111111111111111111111111pump', name: 'pumpling', symbol: 'PUMPLING', decimals: 6, target_sol: 19.69, bought_sol: 19.67 }],
  purchases: Array.from({ length: 52 }, (_, i) => ({ mint: 'PumpLing111111111111111111111111111111pump', name: 'pumpling', symbol: 'PUMPLING', sol_amount: 0.39,
    signature: i === 0 ? PROOF_SIG : `buy${i}`.padEnd(87, 'a'), venue: 'pumpfun', at: iso(-2 * 3600_000 - i * 60_000) }))
});

const liveFeed = () => ({
  lottery_id: 128, available: true, finished: false, phase: 'buying', target_sol: 53, bought_sol: 12, completed_purchases: 3, planned_purchases: 40,
  coins: [], purchases: [0, 1, 2].map((i) => ({ mint: 'M', name: 'Mochi', symbol: 'MOCHI', sol_amount: 0.4 + i / 10, signature: `live${i}`.padEnd(87, 'a'), venue: 'pumpfun', at: iso(-i * 70_000 - 15_000) }))
});

/** Route everything the card asks for; `phase` picks the pool's state. */
export async function mockCard(ctx, phase, { archiveFails = false } = {}) {
  const current = CTA_SCENARIOS[phase];
  await ctx.route('**/lottery/current**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(current()) }));
  await ctx.route('**/lottery/archive**', (route) => archiveFails
    ? route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{}' })
    : route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(archive) }));
  await ctx.route('**/lottery/*/purchases', (route) => {
    const body = phase === 'buying' ? liveFeed() : finishedFeed();
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  });
}
