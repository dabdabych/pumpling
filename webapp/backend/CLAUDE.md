# CLAUDE.md — Backend (FastAPI)

The Python/FastAPI API: authentication, coins, commits, rounds, events, chat.
The database is PostgreSQL.

## Architecture — DDD layers

The code is arranged by layer, not by feature:

```
webapp/backend/
├── main.py                 # entry point: the FastAPI app and its routers
├── domain/                 # entities and business rules (auth, lottery)
├── application/            # use cases and services (auth, chat, lottery)
├── infrastructure/         # database, repositories, external integrations
├── presentation/           # routers and controllers (auth, chat, events,
│                           #   lottery, observer_internal, rpc)
├── shared/                 # cross-layer: jwt_handler, settings, rate_limit,
│                           #   admin_wallets, blocked_bet_mints, coin_chart,
│                           #   weights_commitment, purchases_payload,
│                           #   orao_vrf (the draw's derivations), …
├── migrations/             # SQL migrations (044 the last), applied in order, never rewritten
├── migrations_runner.py    # runs the migrations
├── create_tables.py        # initialises the schema
├── mint_validator.py       # validates coin mint addresses before a commit
└── tests/
```

Layer dependencies run `presentation → application → domain`, with
`infrastructure` implementing the domain interfaces. A new feature goes through
all the layers; do not pile logic into a router.

## Routers (main.py)

`auth_router`, `lottery_router`, `events_router`, `rpc_router`, `chat_router`,
`chat_ws_router`, `share_router`. Health: `GET /ping`, `GET /`. Profile:
`GET /profile`.

`rpc_router` is a narrow allowlist proxy to the Solana node: the browser never
gets the RPC key, and only the methods the site actually needs are permitted.
It spends the same Helius plan as the buyer, so it is limited per client
(`RPC_PROXY_RATE_LIMIT_PER_MINUTE`, every call in a batch counts) and for
everybody together (`RPC_PROXY_GLOBAL_LIMIT_PER_MINUTE`). The client is the
last address in X-Forwarded-For, the one nginx appends; everything before it is
the client's own word (`shared/rate_limit.client_key`). The other paths that
spend the plan without a sign-in are bounded the same way: Helius DAS lookups
have a shared ceiling and come after the free sources, `check-mint` and `bet`
have shared ceilings in `shared/rate_limit.RULES`, and the verification page
reads the chain only for a round in progress, once per 15 seconds.

**Two Helius keys, two jobs.** `HELIUS_API_KEY` is the proxy's first node; on a
devnet server it is rewritten to `devnet.helius-rpc.com` with that key, so
every visitor's wallet call is paid with it. `HELIUS_DAS_API_KEY` is read by the
DAS lookups (coin names and pictures) and by nothing else; empty, they use
`HELIUS_API_KEY`. A server that should pay for pictures and nothing more, the
devnet stand, sets the second alone. DAS has two ceilings for everybody
together: `HELIUS_DAS_LIMIT_PER_MINUTE` (30) and `HELIUS_DAS_DAILY_LIMIT` (none
unless set), so the most a day can cost is the daily number x 10 credits. Any
signed-in visitor can make the API look up a coin nobody has looked up yet, and
real mints run into the millions: a daily ceiling is what stops that from
being a way to spend the plan.

**Any call that reads a transaction asks for `maxSupportedTransactionVersion:
1`.** Version 1 transactions are live on mainnet, devnet and testnet, and a node
asked with `0` refuses a v1 transaction outright (-32015), exactly as it refuses
a v0 one when the option is left out — the omission that stopped the backfill
worker for two months (`workers/CLAUDE.md`). Everything here reads the raw JSON
through `shared/solana_rpc.py`, which defaults to `1`, and takes only `meta` and
the log, the same in every version. The admin area still asks for `0`: it
decodes messages with web3.js 1.x, which cannot read a v1 message either way.
The proxy does not add the option: it forwards what the caller sent.

`GET /lottery/{id}/verification` is public and needs no auth. It returns
everything a round rests on: the weights commitment with the exact text that was
hashed, where the randomness came from, the algorithm fingerprint, and the
result. It is the endpoint the "Verify this pool" button on the site uses, so
its shape is a public contract.

## Share links

`presentation/share/share_router.py`, behind `/s/` on the site (nginx rewrites
it to `/share/`): `/s/pool/<id>`, `/s/coin/<id>/<mint>`, `/s/commit/<signature>`.
X and the other previewers build a link's card from `og:`/`twitter:` tags and
run no script, so a link to the pool page always showed the generic picture. A
preview crawler (told apart by user agent) gets a page with the tags and
`.../card.png`, the site's share card redrawn in Pillow at 1200x600, the 2:1
X shows (`shared/share_card.py`). A person gets a 302 to the pool. Everything on
the card is read from the database (`application/lottery/share_card_data.py`);
the link carries only keys. The words are the site's, and
`tests/test_share_card.py` reads `share-card.ts` to keep them so.

The coin's picture comes from an address the coin's creator wrote, so
`shared/remote_image.py` fetches it as untrusted: public addresses only,
checked after resolving and connected to directly, redirects re-checked, size,
pixel and time limits, and a small pool of its own threads so a slow server
cannot tie up the API.

The card in the share dialog is drawn on a canvas in the browser, and a canvas
only takes a picture whose server allows it (CORS). DexScreener's CDN does not,
so a coin whose picture came from there showed its initials on that card while
the coin list showed the picture (2026-10-02). `/share/coin-logo/<mint>` serves
the stored picture from our own origin, fetched the same untrusted way; it takes
a mint, never an address, so it is no open proxy. The dialog asks it first,
then the picture's own address, then draws the initials.

## Coin pictures on IPFS

ipfs.io stopped serving files over HTTP on 2026-09-21, and most pump.fun
pictures point there, whether they come from pump.fun, Helius DAS or Helius's
image CDN. `shared/coin_images.py` rewrites any IPFS address (a `/ipfs/<cid>`
path, a `<cid>.ipfs.` subdomain, `ipfs://`, or Helius's CDN in front of one) to
pump.fun's Pinata gateway, by content id. The rewrite sits in the response
types (`ImageUrl` in `application/lottery/schemas.py`), so every answer that
carries a picture goes through it and what is stored stays what the sources
said. The share card fetches through each gateway in turn, Filebase second.

## A coin's name and picture

A coin search (`check-mint`) asks pump.fun, DexScreener and the chain at once
and waits two seconds at most (`_quick_token_metadata`); it never pays for
Helius DAS. The chain gives the name and ticker of a coin minutes old, which
DexScreener does not know yet and pump.fun refuses to tell the stand: a
Token-2022 mint carries them in its TokenMetadata extension, an SPL Token mint
in its Metaplex account (`mint_validator.token_2022_name`, `metaplex_name`,
checked on mainnet accounts). Its uri is not followed: a stranger wrote it.
A picture that is not there yet is not waited for. Once a commit to the coin
is confirmed, `shared/coin_picture_fill.py`, a thread in the API, looks again
on a schedule kept in `token_metadata` (migration 044): 1, 2, 5, 10 and 30
minutes, then 1, 2 and 6 hours, nine tries over about ten hours, DAS on the
first and fourth only, inside the DAS ceilings. It runs whether or not the
pool is open. Before, an in-memory queue fed by the pool page's polls tried
every half hour while the pool was on screen and forgot everything on a
restart; on the stand's short pools TOILETDOG got one try and never its
picture, though DexScreener had it an hour later.

Every outside call goes through `shared/fast_http.py`, which gives an address
1.5 s to accept a connection before trying the next and remembers a dead one
for two minutes. On 2026-10-02 the stand could not reach 8.6.112.0, one of the
two addresses Cloudflare gives for DexScreener, pump.fun and Helius, and the
standard library waited the whole 6 s timeout on it about half the time: ten
connections to DexScreener took 42.1 s, through `fast_http` 1.6 s. A test
fails if a new `urlopen` skips it.

## Red flags on a coin

A pool is an announced buy that cannot be called off, which makes it perfect
exit liquidity for whoever holds a lot of the coin. Each coin is checked once,
at its first confirmed commit in a pool. The site shows what was read in a card
behind a mark next to the ticker, the same mark on every coin, with the obvious
cases in red inside. The pool still buys a flagged coin.

`coin_screening_worker` queues the coins and runs the checks
(`shared/coin_screening_store.py`); the rule is in `shared/coin_screening.py`,
with the reasoning in its docstring. A flag on its own: the creator over 20%,
bundlers still over 20%, a bundled launch over half the supply with bundlers
still over 5%, linked wallets over 15%, the top ten over 40% while the coin is
on its pump.fun curve, liquidity pulled once it is off the curve, or a power
over holders written into the mint (freeze, mint more, a permanent delegate,
non-transferable, frozen by default, pausable; `mint_validator.mint_red_flags`,
read from the chain with no provider). Whether a coin is on its curve is read
from the bonding-curve account (`read_curve`). The first version needed the top
ten over 40% behind any cluster and called Krackpot clean on 2026-10-02 while
pump.fun showed its bundlers in red. Calibrated on 127 live coins that day: 18
flags, 1 of them among the 20 coins over $100k older than a day.

The check keeps the level it read for each holder rule (`levels`) and whether
the coin was on its curve (`on_curve`, migration 043), and the site shows those
readings rather than a verdict.

Holders come from tracced (`TRACCED_API_KEY`, bound to the server's address),
then Solana Tracker's Data API (`SOLANA_TRACKER_API_KEY`). tracced is a layer
over the same Solana Tracker endpoint, so the levels use tracced's cuts and
either path gives a coin the same answer (checked on six coins on 2026-10-02,
ages included). Solana Tracker's free plan is 2,500 requests a month and one
check is one request, so as the fallback it gets at most
`SOLANA_TRACKER_DAILY_LIMIT` calls a day (75), and none for the rest of the day
after a 429. With neither key the mint's own flags still work. A check that gets no answer is tried again with growing
pauses and gives up after three hours as `unavailable`, which the site shows as
nothing. Results go out as `screening` on `/lottery/current` entries and on
`/check-mint` for the pool open now (migrations 042 and 043, `coin_screenings`).

## The burn choice

A commit can ask for part of what is bought for its wallet to be burned
instead of delivered. The choice is a memo in the commit transaction itself
(`pumpling burn 50%`), never a request field, and it is read back by
`shared/burn_memo.py` from the transaction's log: `place_bet` does it when the
browser reports the commit, `events_worker` when it sees the deposit, with the
same function on the same lines. Only the non-upgradeable memo program
`MemoSq4g…` at the top level counts, and only exactly one burn memo; anything
doubtful is zero, so the participant gets their tokens. The format was checked
against the real program on mainnet (`tests/fixtures/burn_memo_logs.json`).

`bet_participations.burn_bps` (migration 041) holds it. `mint_validator.can_burn`
reads the mint account and refuses ConfidentialMintBurn, PermissionedBurn and a
paused Pausable mint, the cases where Token-2022's burn refuses; `/check-mint`
returns `can_burn` and the site offers the choice only then. The buyer payload
(`shared/purchases_payload.recipients_for`) carries each wallet's exact
`amountLamports` and `burnWeight` = Σ(lamports × bps); the contract with the
buyer is `offchain/tests/unit/fixtures/payload-contract.json`, tested on both
sides. `/lottery/current` gives each coin `burn_bps_avg`, `/my/commits` each of
my coins `burn_bps`, `/purchases` passes the buyer's `deliveries`, `burns` and
per-coin burn through, and `/verification` has a `burns` block: who asked, owed,
burned, the supply before and after, and every burn's signature.

## The commitment lives in one place

`shared/weights_commitment.py` builds the text that gets hashed into the round
and the hash itself. The phase worker and the router both import it, so the two
cannot drift apart. Do not reimplement the formatting anywhere else: the
JavaScript-style number formatting in there, exponent branch included, is part
of the commitment.

## Running

```bash
# through docker compose (service backend, image lottery-api)
docker compose up -d backend

# migrations
python migrations_runner.py

# tests
python3 -m pytest
```

How it connects: `webapp/ui` calls this API, and `workers/` write events into
the same database.
