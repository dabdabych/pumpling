// Mocks for the main page beyond the Commit SOL card: the coins for the
// bubbles (`/lottery/coins/backed`) and the chat behind the header button.
const cors = { 'access-control-allow-origin': '*' };
const iso = (ms) => new Date(Date.now() + ms).toISOString();

/** The six coins over 1 SOL on mainnet on 2026-10-16, with made-up pictures. */
export const BACKED = [
  { mint: '8QSGZb2hc8zTM4GxsEUBfPhPUwZZDWWxUPdZPHvbpump', name: 'pumpling', symbol: 'PUMPLING', logo: 'purple', sol: 20.05, pools: 2, venue: 'pump.fun' },
  { mint: '56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump', name: 'Mochi', symbol: 'MOCHI', logo: 'green', sol: 10.45, pools: 1, venue: 'pump.fun' },
  { mint: 'EdK4Hbfj63AWvQZxVGh12MBkM9hLVhgyBXhabEE8pump', name: 'Toad Signal', symbol: 'TOAD', logo: null, sol: 2.6, pools: 1, venue: 'pump.fun' },
  { mint: 'FddAtDgXjuEJ2VbnN4w6T4wMfodAzjZbGQSnn2DGpump', name: 'Broken Picture', symbol: 'BROKEN', logo: 'broken', sol: 2.5, pools: 1, venue: 'pump.fun' },
  { mint: 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP', name: 'Super Intelligence', symbol: 'SI', logo: 'cyan', sol: 1.05, pools: 2, venue: 'DexScreener' },
  // A ticker that carries its own dollar sign, as some do on pump.fun.
  { mint: 'Be7XH8yqkyWBzJgUVSX5pa3bnzQsR13PTn6oJnrzpump', name: 'cat', symbol: '$CAT', logo: 'yellow', sol: 1.0, pools: 2, venue: 'pump.fun' }
];

const FILL = { purple: '#AF8FFF', green: '#8FFFAF', cyan: '#25BDE5', yellow: '#FFD86B' };

export function backedBody(coins = BACKED) {
  return {
    min_sol: 1,
    items: coins.map((c) => ({
      mint: c.mint, name: c.name, symbol: c.symbol,
      logo_url: c.logo ? `https://img.test/${c.logo}/${c.mint}.svg` : null,
      sol: c.sol, pools: c.pools, last_at: iso(-3600_000),
      trade_url: c.venue === 'pump.fun' ? `https://pump.fun/coin/${c.mint}` : `https://dexscreener.com/solana/${c.mint}`,
      venue: c.venue
    }))
  };
}

/**
 * `mode`: 'ok' (the six), 'empty', 'fail', or an array of coins. The pictures
 * are served from img.test: a coloured disc with the ticker, or a 404 for 'broken'.
 */
export async function mockBubbles(ctx, mode = 'ok') {
  await ctx.route('**/lottery/coins/backed**', (route) => {
    if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{}' });
    const coins = mode === 'empty' ? [] : Array.isArray(mode) ? mode : BACKED;
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(backedBody(coins)) });
  });
  await ctx.route('https://img.test/**', (route) => {
    const [, colour, file] = new URL(route.request().url()).pathname.split('/');
    if (colour === 'broken') return route.fulfill({ status: 404, body: '' });
    const coin = BACKED.find((c) => file.startsWith(c.mint));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${FILL[colour] ?? '#ccc'}"/><circle cx="50" cy="42" r="20" fill="#020202" opacity=".15"/><text x="50" y="58" font-family="Arial" font-weight="700" font-size="22" text-anchor="middle" fill="#020202">${(coin?.symbol ?? '?').slice(0, 3)}</text></svg>`;
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });
}

/**
 * The chat: its id and `count` messages, the newest with id `newestId`. With
 * `pictureEvery`, every so many messages carry a picture, 320x240, that
 * arrives `pictureDelayMs` after it is asked for: pictures with no height yet
 * are what moved the bottom of the chat once (chat-scroll).
 */
export async function mockChat(ctx, { count = 6, newestId = 42, pictureEvery = 0, pictureDelayMs = 1500 } = {}) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: newestId - count + 1 + i,
    chat_id: 1,
    content: ['gm', 'just added a coin to try lol', 'same lol', 'wow, the tech works good', 'when next pool?', "I've commited SOL on pumpling!"][i % 6],
    created_at: iso(-(count - i) * 300_000),
    author: { id: i + 1, name: `wallet_${'C2rcz5Ve1XxU8KYeZQnjrJLyA'.slice(0, 10 + (i % 15))}` },
    reply_to: null,
    attachment: pictureEvery && (count - 1 - i) % pictureEvery === 0 ? { id: `picture-${i}`, mime_type: 'image/svg+xml' } : null
  }));
  await ctx.route('**/chats/1/attachments/*', async (route) => {
    await new Promise((done) => setTimeout(done, pictureDelayMs));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#AF8FFF"/></svg>';
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: cors, body: svg });
  });
  await ctx.route('**/chats/default', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ id: 1, slug: 'general', title: 'General chat' }) }));
  await ctx.route('**/chats/1/messages**', (route) => {
    const limit = Number(new URL(route.request().url()).searchParams.get('limit') ?? 150);
    const items = messages.slice(-limit);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ items, has_more: false }) });
  });
  return messages;
}

/**
 * A coin's window (`/lottery/coins/<mint>/story`): the launch pool of
 * 2026-10-04, its real 46 buys and GeckoTerminal's real candles, under the
 * asked coin's mint and ticker. `mode`: 'ok' (a final chart), 'busy', 'none',
 * 'failed' or 'pending' (no candles; pending: not fetched yet),
 * 'running' (the pool still taking SOL), 'unknown' (the buyer silent), 'nobuys'
 * (finished, its share zero: the stay ends at the close), 'nosupply' (the price
 * drawn, not the market cap), 'refunded' (a share,
 * not bought, sent back: LETTER on the stand), 'fail' (a 500).
 */
export async function mockStory(ctx, mode = 'ok') {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/pumpling-story.json', import.meta.url)));
  await ctx.route('**/lottery/coins/*/story', (route) => {
    if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{}' });
    const mint = new URL(route.request().url()).pathname.split('/').at(-2);
    const coin = BACKED.find((c) => c.mint === mint) ?? BACKED[0];
    const body = { ...fixture, mint, name: coin.name, symbol: coin.symbol, logo_url: coin.logo ? `https://img.test/${coin.logo}/${mint}.svg` : null,
      trade_url: coin.venue === 'pump.fun' ? `https://pump.fun/coin/${mint}` : `https://dexscreener.com/solana/${mint}`, venue: coin.venue,
      chart_final: true, chart_updated_at: '2026-10-04T20:50:00Z', supply: 1e9 };
    if (mode === 'busy' || mode === 'none' || mode === 'failed' || mode === 'pending') Object.assign(body, { candles: null, candle_minutes: null, chart_url: null, chart_state: mode });
    if (mode === 'pending') Object.assign(body, { chart_final: false, chart_updated_at: null });
    if (mode === 'running') Object.assign(body, { finished: false, left_at: null, buys: [], chart_final: false, chart_updated_at: iso(-3 * 60_000 - 10_000) });
    if (mode === 'unknown') Object.assign(body, { buys: [], buys_known: false });
    if (mode === 'nosupply') Object.assign(body, { supply: null });
    if (mode === 'nobuys') Object.assign(body, { buys: [], left_at: '2026-10-04T20:40:00Z', share_sol: 0, refunded_sol: 0 });
    if (mode === 'refunded') Object.assign(body, { buys: [], left_at: '2026-10-04T20:40:00Z', share_sol: 15.019, refunded_sol: 15.019 });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  });
}
