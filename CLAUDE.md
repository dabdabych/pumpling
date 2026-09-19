# CLAUDE.md — repository context

Monorepo for **Pumpling**, a promotion platform on Solana. People commit SOL
behind a memecoin, verifiable randomness sets how the pool is split between the
coins, an off-chain buyer spends the pool on public on-chain purchases, and the
tokens reach the wallets that backed those coins.

```
1. Commit   — a wallet sends SOL to the vault behind a chosen mint (on-chain)
2. Draw     — VRF sets each coin's share of the pool
3. Buy      — the off-chain buyer purchases those coins (pump.fun / PumpSwap / Jupiter)
4. Deliver  — tokens go out to the wallets that backed each coin
```

What matters about the mechanic: the value is not the payout. A participant
buys a **public, irreversible promise to buy**. The commitment is visible to
everyone before the buying starts, and it lives on chain, so the market can act
on it.

This is not one service, it is the whole stack. Each component keeps its own
`CLAUDE.md`, picked up automatically when you work in that folder.

**On the word "lottery".** It is everywhere in this repository: paths, tables,
routes, the deployed program `lottery_v_1_0`. It is a leftover name from the
first prototype, pinned in place by the on-chain program and the production
database. The product is a promotion pool and that is the language of the site,
the docs and any new code. Do not spend a refactor on it without asking.

---

## Map

| Folder | Stack | Role | Details |
|---|---|---|---|
| `webapp/ui/` | Angular | The site: main page, pool page, personal history, archive, admin | → `webapp/ui/CLAUDE.md` |
| `webapp/backend/` | Python, FastAPI | API, auth, commits, mint validation, round state | → `webapp/backend/CLAUDE.md` |
| `webapp/backend/vrf-service/` | Node | Signs VRF requests with the service keypair | — |
| `workers/` | Python, asyncio | Round lifecycle and on-chain event processing | → `workers/CLAUDE.md` |
| `offchain/` | TypeScript | **The buyer**: batched purchases, delivery, refunds | → `offchain/CLAUDE.md` |
| `offchain/api/` | TypeScript | HTTP wrapper around the buyer | → `offchain/api/CLAUDE.md` |
| `infra/` | Loki, Grafana | Monitoring config, dashboards, alert rules | → `infra/CLAUDE.md` |
| `scripts/` | bash, python | Helpers: Loki seeding and plugin, algorithm hash | — |
| `DEVNET.md` | — | A full round on devnet: refunds, buyer recovery after a crash | — |

**workers/** (each runs as `python -m <module>`):

- `events_worker` — processes on-chain events
- `backfill_worker` — catches up on events that were missed
- `bet_finalizer_worker` — confirms commit transactions and marks orphaned ones
- `lottery_phase_worker` — drives round phases and starts the buyer after the draw
- `telegram_error_handler` — error alert channel

Flow: `Angular → FastAPI → workers → the buyer → Solana`, with `vrf-service`
signing VRF requests alongside.

---

## Running the stack

Everything runs through docker compose. Services: `postgres, backend, ui,
vrf-service, events-worker, backfill-worker, bet-finalizer-worker,
lottery-phase-worker, buyer, loki, grafana, certbot-renew`.

```bash
./deploy.sh                       # the whole stack
./deploy.sh .env.dev              # the same stack with a different set of secrets

docker compose up -d postgres backend ui   # locally you usually want a part of it
docker compose up -d loki grafana          # monitoring on :3001
```

**Watch out:** `docker-compose.yml` needs `SWITCHBOARD_SIGNER_KEYPAIR_JSON` for
`vrf-service` and validates the file as a whole, even when you only bring up a
few services. Keep it in `.env` (`dummy` is fine locally). The buyer needs
`KEEPER_SECRET_KEY`.

How to run a single component and its tests is in that component's `CLAUDE.md`.

---

## The one file you must not edit

`webapp/backend/application/lottery/vrf_engine.py` turns the VRF seed into
per-coin shares. Its sha256 over the **whole file, comments included**, is
written into every round on chain as `vrf_algorithm_hash`, and the site offers
that hash to anyone who wants to check the draw.

So editing a comment in that file moves the commitment exactly as much as
editing the formula does: rounds created after the edit carry the new value,
rounds created before it keep the old one. Edit it only when you mean to, and
never leave the declared value behind.

Nothing writes that value by hand. `scripts/vrf_algorithm_hash.py` derives it
from the source, `--check` exits non-zero when what is committed has drifted,
`--write` updates all five places that carry it.
`webapp/backend/tests/test_vrf_engine.py` fails the run if they disagree, so a
stale commitment cannot reach mainnet.

---

## Decisions worth knowing

**Why TypeScript for the buyer and Python everywhere else.** The Solana
ecosystem is TypeScript first: official SDKs, more examples, better docs. The
Python SDKs are community maintained and lag. The backend and workers barely
touch Solana, so they stay on Python.

**Why the keeper is a plain wallet and not a PDA.** Simpler, and there is no
compute limit to fight. The trade-off is that the keeper is trusted for the
hour it holds the pool, which is why every purchase it makes is public and the
round publishes what it spent.

**Why the buyer does not make one big purchase.** It spends the pool in small
batches at irregular intervals. The draw result is published immediately, that
is the point of the product, but the size and timing of each purchase stay
unpredictable, so the buys cannot be front-run.

---

## Links

- pump.fun IDL: https://github.com/s6nqou/pump-anchor
- Jupiter API: https://station.jup.ag/docs/apis/swap-api
- Jito SDK: https://github.com/jito-labs/jito-ts
- Solana Web3.js: https://solana-labs.github.io/solana-web3.js/
- Anchor: https://www.anchor-lang.com/docs
