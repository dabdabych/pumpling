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
├── migrations/             # SQL migrations (041 the last), applied in order, never rewritten
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

## Coin pictures on IPFS

ipfs.io stopped serving files over HTTP on 2026-09-21, and most pump.fun
pictures point there, whether they come from pump.fun, Helius DAS or Helius's
image CDN. `shared/coin_images.py` rewrites any IPFS address (a `/ipfs/<cid>`
path, a `<cid>.ipfs.` subdomain, `ipfs://`, or Helius's CDN in front of one) to
pump.fun's Pinata gateway, by content id. The rewrite sits in the response
types (`ImageUrl` in `application/lottery/schemas.py`), so every answer that
carries a picture goes through it and what is stored stays what the sources
said. The share card fetches through each gateway in turn, Filebase second.

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
