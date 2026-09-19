// Shared mocks for the pool page tests: /lottery/current by scenario.
export const MINTS = {
  mochi: '7XqN4wD2mJp9LcR8Vt3HzYk1BaFe5PuQ6sMdCnUa2rLh',
  toad: 'C4rT9kWp2VxQ8mYe6LsJ1NdFa7Hu3RbZ5pKgEnMc2sDo',
  zapz: '9LmQs5PbE2xV7rHd4NkTa1YwFcJu8GmR3sDzKeUi6oAx',
  tiny: '2FpHa8ZdQvN6mXr1LsUw4JkTc9ByEgPo5nMdRiSe7aCb',
  nib: 'Bg3Rt8VaQm1XeLp5KsJu2NdFc7HwYzTo4pEiMrCn6sDx'
};
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const coin = (mint, name, symbol, logo = '') => ({ name, symbol, address: mint, logo_url: logo, market_cap: '0', current_price: '0', price_history: [], volume_24h: '0' });
export const entries = (list) => list.map(([key, sol, count, name, symbol], i) => ({ rank: i + 1, lottery_id: 128, lottery_type: 'dex', bet_count: count, total_solana_bet: String(sol), coin: coin(MINTS[key], name, symbol, key === 'mochi' ? 'https://example.invalid/mochi.png' : '') }));
export const summary = (over) => ({ id: 128, lottery_type: 'dex', status: 'created', end_date: iso(72 * 60_000 + 40_000), max_total: 111, total_pool_sol: 64.5, execution_countdown_seconds: 3900, draw_seconds: 115, lottery_pda: '6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9', vault_pda: 'CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq', admin_pubkey: 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ', winner_results: [], ...over });
export const five = [['mochi', 30.5, 4, 'Mochi', 'MOCHI'], ['toad', 20, 3, 'Toad Signal', 'TOAD'], ['zapz', 10, 2, 'Zapz', 'ZAPZ'], ['tiny', 3, 1, 'Tiny Orbit', 'TINY'], ['nib', 1, 1, 'Nib', 'NIB']];
export const SCENARIOS = {
  open: () => ({ entries: entries(five), has_active_lottery: true, active_lotteries: [summary({})], latest_lotteries: [summary({})], hype_countdowns: [] }),
  openEmpty: () => ({ entries: [], has_active_lottery: true, active_lotteries: [summary({ total_pool_sol: 0 })], latest_lotteries: [], hype_countdowns: [] }),
  lockedRunning: () => ({ entries: entries(five), has_active_lottery: false, active_lotteries: [summary({ status: 'vrf_binded', end_date: iso(-60_000), second_phase_started_at: iso(-20_000) })], latest_lotteries: [], hype_countdowns: [] }),
  buying: () => ({ entries: entries(five), has_active_lottery: false, active_lotteries: [summary({ status: 'proceeding_purchases', end_date: iso(-30 * 60_000), proceeding_purchases_started_at: iso(-22 * 60_000), winner_results: [
    { mint: MINTS.mochi, wins: 30, target_lamports: 33_950_000_000, target_sol: 33.95 },
    { mint: MINTS.toad, wins: 18, target_lamports: 19_400_000_000, target_sol: 19.4 },
    { mint: MINTS.zapz, wins: 8, target_lamports: 8_730_000_000, target_sol: 8.73 },
    { mint: MINTS.tiny, wins: 1, target_lamports: 485_000_000, target_sol: 0.485 }
  ] })], latest_lotteries: [], hype_countdowns: [] }),
  done: () => ({ entries: [], has_active_lottery: false, active_lotteries: [], latest_lotteries: [summary({ status: 'closed', proceeding_purchases_started_at: iso(-80 * 60_000), next_pool_at: iso(3 * 60_000) })], hype_countdowns: [] }),
  launch: () => ({ entries: [], has_active_lottery: false, active_lotteries: [], latest_lotteries: [], hype_countdowns: [{ lottery_type: 'dex', launch_at: iso(2 * 86400_000 + 4 * 3600_000 + 10 * 60_000) }] }),
  waiting: () => ({ entries: [], has_active_lottery: false, active_lotteries: [], latest_lotteries: [], hype_countdowns: [] })
};
export async function mockCurrent(ctx, getScenario) {
  await ctx.route('http://localhost:9876/lottery/current**', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(getScenario()) }));
}

/** The purchase feed: what the buyer has already bought. */
export const purchaseFeed = (over = {}) => {
  const now = Date.now();
  const coins = [
    { mint: MINTS.mochi, name: 'Mochi', symbol: 'MOCHI', logo_url: null, target_sol: 33.95, bought_sol: 12.4, completed_purchases: 9, planned_purchases: 24, status: 'in_progress' },
    { mint: MINTS.toad, name: 'Toad Signal', symbol: 'TOAD', logo_url: null, target_sol: 19.4, bought_sol: 19.4, completed_purchases: 16, planned_purchases: 16, status: 'completed' },
    // A coin's share after the fee is a number with a tail: that is exactly how
    // it arrives from the server (0.5 SOL minus the fee gives 0.4929).
    { mint: MINTS.zapz, name: 'Zapz', symbol: 'ZAPZ', logo_url: null, target_sol: 0.4929, bought_sol: 0.0123, completed_purchases: 1, planned_purchases: 5, status: 'in_progress' }
  ];
  const purchases = Array.from({ length: 12 }, (_, i) => ({
    mint: i % 2 ? MINTS.toad : MINTS.mochi,
    name: i % 2 ? 'Toad Signal' : 'Mochi',
    symbol: i % 2 ? 'TOAD' : 'MOCHI',
    logo_url: null,
    sol_amount: Number((0.4 + 0.15 * (i % 5)).toFixed(2)),
    signature: `feedsig${String(i).padStart(3, '0')}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    venue: i % 3 === 0 ? 'dex' : 'pumpfun',
    at: new Date(now - i * 95_000).toISOString()
  }));
  return {
    lottery_id: 128,
    available: true,
    target_sol: 53.35,
    bought_sol: 31.8,
    completed_purchases: 25,
    planned_purchases: 40,
    finished: false,
    coins,
    purchases,
    ...over
  };
};

export async function mockPurchases(ctx, getFeed) {
  await ctx.route('**/lottery/*/purchases', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(getFeed())
  }));
}
