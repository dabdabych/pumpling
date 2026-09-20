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

There is one signing role. The admin key opens the round, closes deposits,
pays ORAO for the randomness and starts the buying phase, all from the same
wallet. The separate oracle payer went away with Switchboard: the randomness is
now requested by the program itself, by CPI, inside the transaction that closes
the round.

One admin:

```env
LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON=[...64 bytes...]
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

The worker works out who owns each round from the address already on chain. For
full automation, the private key of every possible admin has to be configured
here, and its public key has to be listed in `LOTTERY_ADMIN_PUBKEYS`.

## The draw

`lottery_phase_worker` drives it, and the whole of it takes a few seconds.
Measured on devnet over three rounds: ORAO answers in 1–2s, the worker picks the
answer up in another 1–2s, so the round goes from closed to drawn in 2–4s. Under
Switchboard the same stretch took 67–69s.

```
start_second_phase   deposits close and the program asks ORAO, in one transaction
                     the seed is derived by the program from the round's address,
                     the weights commitment and the hash of a recent slot
fulfill_randomness   ORAO's 64 bytes are folded into the round's 32-byte seed
                     permissionless: anybody may push the round along
```

The worker derives the request seed too, in `webapp/backend/shared/orao_vrf.py`,
and only so it can name the request account in the transaction. The program
derives it again and refuses anything else, so a disagreement stops the round
rather than quietly using the worker's answer. Vectors pinned on both sides:
`cross_language_tests` in the program and `tests/test_orao_vrf.py` here.

**The emergency path.** If ORAO has not answered 120 seconds after the request,
the worker draws the round with a locally generated seed and the round is marked
`is_offchain_vrf`, which the verification page shows as
`randomness_source=emergency`. The program reads the request account and refuses
the moment randomness is there, so this cannot be used to dislike a result. The
constant lives in both the program and this worker and the two are checked
against each other by a test.

**The account is read by hand**, not through the IDL, in
`_parse_onchain_lottery_account`. That makes `LOTTERY_ACCOUNT_SIZE` load-bearing:
the pre-ORAO account was nine bytes longer and carried different fields at the
same offsets, and both shapes have the same Anchor discriminator. Change the
struct and change that constant in the same commit;
`tests/test_onchain_account_layout.py` checks it against the IDL.
