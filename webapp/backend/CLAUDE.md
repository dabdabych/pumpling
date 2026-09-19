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
│                           #   weights_commitment, purchases_payload, …
├── migrations/             # SQL migrations (38), applied in order, never rewritten
├── migrations_runner.py    # runs the migrations
├── create_tables.py        # initialises the schema
├── mint_validator.py       # validates coin mint addresses before a commit
├── vrf-service/            # separate Switchboard VRF service (own Dockerfile, compose: vrf-service)
└── tests/
```

Layer dependencies run `presentation → application → domain`, with
`infrastructure` implementing the domain interfaces. A new feature goes through
all the layers; do not pile logic into a router.

## Routers (main.py)

`auth_router`, `lottery_router`, `events_router`, `rpc_router`, `chat_router`,
`chat_ws_router`. Health: `GET /ping`, `GET /`. Profile: `GET /profile`.

`rpc_router` is a narrow allowlist proxy to the Solana node: the browser never
gets the RPC key, and only the methods the site actually needs are permitted.

`GET /lottery/{id}/verification` is public and needs no auth. It returns
everything a round rests on: the weights commitment with the exact text that was
hashed, where the randomness came from, the algorithm fingerprint, and the
result. It is the endpoint the "Verify this pool" button on the site uses, so
its shape is a public contract.

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
