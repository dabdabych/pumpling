// The burn choice in the commit dialog: offered only where it can be kept, said
// in words that stand on their own on a narrow phone, and carried in the very
// transaction the wallet signs.
//
// On the code before the burn this suite fails from its first check: there is
// no burn block. The hover checks fail on the code before as well: the chosen
// priority turned pale under the pointer, and stayed pale after a tap on a phone.
import { launch, BASE } from '../lib/browser.mjs';
import { execSync } from 'node:child_process';
import { SCENARIOS, mockCurrent, MINTS, commitCheck } from '../lib/pool-mock.mjs';

const S = process.env.S;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const WALLET = 'EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const b = await launch();
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const names = { [MINTS.mochi]: ['MOCHI', 'Mochi'], [MINTS.toad]: ['TOAD', 'Toad Signal'], [MINTS.zapz]: ['ZAPZ', 'Zapz'] };
// $ZAPZ is a coin the buyer cannot burn: a paused mint, say.
const burnable = new Set([MINTS.mochi, MINTS.toad]);

/** A wallet that records what it is asked to sign. */
const fakeWallet = `
(() => {
  const PUBKEY = '${WALLET}';
  window.__signed = [];
  const key = { toString: () => PUBKEY, toBase58: () => PUBKEY };
  const provider = {
    isPhantom: true, publicKey: null, isConnected: false,
    connect: async () => { provider.publicKey = key; provider.isConnected = true; return { publicKey: key }; },
    disconnect: async () => { provider.publicKey = null; provider.isConnected = false; },
    signMessage: async () => ({ signature: new Uint8Array(64).fill(7) }),
    signTransaction: async (tx) => {
      window.__signed.push((tx?.instructions ?? []).map((ix) => ({
        program: ix.programId.toBase58(),
        text: new TextDecoder().decode(ix.data),
        signers: ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())
      })));
      return { serialize: () => new Uint8Array([1, 2, 3]) };
    },
    signAllTransactions: async (txs) => txs,
    on: () => {}, off: () => {}
  };
  window.phantom = { solana: provider }; window.solana = provider;
  window.dispatchEvent(new Event('phantom#initialized'));
})();
`;

const setup = async ({ width, height, mobile = false, wallet = false }) => {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await mockCurrent(ctx, () => SCENARIOS.open());
  await ctx.route('**/lottery/check-mint', async (route) => {
    const mint = JSON.parse(route.request().postData() || '{}').mint_address;
    const [symbol, name] = names[mint] ?? ['NEW', 'New coin'];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
      mint_address: mint, token_symbol: symbol, token_name: name, is_pumpfun_mint: true, can_burn: burnable.has(mint)
    }) });
  });
  if (wallet) {
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
      if (method === 'sendTransaction') return reply('5'.repeat(88));
      const checked = commitCheck(method);
      if (checked !== undefined) return reply(checked);
      if (method === 'getSignatureStatuses') return reply({ context: { slot: 2 }, value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
      return reply(null);
    });
    await ctx.addInitScript(fakeWallet);
  }
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  for (let a = 0; a < 3; a++) {
    try { await p.goto(BASE + '/pool', { waitUntil: 'domcontentloaded', timeout: 45000 }); break; } catch (e) { if (a === 2) throw e; }
  }
  await p.waitForFunction(() => !document.getElementById('qres-app-loader'), null, { timeout: 40000 });
  await p.waitForTimeout(1000);
  return { ctx, p, errors };
};

/** Open the dialog from a coin's row. */
const openFor = async (p, index = 0) => {
  await p.locator('.coin-row__add').nth(index).click();
  await p.waitForSelector('.commit__title', { timeout: 10000 });
  await p.waitForTimeout(900);
};

const burnState = (p) => p.evaluate(() => {
  const block = document.querySelector('.commit__burn');
  if (!block) return null;
  const options = [...block.querySelectorAll('.commit__burn-option')];
  return {
    options: options.map((o) => o.innerText.replace(/\s+/g, ' ').trim()),
    active: options.filter((o) => o.classList.contains('is-active')).map((o) => o.innerText.replace(/\s+/g, ' ').trim()),
    pressed: options.map((o) => o.getAttribute('aria-pressed')),
    line: block.querySelector('.commit__burn-line')?.textContent?.replace(/\s+/g, ' ').trim(),
    live: block.querySelector('.commit__burn-line')?.getAttribute('aria-live'),
    summary: document.querySelector('.commit__summary')?.textContent?.replace(/\s+/g, ' ').trim()
  };
});

const shot = async (p, name) => {
  if (!S) return;
  await p.screenshot({ path: `${S}/pw/shots/${name}.png`, clip: await p.locator('.commit').boundingBox() });
  execSync(`sips -s format jpeg -s formatOptions 80 -Z 900 ${S}/pw/shots/${name}.png --out ${S}/pw/shots/${name}.jpg >/dev/null && rm ${S}/pw/shots/${name}.png`);
};

// 1. Desktop: offered for a coin that can burn, starts at none, says what each choice does.
{
  const { ctx, p, errors } = await setup({ width: 1440, height: 900 });
  await openFor(p, 0); // $MOCHI
  let state = await burnState(p);
  ok(state !== null, 'the burn is offered for a coin the buyer can burn');
  ok(state && state.options.length === 4, `four choices (${state?.options.join(' | ')})`);
  ok(state && state.options[0] === '0% keep all' && state.options[2] === '50% keep half' && state.options[3] === '100% keep none', 'each card says what is kept');
  ok(state && state.active.length === 1 && state.active[0].startsWith('0%'), `none is chosen until the person chooses (${state?.active})`);
  ok(state && state.line === 'Every token bought for you comes to your wallet.', `the line under the cards says it in words (${state?.line})`);
  ok(state && state.live === 'polite', 'the line is announced when it changes');
  ok(state && !/burned/.test(state.summary ?? ''), `the summary says nothing about a burn at 0% (${state?.summary})`);

  await p.locator('.commit__burn-option').nth(2).click();
  await p.waitForTimeout(200);
  state = await burnState(p);
  ok(state.active.length === 1 && state.active[0].startsWith('50%'), `50% becomes the choice (${state.active})`);
  ok(state.pressed.join(',') === 'false,false,true,false', `and says so to a screen reader (${state.pressed})`);
  ok(/^Half of the tokens bought for you are burned on chain\. The other half comes to your wallet\.$/.test(state.line), `the line follows the choice (${state.line})`);
  ok(/0\.5 SOL goes behind \$MOCHI · .*% of the pool · half of what's bought for you is burned/.test(state.summary ?? ''), `the summary carries it (${state.summary})`);
  const bold = await p.locator('.commit__burn-line b').innerText();
  ok(bold === 'burned on chain', `the consequence is the bold part (${bold})`);

  // The active flame is drawn for a black card: a white outline.
  const flame = await p.evaluate(() => document.querySelector('.commit__burn-option.is-active app-flame path')?.getAttribute('stroke'));
  ok(/qres-white/.test(flame ?? ''), `the flame on the chosen card is inverted (${flame})`);
  await shot(p, 'burn-dialog-desk');

  // A coin that cannot be burned takes the choice away, and it does not come back set.
  await p.locator('#commit-mint').fill(MINTS.zapz);
  await p.waitForTimeout(1200);
  ok(await burnState(p) === null, 'no burn is offered for a coin the buyer cannot burn');
  const summary = await p.locator('.commit__summary').innerText();
  ok(!/burned/.test(summary), `and the summary drops it (${summary.replace(/\s+/g, ' ')})`);
  await p.locator('#commit-mint').fill(MINTS.toad);
  await p.waitForTimeout(1200);
  state = await burnState(p);
  ok(state && state.active[0]?.startsWith('0%'), `back on a burnable coin it starts from none again (${state?.active})`);
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}

// 2. The pointer over the chosen card does not repaint it (the old priority bug).
{
  const { ctx, p } = await setup({ width: 1440, height: 900 });
  await openFor(p, 0);
  await p.locator('.commit__priority-option').nth(1).click();
  await p.locator('.commit__burn-option').nth(1).click();
  await p.locator('.commit__priority-option').nth(1).hover();
  await p.waitForTimeout(300);
  const priorityBg = await p.locator('.commit__priority-option').nth(1).evaluate((el) => getComputedStyle(el).backgroundColor);
  ok(priorityBg === 'rgb(2, 2, 2)', `the chosen priority stays black under the pointer (${priorityBg})`);
  await p.locator('.commit__burn-option').nth(1).hover();
  await p.waitForTimeout(300);
  const burnBg = await p.locator('.commit__burn-option').nth(1).evaluate((el) => getComputedStyle(el).backgroundColor);
  ok(burnBg === 'rgb(2, 2, 2)', `the chosen burn stays black under the pointer (${burnBg})`);
  await p.locator('.commit__burn-option').nth(3).hover();
  await p.waitForTimeout(300);
  const otherBg = await p.locator('.commit__burn-option').nth(3).evaluate((el) => getComputedStyle(el).backgroundColor);
  ok(otherBg !== 'rgb(252, 252, 252)' && otherBg !== 'rgb(2, 2, 2)', `another card does light up under the pointer (${otherBg})`);
  await ctx.close();
}

// 3. Phones: 390 keeps the captions, 320 drops them and keeps the sentence; nothing spills.
for (const [width, height, captions] of [[390, 844, true], [360, 740, true], [320, 640, false]]) {
  const { ctx, p, errors } = await setup({ width, height, mobile: true });
  await openFor(p, 0);
  await p.locator('.commit__burn').scrollIntoViewIfNeeded();
  await p.locator('.commit__burn-option').nth(3).tap();
  await p.waitForTimeout(250);
  const layout = await p.evaluate(() => {
    const dialog = document.querySelector('.commit').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.commit__burn-option')].map((o) => o.getBoundingClientRect());
    const keeps = [...document.querySelectorAll('.commit__burn-keep')].map((k) => getComputedStyle(k).display);
    const values = [...document.querySelectorAll('.commit__burn-value')].map((v) => ({ fits: v.scrollWidth <= v.clientWidth + 1 }));
    return {
      inside: cards.every((c) => c.left >= dialog.left - 0.5 && c.right <= dialog.right + 0.5),
      oneRow: new Set(cards.map((c) => Math.round(c.top))).size === 1,
      keeps,
      valuesFit: values.every((v) => v.fits),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      line: document.querySelector('.commit__burn-line')?.textContent?.trim(),
      activeBg: getComputedStyle(document.querySelector('.commit__burn-option.is-active')).backgroundColor
    };
  });
  ok(layout.inside && layout.oneRow, `${width}px: four cards in one row inside the dialog`);
  ok(layout.valuesFit, `${width}px: every percentage fits its card`);
  ok(captions ? layout.keeps.every((d) => d !== 'none') : layout.keeps.every((d) => d === 'none'),
    `${width}px: captions ${captions ? 'shown' : 'hidden'} (${layout.keeps.join(',')})`);
  ok(layout.line === 'Every token bought for you is burned on chain. Nothing comes to your wallet.', `${width}px: the sentence says it all (${layout.line})`);
  ok(layout.activeBg === 'rgb(2, 2, 2)', `${width}px: a tap leaves the chosen card black, not stuck on a hover colour (${layout.activeBg})`);
  ok(!layout.overflowX, `${width}px: no sideways scroll`);
  ok(errors.length === 0, `${width}px: no page errors ${errors.join(' | ')}`);
  if (width === 320) await shot(p, 'burn-dialog-320');
  await ctx.close();
}

// 4. What the wallet signs: the memo with the choice, from the payer, after the deposit.
for (const [choice, expected] of [[2, 'pumpling burn 50%'], [0, null]]) {
  const { ctx, p, errors } = await setup({ width: 1440, height: 900, wallet: true });
  await openFor(p, 0);
  await p.locator('.commit__burn-option').nth(choice).click();
  await p.locator('.commit__submit').click();
  await p.waitForTimeout(800);
  await p.locator('.auth-method', { hasText: 'Continue with wallet' }).click();
  await p.waitForSelector('.wallet-connect-dialog__option', { timeout: 10000 });
  await p.locator('.wallet-connect-dialog__option', { hasText: 'Phantom' }).first().click();
  await p.waitForFunction(() => !!localStorage.getItem('jwt'), null, { timeout: 15000 });
  await p.waitForTimeout(1200);
  // Signing in must not have reset the choice.
  const still = await burnState(p);
  ok(still?.active[0]?.startsWith(choice === 2 ? '50%' : '0%'), `the choice survives signing in (${still?.active})`);
  await p.locator('.commit__submit').click();
  await p.waitForFunction(() => (window.__signed ?? []).length > 0, null, { timeout: 15000 }).catch(() => {});
  const signed = await p.evaluate(() => window.__signed?.[0] ?? []);
  const memos = signed.filter((ix) => ix.program === MEMO);
  if (expected) {
    ok(memos.length === 1 && memos[0].text === expected, `the signed transaction carries "${expected}" (${JSON.stringify(memos)})`);
    ok(signed[signed.length - 1]?.program === MEMO, 'the memo comes after the deposit');
    ok(memos[0]?.signers?.includes(WALLET), 'signed by the paying wallet');
  } else {
    ok(memos.length === 0 && signed.length > 0, `no memo at all for none (${signed.map((ix) => ix.program).join(', ')})`);
  }
  if (choice === 2) {
    // The card offered after the commit links to that commit by its signature:
    // the server looks the amount up, the link cannot claim one.
    const cta = p.locator('.pool-toast__cta');
    await cta.waitFor({ timeout: 15000 }).catch(() => {});
    ok(await cta.count() === 1, 'the confirmed commit offers its card');
    if (await cta.count()) {
      await cta.click();
      await p.waitForSelector('.share__button--x[href]', { timeout: 8000 });
      const post = new URL(await p.locator('.share__button--x').getAttribute('href')).searchParams.get('url') ?? '';
      ok(new RegExp(`/s/commit/${'5'.repeat(88)}\\?v=[0-9a-z]+$`).test(post), `the commit's card is linked by its signature (${post})`);
    }
  }
  ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await ctx.close();
}


await b.close();
console.log(fails ? `\nBURN DIALOG: ${fails} FAILED` : '\nBURN DIALOG ALL PASSED');
process.exit(fails ? 1 : 0);
