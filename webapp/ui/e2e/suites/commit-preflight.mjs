// The wallet opens only on a commit that goes through.
//
// A wallet simulates whatever it is asked to sign and shows a failed simulation
// as a red warning ("This transaction reverted during simulation"). So the site
// runs the same transaction on its own node first, and when that fails the
// wallet is never opened: the person sees why, in words, on our page.
//
// On the code before this suite the wallet opened every time and the checks on
// a failing simulation all fail: nothing was simulated before signing.
import { launch, BASE } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const WALLET = 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** The wallet: it tells the test the moment it is opened. */
const fakeWallet = `
(() => {
  const PUBKEY = '${WALLET}';
  window.__signed = 0;
  const key = { toString: () => PUBKEY, toBase58: () => PUBKEY };
  const provider = {
    isPhantom: true, publicKey: null, isConnected: false,
    connect: async () => { provider.publicKey = key; provider.isConnected = true; return { publicKey: key }; },
    disconnect: async () => { provider.publicKey = null; provider.isConnected = false; },
    signMessage: async () => ({ signature: new Uint8Array(64).fill(7) }),
    signTransaction: async () => {
      window.__signed++;
      await fetch('/__wallet-opened').catch(() => {});
      return { serialize: () => new Uint8Array([1, 2, 3]) };
    },
    signAllTransactions: async (txs) => txs,
    on: () => {}, off: () => {}
  };
  window.phantom = { solana: provider }; window.solana = provider;
  window.dispatchEvent(new Event('phantom#initialized'));
})();
`;

const passes = { err: null, logs: ['Program log: Instruction: DepositSol'], accounts: null, unitsConsumed: 35_000, returnData: null };
const anchorFail = (code, number, message) => ({
  err: { InstructionError: [2, { Custom: number }] },
  logs: [
    'Program 4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH invoke [1]',
    'Program log: Instruction: DepositSol',
    `Program log: AnchorError thrown in programs/lottery_v_1_0/src/lib.rs:348. Error Code: ${code}. Error Number: ${number}. Error Message: ${message}.`,
    `Program 4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH failed: custom program error: 0x${number.toString(16)}`
  ],
  accounts: null, unitsConsumed: 6_000, returnData: null
});

/**
 * One commit, start to finish, against a node that answers as `plan` says.
 * `plan.simulate(call)` gives the simulation for the nth call, or throws for an RPC error.
 */
const commit = async ({ plan }) => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const timeline = [];
  const simulations = [];
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', async (route) => {
    const mint = JSON.parse(route.request().postData() || '{}').mint_address;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ mint_address: mint, token_symbol: 'MOCHI', token_name: 'Mochi', is_pumpfun_mint: true, can_burn: true }) });
  });
  await ctx.route('**/auth/wallet/nonce', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ nonce: 'nonce-1', domain: 'localhost', uri: BASE, chain: 'solana:devnet', issued_at: new Date().toISOString(), expiration_time: new Date(Date.now() + 600000).toISOString() }) }));
  await ctx.route('**/auth/wallet/verify', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ access_token: 'header.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig' }) }));
  await ctx.route('**/lottery/bet', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' }));
  await ctx.route('**/__wallet-opened', (route) => { timeline.push('wallet'); return route.fulfill({ status: 204, headers: cors, body: '' }); });
  await ctx.route('**/rpc', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const { method, params } = body;
    const reply = (result) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
    if (method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } });
    if (method === 'simulateTransaction') {
      timeline.push('simulate');
      simulations.push({ wire: params[0], config: params[1] });
      let value;
      try { value = plan.simulate(simulations.length); } catch { return route.fulfill({ status: 502, headers: cors, body: 'bad gateway' }); }
      return reply({ context: { slot: 2 }, value });
    }
    if (method === 'sendTransaction') { timeline.push('send'); return reply('5'.repeat(88)); }
    if (method === 'getSignatureStatuses') return reply({ context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
    return reply(null);
  });
  await ctx.addInitScript(fakeWallet);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1000);
  await p.locator('.coin-row__add').first().click();
  await p.waitForSelector('.commit__title', { timeout: 10000 });
  await p.waitForTimeout(900);
  if (plan.burn) {
    await p.locator('.commit__burn-option').nth(2).click();
  }
  await p.locator('.commit__submit').click();
  await p.waitForTimeout(800);
  await p.locator('.auth-method', { hasText: 'Continue with wallet' }).click();
  await p.waitForSelector('.wallet-connect-dialog__option', { timeout: 10000 });
  await p.locator('.wallet-connect-dialog__option', { hasText: 'Phantom' }).first().click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 });
  await p.waitForTimeout(1200);
  await p.locator('.commit__submit').click();
  // Either the wallet opens, or our page says why it did not.
  await p.waitForFunction(() => window.__signed > 0 || !!document.querySelector('.commit__error'), null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(600);
  const signed = await p.evaluate(() => window.__signed);
  const error = await p.evaluate(() => document.querySelector('.commit__error')?.textContent?.trim() ?? '');
  const after = await p.evaluate(() => ({ text: document.querySelector('.commit__submit')?.textContent?.trim(), disabled: document.querySelector('.commit__submit')?.disabled }));
  await ctx.close();
  return { signed, error, after, timeline, simulations, errors };
};

const bytes = (wire) => Buffer.from(wire, 'base64');

// 1. A commit that goes through: simulated on our node first, then the wallet.
{
  const r = await commit({ plan: { simulate: () => passes, burn: true } });
  ok(r.signed === 1, `the wallet opens on a transaction that passes (${r.signed})`);
  ok(r.timeline[0] === 'simulate' && r.timeline.indexOf('wallet') > r.timeline.indexOf('simulate'), `the simulation runs before the wallet (${r.timeline.join(' → ')})`);
  ok(r.simulations.length === 1, `one simulation (${r.simulations.length})`);
  const config = r.simulations[0]?.config ?? {};
  ok(config.sigVerify === false && config.encoding === 'base64', `simulated unsigned, as Phantom advises (${JSON.stringify(config)})`);
  const wire = r.simulations[0] ? bytes(r.simulations[0].wire) : Buffer.alloc(0);
  ok(wire.includes(Buffer.from('pumpling burn 50%')), 'the simulated transaction is the one with the burn memo');
  ok(wire[0] === 1 && wire.subarray(1, 65).every((x) => x === 0), 'one signature slot, left empty: nothing is signed before the check');
  ok(r.error === '', `no error (${r.error})`);
  ok(r.errors.length === 0, `no page errors ${r.errors.join(' | ')}`);
}

// 2. Everything the program can refuse: the wallet stays closed, the page says why.
for (const [name, simulation, expected] of [
  ['the pool ended', anchorFail('Ended', 6008, 'Lottery ended'), 'This pool no longer takes SOL.'],
  ['the pool is paused', anchorFail('Paused', 6005, 'Lottery is paused'), 'This pool no longer takes SOL.'],
  ['the pool has not opened', anchorFail('NotStarted', 6007, 'Lottery not started yet'), 'This pool has not opened yet.'],
  ['the cap is reached', anchorFail('TotalLimitExceeded', 6010, 'Total limit exceeded'), 'That would take the pool over its cap. Try a smaller amount.'],
  ['too little SOL', { err: { InstructionError: [2, { Custom: 1 }] }, logs: ['Program 11111111111111111111111111111111 invoke [2]', 'Transfer: insufficient lamports 100000, need 500000000', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'], accounts: null, unitsConsumed: 5000, returnData: null },
    'Not enough SOL in the wallet to cover the amount and the network fee.'],
  ['nothing left for rent', { err: { InsufficientFundsForRent: { account_index: 0 } }, logs: ['Program log: Instruction: DepositSol', 'Program data: 8tEndedPausedQ3notopen'], accounts: null, unitsConsumed: 35000, returnData: null },
    'That would leave less than 0.0009 SOL in the wallet, and Solana does not allow it. Commit a little less.'],
  ['a wallet with no SOL at all', { err: 'AccountNotFound', logs: [], accounts: null, unitsConsumed: 0, returnData: null },
    'Not enough SOL in the wallet to cover the amount and the network fee.'],
  // A program missing from the network is not about the person's SOL.
  ['a missing program', { err: 'ProgramAccountNotFound', logs: [], accounts: null, unitsConsumed: 0, returnData: null },
    'Could not send the transaction. Try again.']
]) {
  const r = await commit({ plan: { simulate: () => simulation } });
  ok(r.signed === 0, `${name}: the wallet is not opened (${r.signed})`);
  ok(r.error === expected, `${name}: the page says "${expected}" (${r.error})`);
  ok(!r.timeline.includes('send'), `${name}: nothing is sent`);
  ok(r.after.disabled === false, `${name}: the button is back for another try (${r.after.text})`);
}

// 3. A node that cannot answer: a transaction we could not check never reaches the wallet.
{
  const r = await commit({ plan: { simulate: () => { throw new Error('down'); } } });
  ok(r.signed === 0, `node down: the wallet is not opened (${r.signed})`);
  ok(r.error === 'Could not reach Solana to check the transaction. Try again in a moment.', `node down: the page says so (${r.error})`);
}

// 4. A node a slot behind: "blockhash not found" is asked again, not shown as a failure.
{
  const r = await commit({ plan: { simulate: (n) => n === 1 ? { err: 'BlockhashNotFound', logs: [], accounts: null, unitsConsumed: 0, returnData: null } : passes } });
  ok(r.simulations.length === 2 && r.simulations[1].config.replaceRecentBlockhash === true && r.simulations[1].config.sigVerify === false,
    `asked again with the node's own blockhash (${JSON.stringify(r.simulations.map((s) => s.config))})`);
  ok(r.signed === 1, `and the wallet opens (${r.signed})`);
  ok(r.error === '', `no error (${r.error})`);
}

await b.close();
console.log(fails ? `\nCOMMIT PREFLIGHT: ${fails} FAILED` : '\nCOMMIT PREFLIGHT ALL PASSED');
process.exit(fails ? 1 : 0);
