# Dashboard Scenarios — the off-chain buyer

Every scenario in the buying logic worth watching on a dashboard.
62 scenarios across 3 layers.

---

## The full catalogue

---

## Layer 1: buy() — a single purchase

### Venue routing (`buy.ts`)

| # | Scenario | Description |
|---|----------|----------|
| 1 | Pumpfun — direct purchase | bonding curve active, buyPumpfun OK |
| 2 | DEX — direct purchase | bonding curve NOT active, buyDex OK |
| 3 | Fallback pumpfun->DEX | pumpfun failed pre-send, switched to DEX |
| 4 | PostSendError — fallback blocked | pumpfun post-send error, tx is in the network, DEX fallback forbidden |

### Pumpfun (`pumpfun/buy.ts`)

| # | Scenario | Description |
|---|----------|----------|
| 5 | Graduation detected during build | isGraduated=true in fetchBondingCurveInfo, pre-send error |
| 6 | Simulation failed | simulateTransaction error before send (IDL mismatch, bad accounts) |
| 7 | Send failed / confirm timeout | sendRawTransaction or confirmTransaction failed, PostSendError |
| 8 | On-chain failure | tx confirmed but confirmation.value.err != null |
| 9 | Token-2022 vs classic Token | which token program was used |

### DEX / Jupiter (`dex/buy.ts`)

| # | Scenario | Description |
|---|----------|----------|
| 10 | Jupiter quote failed | HTTP error from /quote (400, 429, 500, 503) |
| 11 | Jupiter no route | no liquidity (routePlan.length === 0) |
| 12 | Jupiter swap build failed | HTTP error from /swap |
| 13 | Jupiter timeout | fetchWithTimeout AbortError (30s) |
| 14 | DEX on-chain failure | tx confirmed but failed on chain |

---

## Layer 2: batchBuy() — batched buying of one coin

### Main loop

| # | Scenario | Description |
|---|----------|----------|
| 15 | Bought on the first attempt | buy() OK in the main loop |
| 16 | Slippage error -> instant retry | isSlippageError, retried right there in the main loop |
| 17 | Instant retry — success | the second buy() in the main loop is OK |
| 18 | Instant retry — failure | both buy() calls in the main loop failed |
| 19 | Pending tx confirmed (instead of an error) | PostSendError, but getSignatureStatus -> confirmed |
| 20 | Non-retryable -> immediate abandon | classifyError -> non-retryable (insufficient funds and the like) |
| 21 | Retryable -> deferred to the retry phase | classifyError -> retryable |
| 22 | Unknown error -> deferred to the retry phase | classifyError -> unknown (logged as a warning) |

### Retry phase

| # | Scenario | Description |
|---|----------|----------|
| 23 | Pending signature confirmed before the retry | pendingSignature in state, getSignatureStatus -> confirmed |
| 24 | Retry — success | buy() OK in the retry loop |
| 25 | Retry — non-retryable -> abandon | an error during the retry that cannot be repeated |
| 26 | Retry — max attempts -> abandon | MAX_RETRIES exhausted |
| 27 | Retry window expired -> abandon | Date.now() > retryEnd |
| 28 | Pending tx confirmed in the retry catch | PostSendError during the retry, but the tx actually went through |

### Slippage escalation

| # | Scenario | Description |
|---|----------|----------|
| 29 | Slippage by level | which BPS on each attempt (300->500->1000->2000) |
| 30 | Max slippage hit | slippage = maxSlippageBps (the cap kicked in) |

### Error classification

| # | Scenario | Description |
|---|----------|----------|
| 31 | Errors by class | retryable / non-retryable / unknown — counters |
| 32 | Errors by pattern | the specific pattern (ECONNREFUSED, 429, insufficient funds, …) |

### Batch summary

| # | Scenario | Description |
|---|----------|----------|
| 33 | Success rate | completed / purchaseCount |
| 34 | Abandon rate | abandoned / purchaseCount |
| 35 | SOL spent vs allocated | totalSolSpent vs totalSolAmount |
| 36 | Batch duration | finishedAt - startedAt |
| 37 | Adaptive retry window | failedRate -> how many minutes of retry buffer |

---

## Layer 3: executeLottery() — the whole round

### Buy phase

| # | Scenario | Description |
|---|----------|----------|
| 38 | Coin buy completed | batchBuy() OK |
| 39 | Coin buy failed | batchBuy() threw |
| 40 | Coin skipped (budget=0) | adjustedSolAmount <= 0 |

### Send phase

| # | Scenario | Description |
|---|----------|----------|
| 41 | Send completed | batch transfer OK |
| 42 | Send carry-forward | balance=0 at the send round (buying still running), stays pending |
| 43 | Send retryable error -> pending | 429/timeout, reset to pending for the next round |
| 44 | Send non-retryable -> abandoned | insufficient funds and the like |
| 45 | Send max attempts -> abandoned | >= MAX_SEND_ATTEMPTS (3) |
| 46 | Send last round retry | retryable error in the last round, one extra retry |
| 47 | Send last round retry — success | the extra retry is OK |
| 48 | Send last round retry — failure | the extra retry failed, abandoned |

### ATA mismatch policy

| # | Scenario | Description |
|---|----------|----------|
| 49 | ATA mismatch (<0.5 SOL) | the ATA existed, disappeared, commit < 0.5 SOL, blocked |
| 50 | ATA forgiven (0.5-1 SOL) | the ATA existed, disappeared, commit 0.5-1 SOL, let through |
| 51 | ATA deferred (>=1 SOL) | the ATA disappeared, not the last round, postponed |
| 52 | ATA deferred -> sent (last round) | the postponed send lands in the final round |

### Compute budget / batch split

| # | Scenario | Description |
|---|----------|----------|
| 53 | Compute limit -> batch split | isComputeLimitError, split the batch 5->2+3 and so on |

### Sweep phase

| # | Scenario | Description |
|---|----------|----------|
| 54 | Sweep: abandoned reset -> pending | retryable abandoned sends reset to pending |
| 55 | Sweep: send completed | a pending send after the reset went through |
| 56 | Sweep: send failed | a pending send after the reset failed again |

### Financial / summary

| # | Scenario | Description |
|---|----------|----------|
| 57 | Send reserve | how much SOL is held back for send fees |
| 58 | Buy budget utilization | buyBudget vs what was actually spent |
| 59 | Token distribution accuracy | actual proportions vs target shares |
| 60 | Round success rate | tokensBought / tokens.length |
| 61 | Send success rate | sendsCompleted / sendsTotal |
| 62 | Round duration | finishedAt - startedAt |

---

## Priorities

### Priority 1: breakage and money at risk

Scenarios where something broke and money or tokens are at risk. First in line
for the dashboard.

**P1-CRIT — money loss / double-buy:**
#4, #8, #14, #19, #23, #28

**P1-HIGH — buying errors:**
#5, #6, #7, #10, #11, #12, #13

**P1-MED — retry/abandon (buying):**
#20, #25, #26, #27, #39, #40

**P1-MED — send failures:**
#44, #45, #48, #49, #53

**P1-LOW — infrastructure indicators:**
#31, #32

P1 total: 25 scenarios.

### Priority 2: normal behaviour and metrics

Business as usual. Needed for the overall picture and for tuning.

**P2-HIGH — the overall picture (blind without it):**
- #33 Batch success rate — the main health indicator for buying
- #34 Batch abandon rate — how many purchases were lost
- #60 Round success rate — how many of the N coins got bought
- #61 Send success rate — did the tokens reach the recipients
- #1, #2, #3 Venue routing — pumpfun vs DEX vs fallback, proportions

**P2-MED — retry/recovery behaviour (needed for tuning):**
- #16, #17, #18 Instant slippage retry — how often it fires, whether it helps
- #21, #22, #24 Retry phase flow — retryable/unknown and how they end
- #29, #30 Slippage escalation — which levels get used, whether the cap is hit
- #42, #43 Send carry-forward — how often buying is late for a send round
- #46, #47 Send last round retry — how often the extra retry is needed
- #54, #55, #56 Sweep phase — how many sends the sweep rescues

**P2-LOW — details and optimisation (nice to have):**
- #9 Token-2022 vs classic Token — informational
- #15 Bought on the first attempt — implied by the success rate
- #35 SOL spent vs allocated — over- or underspend
- #36, #37 Batch duration, adaptive retry window — timing tuning
- #38, #41 Coin buy/send completed — implied by the success rates
- #50, #51, #52 ATA forgiven/deferred — edge cases of the ATA policy
- #57, #58, #59 Send reserve, budget utilization, distribution accuracy — financial detail
- #62 Round duration — total time

P2 total: 37 scenarios (5 HIGH, 16 MED, 16 LOW).

---

## How this is implemented

### Context

- `buyer` — Node.js Express (port 3000), inside the docker network
- `backend` — Python (port 8000), calls `POST /execute`, polls `GET /execute/:lotteryId`
- `postgres` — already in the stack, used by the backend
- State files — `logs/lottery_*.json` and `logs/batch_*.json`, mounted as a volume
- 1-2 rounds at a time, each about 50 minutes

### Two independent data paths

```
buyer process
  │
  ├── stdout (pino JSON) ──→ Docker ──→ Loki ──→ Grafana (logs + dashboards + alerts)
  │
  └── state JSON file ──→ GET /execute/:id ──→ backend (business logic)
```

They do not cross. The backend never reads logs, Grafana never reads the state
file.

### A — counters in the state (for the backend)

A `metrics` object in `LotteryState` and `BatchState`, incremented as each
scenario is handled. The backend already polls `GET /execute/:lotteryId`, so it
gets the counters along with the state it needs for business logic (round
status, how much was bought, how much was sent).

- No new infrastructure, it piggybacks on an existing flow
- Metrics survive a restart (they are in the JSON file)
- Not for dashboards, for the backend

### B — structured logging + Loki + Grafana (for monitoring)

Replace `console.log` with pino (structured JSON). pino writes to stdout, the
same place console.log went, and the format changes from text to JSON. Docker
collects stdout as before. Loki attaches to Docker and reads that same stdout.

Grafana is the web interface for all of it:
- Reading logs with filters (by event type, mint, severity)
- Dashboards (built from Loki — counts by event type, graphs)
- Alerts (P1-CRIT → a notification)

A non-technical user opens Grafana and sees:
- "show me every error in the last hour"
- "how many DEX fallbacks were there today"
- an alert if PostSendError > 0

To add to docker-compose:
- `loki` — log collection and storage
- `grafana` — the web interface

### Who owns what

| What | Where | Who looks at it |
|-----|-----|-------------|
| Rounds, commits, results | the Angular UI | the user |
| Metrics, logs, dashboards | Grafana | ops / business |
| Alerts on breakage | Grafana alerting | ops / business |
| Round status for business logic | GET /execute → state JSON | the backend (Python) |

### On the buyer side

1. Add a `metrics` object to the `LotteryState` and `BatchState` types
2. Increment counters in the right places (batch.ts, buy.ts, sendRounds.ts, …)
3. Replace `console.log` with pino, in the same places the counters live
4. Every pino event carries: `event` (the scenario type), `level`
   (info/warn/error) and context (mint, signature, lotteryId, …)

Work for other people:
- **Infra:** add Loki + Grafana to docker-compose, configure the Docker log driver
- **Ops:** build the Grafana dashboards and alert rules

### Why not Prometheus

The buyer is not a high-load service with thousands of metrics per second. It is
a long-lived process with dozens of events an hour. Prometheus is pull based and
its counters reset on restart. State-based counters in JSON are more reliable
here, and Grafana + Loki covers both logs and dashboards from one source.

### Load estimate

Example: 1 round, 10 coins at 5 SOL = 50 SOL.

**Layer 2 — BatchBuy (per coin):**
- calculateN(5) = 20 purchases, a 50 minute window → one purchase every ~2.5 min
- Every purchase is at least 2 state writes (markInProgress + markCompleted/markFailed)
- Happy path: ~0.8 state writes/min per coin, ~1.2 with retries

**Layer 3 — orchestrator:**
- 10 coins in parallel → ~8 batch state writes/min in total
- Send rounds: one delivery round every 5 minutes

**Altogether:**

| What                             | Rate           |
|----------------------------------|----------------|
| Counter increment (buy event)    | ~8/min         |
| Counter increment (send event)   | ~2-10/min      |
| State file write (batch JSON)    | ~8/min         |
| State file write (round JSON)    | ~2-10/min      |
| pino log events (stdout)         | ~15-25/min     |
| **Total events**                 | **~15-25/min** |

**How fresh the data is:**
- Grafana (through Loki): real time, logs show up within seconds
- Backend (through polling): depends on the interval, typically 0-30 seconds behind

**Worst case (2 rounds × 100 coins × 50 SOL):**
- calculateN(50) = 100 purchases per coin → ~400 log events/min
- The bottleneck is not logging, it is RPC (Helius Developer at 50 RPS)

**Impact of Loki + Grafana on business logic:** none. The buyer writes to stdout
as before, the Docker daemon picks the logs up at its own level, Loki reads from
the Docker socket. The buyer, backend and postgres are untouched: separate
processes, separate memory, separate disk.

**Extra server resources:**

| Service | RAM          | CPU         | Disk                              |
|---------|--------------|-------------|-----------------------------------|
| Loki    | ~50-100 MB   | negligible  | ~1 MB/day at our volumes          |
| Grafana | ~100-150 MB  | negligible  | ~50 MB (configs, dashboards)      |
| **Total** | **~150-250 MB** | —       | —                                 |

**TODO:** check how much RAM the server running docker-compose actually has, to
be sure another 150-250 MB is not a problem.

**Conclusion:** the load is minimal, dozens of events a minute. Loki handles
that without noticing.

---

## Running and using the dashboards

### Prerequisites

Install the Loki Docker logging driver on the host:

```bash
docker plugin install grafana/loki-docker-driver:3.4.2 --alias loki --grant-all-permissions
```

Without that plugin `docker-compose up buyer` fails with "unknown log driver".
Loki and Grafana still start fine; the driver is only needed for the buyer.

### Starting

```bash
# buyer plus monitoring
docker-compose up -d loki grafana buyer

# or everything
docker-compose up -d
```

### Getting into Grafana

- URL: `http://localhost:3001`
- User: `admin`
- Password: from `GRAFANA_PASSWORD` in `.env` (`admin` by default)
- Loki is wired up automatically through provisioning (datasource "Loki")

### Reading logs

**Explore → pick the "Loki" datasource** — queries in LogQL:

```logql
# every buyer log line
{container_name="lottery-buyer"}

# errors only
{container_name="lottery-buyer"} | json | level="error"

# one particular round
{container_name="lottery-buyer"} | json | lotteryId="uuid-..."

# one coin inside a round
{container_name="lottery-buyer"} | json | mint="6tGwYs5E"

# every abandoned purchase
{container_name="lottery-buyer"} | json | event=~"purchase.abandoned.*"

# DEX fallbacks
{container_name="lottery-buyer"} | json | event="buy.fallback.pumpfun_to_dex"

# PostSendError (P1-CRIT — double-buy risk)
{container_name="lottery-buyer"} | json | event="pumpfun.send_failed"

# every retry
{container_name="lottery-buyer"} | json | event=~"purchase.retry.*"

# send errors
{container_name="lottery-buyer"} | json | event="send.batch_failed"
```

### Building dashboards

**Dashboards → New dashboard → Add visualization → pick Loki**

Panels worth having:

| Panel | Visualization | LogQL |
|--------|------------------|-------|
| Purchases/min | Time series | `rate({container_name="lottery-buyer"} \| json \| event="purchase.completed" [1m])` |
| Errors/min | Time series | `rate({container_name="lottery-buyer"} \| json \| level="error" [1m])` |
| Fallback count | Stat | `count_over_time({container_name="lottery-buyer"} \| json \| event="buy.fallback.pumpfun_to_dex" [1h])` |
| Venue breakdown | Pie chart | `sum by (venue) (count_over_time({container_name="lottery-buyer"} \| json \| event="purchase.completed" [24h]))` |
| Log feed (all) | Logs | `{container_name="lottery-buyer"} \| json` |
| Log feed (errors) | Logs | `{container_name="lottery-buyer"} \| json \| level=~"error\|warn"` |
| ATA mismatch count | Stat | `count_over_time({container_name="lottery-buyer"} \| json \| event="send.ata_mismatch_blocked" [24h])` |
| Retry success rate | Stat | `count_over_time(... \| event="purchase.retry_success" [1h]) / count_over_time(... \| event="purchase.retry_attempt" [1h])` |

### Alerts (Grafana Alerting)

**Alerting → Alert rules → New alert rule**

P1-CRIT alerts worth having:

| Alert | Condition | Meaning |
|-------|---------|----------|
| PostSendError | `count_over_time(... \| event="pumpfun.send_failed" [5m]) > 0` | tx is in the network, fallback blocked — double-buy risk |
| All buys failed | `count_over_time(... \| event="purchase.abandoned.*" [10m]) > 5` | purchases are failing en masse |
| Send failures | `count_over_time(... \| event="send.batch_failed" [10m]) > 3` | recipients are not getting their tokens |
| Zero balance stuck | `count_over_time(... \| event="send.carry_forward" [30m]) > 20` | buying is not working, sends are piling up |

### Every pino event

**Layer 1 — buy/pumpfun/dex/send:**

| Event | Level | File |
|-------|-------|------|
| `buy.fallback.pumpfun_to_dex` | warn | buy.ts |
| `pumpfun.build_info` | info | pumpfun/buy.ts |
| `pumpfun.graduation_detected` | warn | pumpfun/buy.ts |
| `pumpfun.simulation_failed` | error | pumpfun/buy.ts |
| `pumpfun.on_chain_failure` | error | pumpfun/buy.ts |
| `pumpfun.send_failed` | error | pumpfun/buy.ts |
| `dex.no_route` | warn | dex/buy.ts |
| `dex.timeout` | warn | dex/buy.ts |
| `dex.quote_failed` | error | dex/buy.ts |
| `dex.swap_build_failed` | error | dex/buy.ts |
| `dex.on_chain_failure` | error | dex/buy.ts |
| `dex.completed` | info | dex/buy.ts |
| `send.start` | info | send.ts |
| `send.completed` | info | send.ts |

**Layer 2 — batchBuy:**

| Event | Level | Meaning |
|-------|-------|----------|
| `batch.init` | info | batch started (N, fees, window) |
| `batch.retry_start` | info | the retry buffer started |
| `batch.complete` | info | batch results |
| `purchase.buying` | info | a purchase started |
| `purchase.completed` | info | purchase OK |
| `purchase.pending_confirmed` | info | a pending tx was confirmed |
| `purchase.slippage_retry` | warn | instant retry on slippage |
| `purchase.slippage_retry_failed` | warn | the instant retry did not help |
| `purchase.abandoned_non_retryable` | warn | abandoned (non-retryable error) |
| `purchase.abandoned_window_expired` | warn | abandoned (retry window expired) |
| `purchase.abandoned_max_attempts` | warn | abandoned (out of attempts) |
| `purchase.deferred_to_retry` | info/warn | deferred to the retry buffer |
| `purchase.retry_attempt` | info | a retry attempt |
| `purchase.retry_success` | info | retry OK |
| `purchase.retry_failed` | warn | the retry did not help |

**Layer 3 — orchestrator/sendRounds:**

| Event | Level | Meaning |
|-------|-------|----------|
| `lottery.start` | info | the round started |
| `lottery.prepared` | info | preparation done (budget, reserves) |
| `lottery.phase2_start` | info | parallel buy and send started |
| `lottery.token_buy_complete` | info | a coin was bought |
| `lottery.token_buy_failed` | error | buying a coin failed |
| `lottery.token_skipped_zero_budget` | warn | coin skipped (budget=0) |
| `lottery.sweep_start` | info | the sweep phase started |
| `lottery.complete` | info | round results |
| `send.round_start` | info | a delivery round started |
| `send.sweep_round` | info | a sweep round |
| `send.carry_forward` | debug | balance=0, sends carried forward |
| `send.batch_completed` | info | batch send OK |
| `send.batch_failed` | warn | batch send error |
| `send.compute_limit_split` | warn | compute limit, batch split |
| `send.ata_mismatch_blocked` | warn | the ATA disappeared, send blocked |
| `send.last_round_retry_success` | info | last-round retry OK |

**API:**

| Event | Level | Meaning |
|-------|-------|----------|
| `api.keeper_loaded` | info | the keeper was loaded |
| `api.listening` | info | the server is up |
| `api.shutdown_start` | info | graceful shutdown started |
| `api.shutdown_complete` | info | every round finished |
| `api.lottery_completed` | info | a round finished (fire and forget) |
| `api.lottery_failed` | error | a round failed |

### Alternative without the Docker logging driver

If installing the `grafana/loki-docker-driver` plugin is not possible, drop the
`logging:` section from the buyer in `docker-compose.yml` and add Promtail:

```yaml
promtail:
  image: grafana/promtail:3.4.2
  volumes:
    - /var/lib/docker/containers:/var/lib/docker/containers:ro
    - ./infra/promtail-config.yml:/etc/promtail/config.yml:ro
  command: -config.file=/etc/promtail/config.yml
  depends_on:
    - loki
```

Promtail reads logs from the Docker containers and pushes them to Loki. Same
result, but it needs an extra config file.

### Infrastructure files

```
docker-compose.yml                           # buyer logging → Loki, services loki + grafana
infra/
├── loki-config.yml                          # Loki config (filesystem storage, 7 day retention)
└── grafana/
    └── provisioning/
        └── datasources/
            └── loki.yml                     # wires Loki up as a datasource
```

### Ports

| Service | Port | Purpose |
|--------|------|----------|
| Grafana | 3001 | dashboards, logs, alerts |
| Loki | 3100 | the log API (not needed directly, only by Grafana) |
| Buyer | 3000 (expose) | the REST API (inside the docker network) |
