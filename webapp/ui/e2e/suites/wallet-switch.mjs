// Switching wallets: sign out of one and into another.
//
// Until 2026-09-19 this was impossible. A service that already had a connected
// wallet silently returned that one, and signing out only released the wallet if
// it was the one signed in with. Somebody who connected Phantom for a commit and
// signed in by email could not move to Solflare by any means short of clearing
// the site data.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';

const BASE = process.env.BASE || 'http://localhost:3200';
const PHANTOM = 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ';
const SOLFLARE = '2grLFGnXR1sezfjT6bNYnr46cQ3mD2og1j7PTn7nNsUD';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

// Two wallets in one page, like somebody with two extensions.
const twoWallets = `
(() => {
  const make = (address, flags) => {
    const key = { toString: () => address, toBase58: () => address };
    const provider = {
      ...flags,
      publicKey: null,
      isConnected: false,
      connect: async () => { provider.publicKey = key; provider.isConnected = true; window.__log.push('connect:' + flags.tag); return { publicKey: key }; },
      disconnect: async () => { provider.publicKey = null; provider.isConnected = false; window.__log.push('disconnect:' + flags.tag); },
      signMessage: async () => { window.__log.push('sign:' + flags.tag); return { signature: new Uint8Array(64).fill(3) }; },
      signTransaction: async (tx) => tx,
      on: () => {},
      off: () => {}
    };
    return provider;
  };
  window.__log = [];
  const phantom = make('${PHANTOM}', { isPhantom: true, tag: 'phantom' });
  const solflare = make('${SOLFLARE}', { isSolflare: true, tag: 'solflare' });
  window.phantom = { solana: phantom };
  window.solana = phantom;
  window.solflare = solflare;
})();
`;

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await mockCurrent(ctx, () => SCENARIOS.open());
let lastNonceAddress = null;
await ctx.route('**/auth/wallet/nonce', (route) => {
  lastNonceAddress = JSON.parse(route.request().postData() || '{}').address ?? null;
  return route.fulfill({
    status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify({ nonce: 'n', domain: 'localhost', uri: BASE, chain: 'solana:devnet', issued_at: new Date().toISOString(), expiration_time: new Date(Date.now() + 600000).toISOString() })
  });
});
await ctx.route('**/auth/wallet/verify', (route) => route.fulfill({
  status: 200, contentType: 'application/json', headers: cors,
  body: JSON.stringify({ access_token: 'h.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.s' })
}));
await ctx.addInitScript(twoWallets);

const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) {
  try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
}
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
await p.waitForTimeout(900);

const signInWith = async (name) => {
  await p.locator('.site-header__auth, .site-header button', { hasText: 'Sign in' }).first().click();
  await p.waitForTimeout(700);
  await p.locator('.auth-method', { hasText: 'Continue with wallet' }).click();
  await p.waitForSelector('.wallet-connect-dialog__option', { timeout: 10000 });
  await p.waitForTimeout(400);
  const rows = await p.evaluate(() => Array.from(document.querySelectorAll('.wallet-connect-dialog__option')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
  await p.locator('.wallet-connect-dialog__option', { hasText: name }).first().click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 }).catch(() => {});
  return rows;
};

const signOut = async () => {
  await p.locator('.site-header__auth, .site-header button', { hasText: 'Sign out' }).first().click();
  await p.waitForTimeout(600);
  // The sign-out confirmation.
  const confirm = p.locator('button', { hasText: /Sign out|Yes|Confirm/i }).last();
  if (await confirm.count()) {
    await confirm.click().catch(() => {});
  }
  await p.waitForFunction(() => !localStorage.getItem('jwt'), null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(600);
};

// 1. Sign in with Phantom.
await signInWith('Phantom');
ok(lastNonceAddress === PHANTOM, `signs in with the wallet that was picked (${lastNonceAddress})`);

// 2. Sign out.
await signOut();
const afterOut = await p.evaluate(() => ({ jwt: !!localStorage.getItem('jwt'), log: window.__log }));
ok(!afterOut.jwt, 'the session is gone after signing out');
ok(afterOut.log.includes('disconnect:phantom'), `the wallet is released on sign out (${afterOut.log.join(' → ')})`);

// 3. Sign in with another wallet: the chooser has to appear again.
const rows = await signInWith('Solflare');
ok(rows.length >= 2, `the picker comes back so another wallet can be chosen (${rows.join(' | ')})`);
ok(lastNonceAddress === SOLFLARE, `the second sign in uses the second wallet (${lastNonceAddress})`);

// 4. And back to the first, with no page reload.
await signOut();
await signInWith('Phantom');
ok(lastNonceAddress === PHANTOM, `switching back works too (${lastNonceAddress})`);

// 5. Switching wallets inside the commit dialog, without signing out. This is the
// main case: somebody is already signed in but wants to pay from another wallet.
await p.locator('.coin-row__add').first().click();
await p.waitForSelector('.commit__title', { timeout: 12000 });
await p.waitForTimeout(900);
const before = (await p.locator('.commit__wallet').innerText().catch(() => '')).replace(/\s+/g, ' ');
ok(/Phantom/i.test(before), `the commit window says which wallet signs (${before})`);

await p.locator('.commit__wallet-change').click();
await p.waitForSelector('.wallet-connect-dialog__option', { timeout: 10000 });
const picker = await p.evaluate(() => Array.from(document.querySelectorAll('.wallet-connect-dialog__option')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
ok(picker.some((line) => /Phantom CONNECTED/i.test(line)), `the picker marks the wallet in use (${picker.join(' | ')})`);

await p.locator('.wallet-connect-dialog__option', { hasText: 'Solflare' }).first().click();
await p.waitForTimeout(2500);
const after = await p.evaluate(() => ({
  line: (document.querySelector('.commit__wallet')?.innerText || '').replace(/\s+/g, ' '),
  dialog: !!document.querySelector('.commit__title'),
  jwt: !!localStorage.getItem('jwt'),
  linked: localStorage.getItem('qres.wallet.linkedAddress')
}));
ok(/Solflare/i.test(after.line), `and the commit window switches over (${JSON.stringify(after)})`);
ok(after.jwt && after.linked === SOLFLARE, `the session moves to the new wallet, without dropping the person out (${JSON.stringify(after)})`);
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'WALLET SWITCH ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
