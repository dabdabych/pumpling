# CLAUDE.md — Workers

Python/asyncio background workers. Each runs as `python -m <module>` (see the
services in `docker-compose.yml`). They write to the same PostgreSQL as the
backend.

## The workers

| Module | Compose service | Role |
|--------|----------------|------|
| `events_worker` | events-worker | Listens to and processes on-chain round events |
| `backfill_worker` | backfill-worker | Catches up on events that were missed |
| `bet_finalizer_worker` | bet-finalizer-worker | Confirms commit transactions, marks orphaned ones |
| `lottery_phase_worker` | lottery-phase-worker | Drives round phases, starts the buyer after the draw |
| `telegram_error_handler` | — | Alert channel: sends worker errors to Telegram |

Support files: `events.py` (shared event logic) and `idl/lottery.json` (the
Anchor IDL, keep it in sync with `webapp/ui/src/app/idl/`).

## Running

```bash
# on its own
python -m lottery_phase_worker

# production — docker compose
docker compose up -d events-worker backfill-worker lottery-phase-worker
```

How it connects: `lottery_phase_worker` triggers the off-chain buyer
(`offchain/`) once the buying phase begins. Events are read from Solana, state
lives in the database shared with `webapp/backend`.

## Round signers

The round admin and the Switchboard payer are different roles. Do not pass
`SWITCHBOARD_SIGNER_KEYPAIR_JSON` as the admin signer.

One admin:

```env
LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON=[...64 bytes...]
SWITCHBOARD_SIGNER_KEYPAIR_JSON=[...64 bytes...]
```

Several admins on one deployment:

```env
LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON=[[...admin 1...],[...admin 2...]]
LOTTERY_ADMIN_PUBKEYS=AdminPubkey1,AdminPubkey2
```

On a server, mount the keys as read-only files instead:

```env
LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS=/run/secrets/admin-1.json,/run/secrets/admin-2.json
LOTTERY_ADMIN_PUBKEYS=AdminPubkey1,AdminPubkey2
```

By default every admin talks to the shared `VRF_SERVICE_BASE_URL`. If they have
separate Switchboard services, route by public key:

```env
LOTTERY_ADMIN_VRF_CONFIG_JSON={"AdminPubkey1":{"base_url":"http://vrf-admin-1:8787"},"AdminPubkey2":{"base_url":"http://vrf-admin-2:8787","api_key":"..."}}
```

The worker works out who owns each round from the address already on chain. For
full automation, the private key of every possible admin has to be configured
here, and its public key has to be listed in `LOTTERY_ADMIN_PUBKEYS`.
