// Wallet connection: what is visible in the chooser, what signs a commit and
// where the commit goes.
//
// An extension cannot be installed into the test browser, so the wallets are
// fakes, but they repeat the real API and, crucially, the moment they appear in
// the page. Two things caught live, which is what this checks:
//   1. Solflare injects itself later than the rest, and a chooser assembled once
//      showed "Not detected" next to an installed wallet.
//   2. `signAndSendTransaction` sends the transaction to the network selected in
//      the wallet, while we take the blockhash from our own node. A wallet on
//      mainnet plus a stand on devnet and the signature goes to the wrong place.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, MINTS } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const WALLET = 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ';
const BLOCKHASH = '11111111111111111111111111111111';
const SIGNATURE = '5'.repeat(88);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/** A fake wallet with the API of a particular brand. */
const fakeWallet = ({ kind, delayMs = 0 }) => `
(() => {
  const PUBKEY = '${WALLET}';
  window.__wallet = { calls: [] };
  const key = { toString: () => PUBKEY, toBase58: () => PUBKEY };
  const provider = {
    ${kind === 'phantom' ? 'isPhantom: true,' : ''}
    ${kind === 'solflare' ? 'isSolflare: true,' : ''}
    ${kind === 'backpack' ? 'isBackpack: true,' : ''}
    ${kind === 'coinbase' ? 'isCoinbaseWallet: true,' : ''}
    publicKey: null,
    isConnected: false,
    connect: async (options) => {
      window.__wallet.calls.push('connect');
      window.__wallet.connectOptions = options ?? null;
      provider.publicKey = key;
      provider.isConnected = true;
      // Solflare returns nothing from connect: the address is read from publicKey.
      return ${kind === 'solflare' ? 'undefined' : '({ publicKey: key })'};
    },
    disconnect: async () => { window.__wallet.calls.push('disconnect'); provider.publicKey = null; provider.isConnected = false; },
    signMessage: async () => { window.__wallet.calls.push('signMessage'); return { signature: new Uint8Array(64).fill(7) }; },
    signTransaction: async (tx) => {
      window.__wallet.calls.push('signTransaction');
      window.__wallet.programs = (tx?.instructions ?? []).map((ix) => ix.programId.toBase58());
      return { serialize: () => new Uint8Array([1, 2, 3]) };
    },
    signAllTransactions: async (txs) => txs,
    signAndSendTransaction: async () => {
      window.__wallet.calls.push('signAndSendTransaction');
      return { signature: '${SIGNATURE}' };
    },
    on: () => {},
    off: () => {}
  };
  const inject = () => {
    ${kind === 'phantom' ? 'window.phantom = { solana: provider }; window.solana = provider; window.dispatchEvent(new Event("phantom#initialized"));' : ''}
    ${kind === 'solflare' ? 'window.solflare = provider; window.dispatchEvent(new Event("solflare#initialized"));' : ''}
    ${kind === 'backpack' ? 'window.backpack = provider; window.xnft = { solana: provider };' : ''}
    ${kind === 'coinbase' ? 'window.coinbaseSolana = provider;' : ''}
  };
  ${delayMs > 0 ? `setTimeout(inject, ${delayMs});` : 'inject();'}
})();
`;

const openPool = async (kind, delayMs = 0) => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ mint_address: MINTS.mochi, token_symbol: 'MOCHI', token_name: 'Mochi', is_pumpfun_mint: true })
  }));
  await ctx.route('**/auth/wallet/nonce', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ nonce: 'nonce-1', domain: 'localhost', uri: BASE, chain: 'solana:devnet', issued_at: new Date().toISOString(), expiration_time: new Date(Date.now() + 600000).toISOString() })
  }));
  await ctx.route('**/auth/wallet/verify', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ access_token: 'header.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig' })
  }));
  await ctx.route('**/lottery/bet', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' }));
  // The node: what matters is that the commit goes out through it.
  await ctx.route('**/rpc', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const method = Array.isArray(body) ? body[0]?.method : body.method;
    const reply = (result) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
    if (method === 'getLatestBlockhash') {
      return reply({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } });
    }
    if (method === 'sendTransaction') {
      return reply(SIGNATURE);
    }
    if (method === 'getSignatureStatuses') {
      return reply({ context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
    }
    return reply(null);
  });
  await ctx.addInitScript(fakeWallet({ kind, delayMs }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  let rpcSends = 0;
  p.on('request', (r) => {
    if (!/\/rpc$/.test(r.url())) return;
    const data = r.postData() || '';
    if (/sendTransaction/.test(data)) rpcSends++;
  });
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(900);
  return { ctx, p, errors, rpcSends: () => rpcSends };
};

const walletNames = { phantom: 'Phantom', solflare: 'Solflare', backpack: 'Backpack', coinbase: 'Coinbase' };

/** Get to the wallet chooser: commit → sign in → "Continue with wallet". */
const openWalletPicker = async (p) => {
  await p.locator('.coin-row__add').first().click();
  await p.waitForSelector('.commit__title', { timeout: 10000 });
  await p.waitForTimeout(700);
  await p.locator('.commit__submit').click();
  await p.waitForTimeout(800);
  await p.locator('.auth-method', { hasText: 'Continue with wallet' }).click();
  // The chooser does not appear instantly: the service gives extensions time to
  // inject themselves into the page.
  await p.waitForSelector('.wallet-connect-dialog__option', { timeout: 10000 });
  await p.waitForTimeout(300);
};

const listWallets = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.wallet-connect-dialog__option')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()));

// 1. Every wallet is in the list, connects and signs the sign-in.
for (const kind of ['phantom', 'solflare', 'backpack', 'coinbase']) {
  const { ctx, p, errors } = await openPool(kind);
  await openWalletPicker(p);
  const list = await listWallets(p);
  const mine = list.find((line) => line.startsWith(walletNames[kind]));
  ok(/CONNECT/i.test(mine || ''), `${kind}: the wallet is offered to connect (${mine})`);

  await p.locator('.wallet-connect-dialog__option', { hasText: walletNames[kind] }).first().click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 }).catch(() => {});
  const signedIn = await p.evaluate(() => !!localStorage.getItem('jwt'));
  const calls = await p.evaluate(() => window.__wallet.calls);
  ok(signedIn && calls.includes('connect') && calls.includes('signMessage'), `${kind}: signs in with the wallet (${calls.join(' → ')})`);
  ok(errors.length === 0, `${kind}: no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 2. An extension appeared while the dialog was open: the list has to come alive.
{
  const { ctx, p } = await openPool('solflare', 12000);
  await openWalletPicker(p);
  const before = await listWallets(p);
  const beforeLine = before.find((line) => line.startsWith('Solflare'));
  ok(beforeLine && !/CONNECT/i.test(beforeLine), `a wallet that has not injected yet is not offered as ready (${beforeLine})`);

  await p.waitForFunction(() => !!window.solflare, null, { timeout: 15000 });
  await p.waitForTimeout(1200);
  const after = await listWallets(p);
  const afterLine = after.find((line) => line.startsWith('Solflare'));
  ok(/CONNECT/i.test(afterLine || ''), `it becomes connectable without reopening the window (${afterLine})`);
  await ctx.close();
}

// 3. A commit: the wallet signs, we send.
{
  const { ctx, p, errors, rpcSends } = await openPool('solflare');
  await openWalletPicker(p);
  await p.locator('.wallet-connect-dialog__option', { hasText: 'Solflare' }).first().click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 });
  await p.waitForTimeout(1200);

  // the commit dialog stayed open: press "Commit"
  await p.locator('.commit__submit').click().catch(() => {});
  await p.waitForTimeout(3000);

  const calls = await p.evaluate(() => window.__wallet.calls);
  ok(calls.includes('signTransaction'), `the wallet is asked to sign, not to send (${calls.join(' → ')})`);
  ok(
    !calls.includes('signAndSendTransaction'),
    'the wallet never sends the transaction itself: it would go to the network selected in the wallet'
  );
  ok(rpcSends() > 0, `the transaction goes out through our own node (${rpcSends()} sends)`);

  // The priority fee: without it a commit does not arrive on a busy network.
  const programs = await p.evaluate(() => window.__wallet.programs || []);
  ok(
    programs.includes('ComputeBudget111111111111111111111111111111'),
    `the commit carries a priority fee (${programs.join(', ')})`
  );
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 4. A wallet that announces itself through Wallet Standard and injects nothing
// of its own into the page: it has to be in the list and work in full.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ mint_address: MINTS.mochi, token_symbol: 'MOCHI', token_name: 'Mochi', is_pumpfun_mint: true })
  }));
  await ctx.route('**/auth/wallet/nonce', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ nonce: 'n', domain: 'localhost', uri: BASE, chain: 'solana:devnet', issued_at: new Date().toISOString(), expiration_time: new Date(Date.now() + 600000).toISOString() })
  }));
  await ctx.route('**/auth/wallet/verify', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ access_token: 'h.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.s' })
  }));
  // It registers through the standard, with a delay, like a real wallet.
  await ctx.addInitScript(`
    (() => {
      window.__std = [];
      const address = '${WALLET}';
      const account = { address, publicKey: new Uint8Array(32), chains: ['solana:devnet'], features: [] };
      const wallet = {
        name: 'Glow',
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        version: '1.0.0',
        chains: ['solana:devnet', 'solana:mainnet'],
        accounts: [],
        features: {
          'standard:connect': { version: '1.0.0', connect: async () => { window.__std.push('connect'); wallet.accounts = [account]; return { accounts: [account] }; } },
          'standard:disconnect': { version: '1.0.0', disconnect: async () => { window.__std.push('disconnect'); wallet.accounts = []; } },
          'standard:events': { version: '1.0.0', on: () => () => {} },
          'solana:signMessage': { version: '1.0.0', signMessage: async () => { window.__std.push('signMessage'); return [{ signedMessage: new Uint8Array(8), signature: new Uint8Array(64).fill(5) }]; } },
          'solana:signTransaction': { version: '1.0.0', signTransaction: async ({ transaction }) => { window.__std.push('signTransaction:' + (transaction?.length > 0)); return [{ signedTransaction: new Uint8Array([9, 9, 9]) }]; } }
        }
      };
      // A real wallet does both: announces itself and answers the page's
      // announcement. The fake has to behave the same way.
      const register = (api) => { try { api.register(wallet); } catch (e) {} };
      window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail));
      const announce = () => {
        window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
      };
      setTimeout(announce, 900);
    })();
  `);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  let rpcSends = 0;
  p.on('request', (r) => { if (/\/rpc$/.test(r.url()) && /sendTransaction/.test(r.postData() || '')) rpcSends++; });
  await ctx.route('**/rpc', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const reply = (result) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
    if (body.method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 } });
    if (body.method === 'sendTransaction') return reply(SIGNATURE);
    if (body.method === 'getRecentPrioritizationFees') return reply([{ slot: 1, prioritizationFee: 30000 }]);
    if (body.method === 'getSignatureStatuses') return reply({ context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
    return reply(null);
  });
  await ctx.route('**/lottery/bet', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' }));

  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(900);
  await openWalletPicker(p);
  const list = await listWallets(p);
  const glow = list.find((line) => line.startsWith('Glow'));
  ok(/CONNECT/i.test(glow || ''), `a wallet that only speaks Wallet Standard shows up (${list.join(' | ')})`);

  await p.locator('.wallet-connect-dialog__option', { hasText: 'Glow' }).first().click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 }).catch(() => {});
  const afterSignIn = await p.evaluate(() => window.__std);
  ok(afterSignIn.includes('connect') && afterSignIn.includes('signMessage'), `it connects and signs through the standard (${afterSignIn.join(' → ')})`);

  await p.locator('.commit__submit').click().catch(() => {});
  await p.waitForTimeout(3000);
  const afterCommit = await p.evaluate(() => window.__std);
  ok(afterCommit.some((call) => call.startsWith('signTransaction')), `and signs the commit through the standard (${afterCommit.join(' → ')})`);
  ok(rpcSends > 0, `the commit still goes out through our node (${rpcSends})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

console.log(fails ? `${fails} FAILED` : 'WALLET CONNECT ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
