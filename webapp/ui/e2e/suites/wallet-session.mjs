// Signing in with a wallet: the browser has to remember the address, signing out
// has to disconnect the wallet, and swapping the wallet in the extension has to
// close the session.
import { launch } from '../lib/browser.mjs';
import { SCENARIOS, mockCurrent } from '../lib/pool-mock.mjs';
const BASE = process.env.BASE || 'http://localhost:3200';
const WALLET = 'FakeWa11etAddress111111111111111111111111111';
// base58: no zero, capital O, capital I or lowercase l — otherwise the address will not parse
const OTHER = 'SecondWa11etAddress222222222222222222222222';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
/** The wallet list does not always appear: if it is there, we pick Phantom. */
const pickPhantom = async (page) => {
  const picker = page.locator('.wallet-connect-dialog__name', { hasText: 'Phantom' });
  if (await picker.count().catch(() => 0)) {
    await picker.first().click().catch(() => {});
    return;
  }
  await page.waitForSelector('.wallet-connect-dialog__name', { timeout: 4000 }).then(
    () => page.locator('.wallet-connect-dialog__name', { hasText: 'Phantom' }).first().click().catch(() => {}),
    () => {}
  );
};

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await mockCurrent(ctx, () => SCENARIOS.open());
await ctx.route('**/auth/wallet/nonce', (route) => route.fulfill({
  status: 200, contentType: 'application/json', headers: cors,
  body: JSON.stringify({ nonce: 'nonce-1', domain: 'localhost', uri: 'http://localhost:3200', chain: 'solana:devnet', issued_at: new Date().toISOString(), expiration_time: new Date(Date.now() + 600000).toISOString() })
}));
await ctx.route('**/auth/wallet/verify', (route) => route.fulfill({
  status: 200, contentType: 'application/json', headers: cors,
  body: JSON.stringify({ access_token: 'header.' + Buffer.from(JSON.stringify({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.sig' })
}));

// A fake wallet: it connects, signs a message and can disconnect.
await ctx.addInitScript(({ wallet }) => {
  const listeners = {};
  const provider = {
    isPhantom: true,
    publicKey: null,
    isConnected: false,
    __disconnectCalls: 0,
    connect: async () => {
      provider.publicKey = { toBase58: () => window.__walletAddress || wallet, toString: () => window.__walletAddress || wallet };
      provider.isConnected = true;
      return { publicKey: provider.publicKey };
    },
    disconnect: async () => {
      provider.__disconnectCalls += 1;
      provider.isConnected = false;
      provider.publicKey = null;
      (listeners['disconnect'] || []).forEach((handler) => handler());
    },
    signMessage: async (message) => ({ signature: new Uint8Array(64).fill(7) }),
    // A wallet only counts as usable if it can sign transactions.
    signAndSendTransaction: async () => ({ signature: 'stub' }),
    on: (event, handler) => { (listeners[event] = listeners[event] || []).push(handler); },
    off: () => {}
  };
  window.__walletAddress = wallet;
  window.__emitAccountChanged = (address) => {
    window.__walletAddress = address;
    provider.publicKey = address ? { toBase58: () => address, toString: () => address } : null;
    (listeners['accountChanged'] || []).forEach((handler) => handler(provider.publicKey));
  };
  window.__disconnectCalls = () => provider.__disconnectCalls;
  window.phantom = { solana: provider };
}, { wallet: WALLET });

const p = await ctx.newPage();
const errors = []; p.on('pageerror', (e) => errors.push(e.message));
for (let a = 0; a < 3; a++) { try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; } }
await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });

// signing in with a wallet through the dialog
await p.locator('header button', { hasText: /^\s*Sign in\s*$/i }).first().click();
await p.waitForSelector('app-auth-dialog', { timeout: 8000 });
await p.locator('app-auth-dialog button', { hasText: /wallet/i }).first().click();
await pickPhantom(p);
await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 20000 });
const linked = await p.evaluate(() => localStorage.getItem('qres.wallet.linkedAddress'));
ok(linked === WALLET, `signing in with a wallet remembers it (${linked})`);

// signing out disconnects the wallet
await p.waitForTimeout(600);
await p.locator('header button', { hasText: /^\s*Sign out\s*$/i }).first().click();
await p.waitForSelector('app-confirmation-dialog, .qres-confirm-panel', { timeout: 8000 });
await p.locator('.qres-confirm-panel button, app-confirmation-dialog button', { hasText: /sign out|yes|confirm/i }).first().click();
await p.waitForFunction(() => !localStorage.getItem('jwt'), null, { timeout: 10000 });
const after = await p.evaluate(() => ({ linked: localStorage.getItem('qres.wallet.linkedAddress'), disconnects: window.__disconnectCalls() }));
ok(after.disconnects >= 1, `signing out disconnects the wallet (${after.disconnects} calls)`);
ok(after.linked === null, 'the remembered wallet is cleared on sign out');

// swapping the wallet in the extension closes the session
await p.locator('header button', { hasText: /^\s*Sign in\s*$/i }).first().click();
await p.waitForSelector('app-auth-dialog', { timeout: 8000 });
await p.locator('app-auth-dialog button', { hasText: /wallet/i }).first().click();
await pickPhantom(p);
await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 20000 });
await p.waitForTimeout(800);
await p.evaluate((other) => window.__emitAccountChanged(other), OTHER);
const loggedOut = await p.waitForFunction(() => !localStorage.getItem('jwt'), null, { timeout: 15000 }).then(() => true).catch(() => false);
ok(loggedOut, 'switching the wallet in the extension closes the session');

ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
console.log(fails ? `${fails} FAILED` : 'WALLET SESSION ALL PASSED');
process.exitCode = fails ? 1 : 0;
await b.close();
