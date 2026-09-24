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

## Two RPC calls that do not go through solana-py

`getSignaturesForAddress` and `getTransaction` are read as plain JSON, through
`shared/solana_rpc.py`, not through `AsyncClient`. Both workers walk over other
people's failed transactions, and a failed transaction carries whatever error
the validator felt like emitting.

`solders` decodes that error into a typed enum, and the RPC response is an
**untagged** enum, so a variant it does not know does not arrive as a null
field: the whole response fails to parse. One row poisons the other ninety-nine.

That is not theoretical. From 2026-07-28 to 2026-09-24 the backfill worker
processed nothing. A transaction that failed with
`err: {"InstructionError": [1, "BorshIoError"]}` sat in the program's history;
Solana v3 made `BorshIoError` a bare variant and `solders` 0.14.4 still expects
the string it used to hold. The worker needed rows 0 to 46 of a page and the
unreadable row was number 52, so it never read any of them. It logged
`data did not match any variant of untagged enum Resp` once a minute, which
reads like a network problem, and the cursor sat still for two months.

So: take the fields we use (`signature`, `err`, `meta.logMessages`), leave the
rest as the node sent it. `_extract_transaction_error` and
`_extract_transaction_log_messages` in `events_worker` already accept raw dicts
in the wire's camelCase, which is why this needed no new parsing.

Two consequences worth knowing. A JSON-RPC error now arrives as
`SolanaRpcError` with the node's own code, so an exhausted plan (-32429) is no
longer indistinguishable from a parse failure. And because the listing already
carries `err`, a failed transaction is skipped without fetching it, which is a
round trip saved per failed row on a rate-limited plan.

The proper fix is `solana-py` 0.40 + `anchorpy` 0.21 + `solders` 0.28, where the
typed path understands v3. That is a real migration across all five services and
it has not been done. Until it is, do not route these two calls back through
`AsyncClient`.
