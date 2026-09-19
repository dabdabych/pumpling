# CLAUDE.md — API module

## Overview

A REST wrapper around `executeLottery()`. An Express server with three
endpoints.

## Endpoints

### POST /execute
- Takes JSON with base58 strings and converts them to `PublicKey`
- Fire and forget: returns `202 Accepted`, `executeLottery()` runs in the background
- `409 Conflict` if that lotteryId is already running or its state file exists

### GET /execute/:lotteryId
- Reads the state JSON through `OrchestratorStateManager.load()`
- `404` if the round is unknown
- `{ status: "initializing" }` if it is running but the state file does not exist yet

### GET /health
- RPC connectivity (getSlot) plus the keeper balance in SOL, 5 second timeout
- `503` if the RPC is unreachable or times out
- Public (no `X-API-Key`), for the docker healthcheck

## Files

- `server.ts` — the Express app, keeper loading, graceful shutdown
- `routes.ts` — POST/GET handlers, in-memory tracking of running rounds
- `validation.ts` — validation and base58 → PublicKey conversion

## Decisions

### Which HTTP framework?
**Express.** The most common one, with the most documentation. Fastify and Hono
were considered.

### What does this API actually do?
It does not "start a round". It **starts the buying and delivery** once a round
has closed. The Python backend calls this endpoint at that moment and we run
`executeLottery()` (Layer 3), which buys the coins and delivers the tokens.

### Is a status GET needed?
**Yes.** `executeLottery()` runs for about 50 minutes and the webapp polls
progress through `GET /execute/:lotteryId`. It returns the whole `LotteryState`
from the state file.

### Input format?
**JSON with base58 strings.** The API converts them to `PublicKey`. The contract
is agreed with the backend side (below).

### Authentication?
**An `X-API-Key` header with a static secret from env.** The service lives
inside the docker network and is not exposed, but the key is there in case it
gets deployed somewhere with the network left open. If `API_KEY` is unset, every
request is rejected with `401`.

### Graceful shutdown
`createRouter()` returns `{ router, waitForRunning }`. On SIGTERM/SIGINT the
server stops accepting requests and waits for every active round to finish
(`Promise.allSettled`) before exiting. `docker-compose.yml` sets
`stop_grace_period: 60m`, otherwise Docker would kill the process after the
default 10 seconds.

### Keeper keypair?
**From `.env` at startup.** Loaded once and used for every request, never passed
in the request itself.

## Deployment

### Dockerfile
A two stage build (`offchain/Dockerfile`):
- **builder**: `npm ci` → `tsc` → `dist/`
- **runner**: `npm ci --omit=dev` + `dist/` → `node dist/api/server.js`

`.env` is not baked into the image, it comes through `env_file` in
`docker-compose.yml`.

### docker-compose.yml
The `buyer` service, with `stop_grace_period: 60m` for the graceful shutdown.
Logs are mounted as a volume (`./logs:/app/logs`) so state files survive a
container restart.

### Environment
All from `.env` / `env_file`. Required: `KEEPER_SECRET_KEY`, `API_KEY`,
`RPC_MAINNET`.

## Done since

- **Crash recovery** — `orchestrator/resume.ts`. On startup the buyer picks up
  rounds whose state file has no finish time and continues them. This used to be
  the open TODO here: a crash left the state file unfinished and `POST /execute`
  answered `409` forever.

## The JSON contract with the backend

`POST /execute` accepts:

```json
{
  "lotteryId": "uuid-...",
  "tokens": [
    {
      "mint": "base58...",
      "totalSol": 1.5,
      "recipients": [
        { "publickey": "base58...", "amount": 10 }
      ]
    }
  ]
}
```

- `lotteryId` — a UUID
- `totalSol` — SOL (not lamports) to spend buying that coin
- `amount` in recipients — what that wallet committed in SOL, used for proportions
- Every amount is in SOL as a decimal, **not lamports**
- No mint pre-validation needed, mints are checked before this call
- The backend polls status through `GET /execute/:lotteryId`
- At most 2 rounds run in parallel by definition, so no rate limiting
