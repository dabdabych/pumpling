// A wallet that goes quiet in the middle of a commit.
//
// On 2026-09-30 the commit dialog sat on "Confirm in your wallet…" for good:
// the checks before the wallet had passed, the page had asked Phantom for its
// signature window, and Phantom answered nothing, no window and no error. Only
// reloading the page helped, and nothing on the page said so.
//
// What has to hold now:
//   - Phantom's connection is checked with Phantom itself before the signature
//     (`connect({ onlyIfTrusted: true })`, no window); silence there is named
//     within seconds;
//   - a window that has not opened after ten seconds is named too, with what to
//     do, and the button offers a fresh try;
//   - the old request stays open: approved late, the commit still goes through;
//     replaced by a fresh try, its signature is dropped and never sent;
//   - error -32002 (a request already open) gets its own words;
//   - other wallets are not asked anything new.
//
// On the code before this change the checks for all of that fail.
import { launch, BASE } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent, MINTS, commitCheck } from '../lib/pool-mock.mjs';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const WALLET = 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ';
const names = { [MINTS.mochi]: ['MOCHI', 'Mochi'], [MINTS.toad]: ['TOAD', 'Toad Signal'], [MINTS.zapz]: ['ZAPZ', 'Zapz'] };

const TEXT = {
  windowMissing: "Phantom hasn't opened its window. Click the Phantom icon in your browser's toolbar to find the request. If nothing's there, reload this page and try again.",
  windowMissingPhone: "Phantom hasn't shown the request. Reload this page and try again.",
  notResponding: "Phantom isn't responding. Click the Phantom icon in your browser's toolbar. If nothing opens, reload this page and try again.",
  requestPending: "Phantom already has a request waiting. Click the Phantom icon in your browser's toolbar, approve or reject it, then try again."
};

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

/**
 * A wallet the test steers through `window.__mode`: a signature that never
 * comes back (`sign: 'silent'`, released by the test through
 * `window.__pendingSigns`), a request already open (`sign: 'pending'`), or a
 * connection check that never answers (`trustedSilent`). Every call is logged.
 */
const fakeWallet = (kind) => `
(() => {
  const PUBKEY = '${WALLET}';
  window.__calls = [];
  window.__pendingSigns = [];
  window.__mode = { sign: 'normal', trustedSilent: false };
  const key = { toString: () => PUBKEY, toBase58: () => PUBKEY };
  const signed = () => ({ serialize: () => new Uint8Array([1, 2, 3]) });
  const provider = {
    publicKey: null, isConnected: false,
    connect: (options) => {
      const trusted = !!(options && options.onlyIfTrusted);
      window.__calls.push(trusted ? 'connect-trusted' : 'connect');
      if (trusted && window.__mode.trustedSilent) return new Promise(() => {});
      provider.publicKey = key; provider.isConnected = true;
      return Promise.resolve({ publicKey: key });
    },
    disconnect: async () => { provider.publicKey = null; provider.isConnected = false; },
    signMessage: async () => ({ signature: new Uint8Array(64).fill(7) }),
    signTransaction: () => {
      window.__calls.push('sign');
      if (window.__mode.sign === 'silent') return new Promise((resolve) => window.__pendingSigns.push(() => resolve(signed())));
      if (window.__mode.sign === 'pending') return Promise.reject({ code: -32002, message: 'Requests already pending' });
      return Promise.resolve(signed());
    },
    signAllTransactions: async (txs) => txs,
    on: () => {}, off: () => {}
  };
  if ('${kind}' === 'solflare') {
    provider.isSolflare = true;
    window.solflare = provider;
    window.dispatchEvent(new Event('solflare#initialized'));
  } else {
    provider.isPhantom = true;
    window.phantom = { solana: provider };
    window.solana = provider;
    window.dispatchEvent(new Event('phantom#initialized'));
  }
})();
`;

async function setup({ kind = 'phantom', mobile = false } = {}) {
  const ctx = await b.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/ios' }
    : { viewport: { width: 1440, height: 900 } });
  const sent = { count: 0 };
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', async (route) => {
    const mint = JSON.parse(route.request().postData() || '{}').mint_address;
    const [symbol, name] = names[mint] ?? ['NEW', 'New coin'];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
      mint_address: mint, token_symbol: symbol, token_name: name, is_pumpfun_mint: true, can_burn: true
    }) });
  });
  await ctx.route('**/auth/wallet/nonce', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ nonce: 'nonce-1', domain: 'localhost', uri: BASE, chain: 'solana:devnet', issued_at: new Date().toISOString(), expiration_time: new Date(Date.now() + 600000).toISOString() }) }));
  await ctx.route('**/auth/wallet/verify', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ access_token: 'header.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig' }) }));
  await ctx.route('**/lottery/bet', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' }));
  await ctx.route('**/rpc', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const method = Array.isArray(body) ? body[0]?.method : body.method;
    const reply = (result) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }) });
    if (method === 'getLatestBlockhash') return reply({ context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 } });
    if (method === 'sendTransaction') { sent.count += 1; return reply('5'.repeat(88)); }
    const checked = commitCheck(method);
    if (checked !== undefined) return reply(checked);
    if (method === 'getSignatureStatuses') return reply({ context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
    return reply(null);
  });
  await ctx.addInitScript(fakeWallet(kind));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1000);

  // Open the commit dialog on the first coin and sign in with the wallet.
  await p.locator('.coin-row__add').first().click();
  await p.waitForSelector('.commit__title', { timeout: 10000 });
  await p.waitForTimeout(900);
  await p.locator('.commit__submit').click();
  await p.waitForTimeout(800);
  await p.locator('.auth-method', { hasText: 'Continue with wallet' }).click();
  await p.waitForSelector('.wallet-connect-dialog__option', { timeout: 10000 });
  const label = kind === 'solflare' ? 'Solflare' : 'Phantom';
  const option = p.locator('.wallet-connect-dialog__option', { hasText: label }).first();
  await p.waitForFunction((name) => [...document.querySelectorAll('.wallet-connect-dialog__option')]
    .some((el) => el.textContent.includes(name) && /connect/i.test(el.textContent) && !el.disabled), label, { timeout: 10000 });
  await option.click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 });
  await p.waitForTimeout(1200);
  return { ctx, p, errors, sent };
}

// The dialog may be gone (a commit that went through closes it): read without waiting.
const submitText = async (p) => ((await p.locator('.commit__submit').count()) ? (await p.locator('.commit__submit').innerText()).trim() : '(no dialog)');
const submitEnabled = async (p) => ((await p.locator('.commit__submit').count()) ? p.locator('.commit__submit').isEnabled() : false);
const callsSince = (p, from) => p.evaluate((n) => window.__calls.slice(n), from);
const commit = async (p) => {
  const from = await p.evaluate(() => window.__calls.length);
  await p.locator('.commit__submit').click();
  return from;
};

// 1. A window that never opens, and 2. an approval that comes late.
{
  const { ctx, p, errors, sent } = await setup();
  await p.evaluate(() => { window.__mode.sign = 'silent'; });
  const from = await commit(p);
  const clicked = Date.now();
  await p.waitForTimeout(8000);
  ok(await p.locator('.commit__stalled').count() === 0, 'nothing is said while the wallet may still be opening (8 s)');
  const shown = await p.waitForSelector('.commit__stalled', { timeout: 7000 }).then(() => true).catch(() => false);
  const after = (Date.now() - clicked) / 1000;
  ok(shown, `after ten seconds the page says the window has not opened (${after.toFixed(1)} s)`);
  const note = shown ? (await p.locator('.commit__stalled').innerText()).trim() : '';
  ok(note === TEXT.windowMissing, `in plain words, with what to do (${note})`);
  ok(shown && await p.locator('.commit__stalled').getAttribute('role') === 'status', 'and it is announced to a screen reader');
  ok(await submitText(p) === 'Try again' && await submitEnabled(p), `the button offers a fresh try (${await submitText(p)})`);
  ok(sent.count === 0, 'nothing has been sent');
  const calls = await callsSince(p, from);
  ok(calls[0] === 'connect-trusted' && calls.includes('sign'), `Phantom was checked without a window, then asked to sign (${calls.join(', ')})`);

  await p.evaluate(() => window.__pendingSigns.shift()?.());
  await p.waitForFunction(() => document.querySelectorAll('app-commit-dialog').length === 0, null, { timeout: 8000 }).catch(() => {});
  ok(sent.count === 1, `approved late, the commit still goes out, once (${sent.count})`);
  ok(await p.locator('app-commit-dialog').count() === 0, 'and the dialog closes as after any commit');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 3. A fresh try replaces the stuck one: its late signature is never sent.
{
  const { ctx, p, errors, sent } = await setup();
  await p.evaluate(() => { window.__mode.sign = 'silent'; });
  await commit(p);
  await p.waitForSelector('.commit__stalled', { timeout: 15000 }).catch(() => {});
  await p.evaluate(() => { window.__mode.sign = 'normal'; });
  const offered = await submitEnabled(p);
  ok(offered, 'the stuck request can be replaced by a fresh try');
  if (offered) {
    await p.locator('.commit__submit').click();
    await p.waitForFunction(() => document.querySelectorAll('app-commit-dialog').length === 0, null, { timeout: 10000 }).catch(() => {});
  }
  ok(sent.count === 1, `the fresh try goes out (${sent.count})`);
  await p.evaluate(() => window.__pendingSigns.shift()?.());
  await p.waitForTimeout(1500);
  ok(sent.count === 1, `the stuck request, approved afterwards, is not sent as a second commit (${sent.count})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 4. Phantom does not answer the connection check at all.
{
  const { ctx, p, errors, sent } = await setup();
  await p.evaluate(() => { window.__mode.trustedSilent = true; });
  const from = await commit(p);
  const clicked = Date.now();
  const shown = await p.waitForSelector('.commit__error', { timeout: 8000 }).then(() => true).catch(() => false);
  const after = (Date.now() - clicked) / 1000;
  const text = shown ? (await p.locator('.commit__error').innerText()).trim() : '';
  ok(shown && text === TEXT.notResponding, `a Phantom that does not answer is named within seconds (${after.toFixed(1)} s: ${text})`);
  const calls = await callsSince(p, from);
  ok(calls.includes('connect-trusted') && !calls.includes('sign'), `it is not asked for a signature it would not show (${calls.join(', ')})`);
  ok((await submitText(p)).startsWith('Commit') && await submitEnabled(p), `the button is back (${await submitText(p)})`);
  ok(sent.count === 0, 'nothing has been sent');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 5. Phantom already has a request open (-32002).
{
  const { ctx, p, errors, sent } = await setup();
  await p.evaluate(() => { window.__mode.sign = 'pending'; });
  await commit(p);
  const shown = await p.waitForSelector('.commit__error', { timeout: 8000 }).then(() => true).catch(() => false);
  const text = shown ? (await p.locator('.commit__error').innerText()).trim() : '';
  ok(text === TEXT.requestPending, `a request already open gets its own words (${text})`);
  ok(sent.count === 0 && (await submitText(p)).startsWith('Commit'), 'nothing sent, the button is back');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 6. Other wallets are not asked anything new.
{
  const { ctx, p, errors, sent } = await setup({ kind: 'solflare' });
  const from = await commit(p);
  await p.waitForFunction(() => document.querySelectorAll('app-commit-dialog').length === 0, null, { timeout: 10000 }).catch(() => {});
  const calls = await callsSince(p, from);
  ok(!calls.includes('connect-trusted'), `Solflare gets no connection check before signing (${calls.join(', ')})`);
  ok(sent.count === 1, `and the commit goes out as before (${sent.count})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 7. On a phone there is no toolbar to point at.
{
  const { ctx, p, errors } = await setup({ mobile: true });
  await p.evaluate(() => { window.__mode.sign = 'silent'; });
  await commit(p);
  const shown = await p.waitForSelector('.commit__stalled', { timeout: 15000 }).then(() => true).catch(() => false);
  const note = shown ? (await p.locator('.commit__stalled').innerText()).trim() : '';
  ok(note === TEXT.windowMissingPhone, `phone: the advice is the reload (${note})`);
  const visible = shown && await p.locator('.commit__stalled').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const button = document.querySelector('.commit__submit').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight && (r.bottom <= button.top || r.top >= button.bottom);
  });
  ok(visible, 'phone: the note is on screen, not under the sticky button');
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

await b.close();
console.log(fails ? `\nWALLET SILENT: ${fails} FAILED` : '\nWALLET SILENT ALL PASSED');
process.exit(fails ? 1 : 0);
