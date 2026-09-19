# Hybrid end-to-end test — the plan for run #9

**Prepared:** 2026-04-19
**Goal:** a real buying run over a hybrid set of tokens (pump.fun + DEX) through the buyer's API inside the docker network, capturing the full logs for the Grafana dashboards.

---

## What the test is for

1. **Cover both venues in one round** — pumpfun (bonding curve) + DEX (Jupiter → PumpSwap/Raydium).
2. **End to end through the API** — the buyer comes up in `docker compose`, we call `POST /execute`, and the logs go through the Loki driver into Grafana. This is the only mode where the dashboards fill with real data.
3. **60 recipients** — the limit on the Helius free tier (10 RPS). It tests the send burst and batch transfers (up to 5 recipients/tx).
4. **Save the logs to a file** — after the run we take `docker logs` as JSONL. The dashboards can then be iterated on without buying again: a replay script pushes the same records into Loki.

---

## Parameters

| Parameter | Value |
|----------|----------|
| totalSol | **0.3 SOL** |
| recipients | **60** (60 wallets) |
| OVERRIDE_N | 10 (purchases per token) |
| OVERRIDE_SEND_N | 1 (every send in the last round — the burst test) |
| BUY_WINDOW_MINUTES | 5 |
| sendConcurrency | 20 (default) |

Budget:
```
totalSol      = 0.3 SOL
ATA reserves  ≈ 240 ATA × 0.00204 = 0.49 SOL ← far too much
```

**Correction:** at 4 tokens × 60 recipients = 240 ATAs this does not fit into 0.3 SOL. The options are:
- Keep 4 tokens → raise totalSol to 0.6 SOL
- Cut to **2 tokens (1 pumpfun + 1 DEX)** at 60 recipients — 120 ATA × 0.00204 = 0.245 SOL, buyBudget ≈ 0.05 SOL (~0.025 per token, 10 purchases of ~0.0025)

**Recommendation: 2 tokens, 60 recipients, totalSol = 0.3 SOL.**
For all 4 venue combinations, totalSol = 0.6 SOL.

---

## Proposed mint addresses — for review

We pick **one from each category**, so the dashboards show venue routing:

### Option A — the minimum (2 tokens, 0.3 SOL)

| # | Mint | Type | Expected venue |
|---|------|-----|-----------------|
| 1 | `2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump` | Token-2022, bonding curve, live | **pumpfun** |
| 2 | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | BONK, regular token program | **dex** (Raydium/Orca) |

### Option B — full coverage (4 tokens, 0.6 SOL)

| # | Mint | Type | Expected venue |
|---|------|-----|-----------------|
| 1 | `2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump` | Token-2022, bonding curve, live | pumpfun |
| 2 | `8PaK9mufsAyiGCpFN6Z6pyXs1ZzdC8tWcLV5Qmokpump` | Token-2022, bonding curve, live | pumpfun |
| 3 | `Dz4bX3snTDxqdKyZwdUgKoDvSjyvmoA23E6j5odZpump` | Token-2022, graduated | dex → PumpSwap |
| 4 | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | BONK, regular Token | dex → Raydium/Orca |

> **Check before running:** that the mints are alive. The lists can go stale — tokens die or graduate. Check:
> - pumpfun bonding curve: `solana account <mint> --url mainnet` + `curl pump.fun/api/trades/<mint>`
> - graduated: no active bonding curve (complete=true), a pool on PumpSwap
> - BONK is stable and always alive

**Replace the mints before freezing the list if you need to.** After that, follow the steps.

---

## Pre-flight checklist

- [ ] `.env` filled in: `KEEPER_SECRET_KEY`, `API_KEY`, `RPC_MAINNET` (the Helius free tier is fine), `SWITCHBOARD_SIGNER_KEYPAIR_JSON` (dummy is fine for a buyer-only run)
- [ ] The keeper holds ≥ 0.4 SOL (option A) or ≥ 0.7 SOL (option B), with headroom for fees
- [ ] The Loki docker driver is installed: `docker plugin ls | grep loki` (if not → `docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`)
- [ ] The buyer image is built: `docker compose build buyer`
- [ ] The monitoring stack is up: `docker compose up -d loki grafana`
- [ ] Grafana is reachable: http://localhost:3000 (admin/admin), with the "Buyer / Metrics & Operations" dashboard open
- [ ] The wallet limit in `generate_lottery_input.ts:39` has been raised **temporarily** from 40 to 60:
  ```ts
  if (!Number.isFinite(useCount) || useCount < 1 || useCount > 60) {
  ```
- [ ] `ports: ["3000:3000"]` has been added to `buyer` in `docker-compose.yml` (temporarily, to call the API from the host) — or use `docker exec` (below)

---

## The procedure

### 1. Generate 60 wallets

```bash
TS=$(date +%s)
npx ts-node offchain/tests/end-to-end/generate_wallets.ts 60 offchain/wallets_${TS}.json
```

### 2. Build the lottery input

**Option A (2 tokens):**
```bash
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets_${TS}.json 0.3 \
  "2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" \
  60 offchain/test_lottery.json
```

**Option B (4 tokens):**
```bash
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets_${TS}.json 0.6 \
  "2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump,8PaK9mufsAyiGCpFN6Z6pyXs1ZzdC8tWcLV5Qmokpump,Dz4bX3snTDxqdKyZwdUgKoDvSjyvmoA23E6j5odZpump,DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" \
  60 offchain/test_lottery.json
```

Check `offchain/test_lottery.json`: `lotteryId`, `tokens[].totalSol`, the distributions.

### 3. Bring the buyer up through the API (NOT through run_lottery.ts)

The buyer in docker reads `.env` and listens on `:3000`. But it uses the formulas from `scheduler/fees.ts`, so `OVERRIDE_N`/`OVERRIDE_SEND_N` are passed into the container as env vars.

Pass the overrides through `.env` or through an override compose file:

```yaml
# docker-compose.override.yml (temporary, for the test)
services:
  buyer:
    environment:
      - OVERRIDE_N=10
      - OVERRIDE_SEND_N=1
      - BUY_WINDOW_MINUTES=5
    ports:
      - "3000:3000"
```

Start:
```bash
docker compose up -d buyer
docker compose logs -f buyer | head -20   # check for "api.listening" in the logs
curl -s http://localhost:3000/health      # should be 200 OK
```

### 4. Trigger POST /execute

Take the payload from `test_lottery.json` (it is already in the right shape — see `orchestrator/types.ts`):

```bash
# Get the lotteryId for polling the status afterwards
LOTTERY_ID=$(jq -r .lotteryId offchain/test_lottery.json)
echo "Lottery: $LOTTERY_ID"

curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${API_KEY}" \
  -d @offchain/test_lottery.json \
  -w "\nHTTP %{http_code}\n"
```

Expected response: `202 Accepted`, `{ "lotteryId": "...", "status": "started" }`.

### 5. Monitoring

**Grafana** (http://localhost:3000) — the dashboard in real time:
- Purchases rate (by venue)
- Retry / abandoned
- Send rounds
- Errors & Alerts

**Polling the API:**
```bash
watch -n 10 "curl -s -H 'X-API-Key: \${API_KEY}' http://localhost:3000/execute/$LOTTERY_ID | jq '.summary'"
```

**Tailing the state file:**
```bash
tail -f logs/lottery_${LOTTERY_ID}.json | jq
```

Expected duration: **~5 min of buying + ~50 min of the send loop (SEND_INTERVAL=5 min)**. If `SEND_INTERVAL` is already tied to `buyWindowMinutes` after the fix from #7, it will be faster.

---

## Capturing the logs (critical)

**Goal:** one file with every JSON record from the buyer, suitable for replaying into Loki without buying again.

### During the run

Start this in parallel:
```bash
mkdir -p logs/hybrid-runs
docker logs -f --timestamps lottery-buyer \
  > logs/hybrid-runs/hybrid_${LOTTERY_ID}.log 2>&1 &
echo $! > logs/hybrid-runs/hybrid_${LOTTERY_ID}.pid
```

### After it finishes

```bash
kill $(cat logs/hybrid-runs/hybrid_${LOTTERY_ID}.pid)

# Collect every artefact
cp logs/lottery_${LOTTERY_ID}.json logs/hybrid-runs/
cp logs/batch_*${LOTTERY_ID}*.json logs/hybrid-runs/ 2>/dev/null
cp offchain/test_lottery.json logs/hybrid-runs/input_${LOTTERY_ID}.json
cp offchain/wallets_${TS}.json logs/hybrid-runs/wallets_${LOTTERY_ID}.json
```

**Loki also keeps the logs in the `loki_data` volume** — as long as you do not `docker volume rm solana-buyer_loki_data`, the data survives a restart. That is the safety net.

---

## Replaying into Loki (for iterating on dashboards)

If a dashboard needs changing and the LogQL rerunning on the same data, there are two ways:

**Way 1 (easy).** Do not delete the Loki volume: the data is already there, just change the `Time range` in Grafana to the interval of the run.

**Way 2 (if the volume was recreated, or a colleague got the file).** A replay script modelled on `scripts/seed-loki.py` but reading JSONL:

```python
# scripts/replay-loki.py (create when needed)
# Reads logs/hybrid-runs/hybrid_<id>.log,
# pulls the JSON out of each line after the timestamp,
# pushes it to Loki /loki/api/v1/push keeping event/level,
# timestamps either original (for analysis) or shifted to now (for a "live" look).
```

The shape of `docker logs --timestamps` lines:
```
2026-04-19T12:34:56.789Z {"level":30,"event":"purchase.completed","mint":"...","venue":"pumpfun",...}
```

Parse by splitting on the first space; the second part is the pino record. Label: `{container_name="lottery-buyer"}` (as in seed-loki.py). If shifting timestamps, add `(now - run_start)` to each one so the data lands in "last 15 min".

> **TODO:** write `scripts/replay-loki.py` at the first real dashboard iteration. There is a draft in `scripts/seed-loki.py` — repeat the structure and swap generation for reading a file.

---

## What we check

| Scenario | Where it shows |
|----------|-----------|
| Venue routing: pumpfun + dex in one run | Grafana "Purchases by venue", state file `purchases[].venue` |
| Token vs Token-2022 detection (BONK vs pump tokens) | No `send.ata_mismatch_blocked`, every send completed |
| Batch transfers (up to 5 recipients/tx) | `send.batch_completed` with `recipients: 5` |
| A send burst on the free tier (20 batch txs in parallel) | 0 × `purchase.*_retry` caused by 429, `send.batch_completed` count = 24 (120 recipients / 5) |
| Deficit-based distribution | The amounts per recipient are proportional to what they committed |
| All 60 got their tokens | The state file, balances through `spl-token accounts` |
| The Grafana dashboards are filled | Every panel has data > 0 |

---

## Cleanup

```bash
# Return the SOL from the recipients to the keeper
cd offchain && npx ts-node tests/end-to-end/cleanup_wallets.ts \
  wallets_${TS}.json <KEEPER_PUBKEY> <KEEPER_PUBKEY>

# Roll back the temporary edits
git checkout offchain/tests/end-to-end/generate_lottery_input.ts
rm docker-compose.override.yml
docker compose stop buyer
```

---

## Run #1 — 2026-05-09

### Parameters (differences from the plan above)

- 40 wallets (without raising the limit to 60)
- No override env (`OVERRIDE_N`, `OVERRIDE_SEND_N`, `BUY_WINDOW_MINUTES` were removed from the code — the window is the real 50 minutes)
- 2 mints: 1 pumpfun (`A4r8QAgi…pump`) + 1 DEX/Doodles (`DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV` = DOOD)
- `totalSol = 0.3 SOL`

### Summary

| Field | Value |
|---|---|
| Lottery ID | `test_1778318666578` |
| Start → finish | 10:44 UTC → 11:34 UTC (~50 min) |
| Buys | 4/4 completed (0 native pumpfun, 4 through the DEX, **2 of them a fallback from pumpfun**) |
| Sends (per the `lottery.complete` log) | 15/17 (see Bug #1 below — 17/17 actually delivered) |
| 429 errors | 0 |
| Abandoned | 0 |
| Total SOL spent | ~0.28 SOL (per the batch summary: 0.155 + 0.126) |
| Log file | `logs/hybrid-runs/hybrid_test_1778318666578.log` |
| State files | `logs/lottery_test_1778318666578.json`, 2× `logs/batch_2026-05-09T10-44-36_*.json` |

### Dashboards

Loki ingestion works (51 records for this run). Nothing is empty except the error and edge-case panels, which is normal for a happy path.

**One piece of awkwardness in the defaults, though:** the Errors & Alerts time range was `now-1h` with `[1h]` queries, which no longer covers a 50 minute round half an hour after it finishes. Raised to 6h (see the fix below). Metrics & Operations was already 24h and was left alone.

### Bugs found and fixed

#### Bug #1 — `pending` sends at deficit=0 (NOT lost money, wrong accounting)

**Symptom:** `lottery.complete sendsCompleted=15/17`, while on chain all 8 recipients got their tokens **exactly by share**. send_7 and send_11 (round 10) stayed `status: "pending", attempts: 0`.

**Root cause:** at `deficit ≤ 0` `calculateDeficitAmounts` leaves the send out of the `amounts` map → the batch transfer is never called → the state stays pending. In round 10 the deficit is 0 because the recipient already got their target in earlier rounds.

**Fix A (applied):**
- A new `SendStatus = "satisfied"` (`offchain/orchestrator/types.ts`)
- A new `sendsSatisfied: number` field in `LotterySummary`
- In `executeSendRounds`, after `calculateDeficitAmounts`, pending sends with deficit=0 → `status: "satisfied"`, metric `send.satisfied`
- `lottery.complete` now logs `sendsDelivered = sendsCompleted + sendsSatisfied` plus a fuller message

#### Bug #2 — 100% pumpfun fallback (`Custom 6062`)

**Symptom:** both pumpfun purchases → `pumpfun.simulation_failed err={"InstructionError":[1,{"Custom":6062}]}` → `buy.fallback.pumpfun_to_dex` → bought through the Jupiter DEX. Native pumpfun: 0 successes.

**Root cause (the right one, after run #2):** pump.fun shipped a breaking upgrade on 2026-04-28 — the legacy `buy` ix now requires **18 accounts** (not 16, not 17). The 17th is `bondingCurveV2` (PDA `["bonding-curve-v2", mint]`), the 18th is `buybackFeeRecipient`, which is **mutable** and one of 8 fixed addresses. Sources: https://github.com/pump-fun/pump-public-docs/blob/main/docs/BREAKING_FEE_RECIPIENT.md, https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json.

**Fix B (the first attempt — WRONG, rolled back in run #2):** we removed `bondingCurveV2`. Run #2 showed it was still `Custom 6062`. The "16 accounts" hypothesis was false.

**Fix B (the right one, applied after run #2):**
- `offchain/pumpfun/idl.ts`: two accounts added — `bondingCurveV2` (mut=false, 17th) + `buybackFeeRecipient` (**mut=true**, 18th)
- `offchain/solana/config.ts`: `getBondingCurveV2Address()` restored; `PUMP_BUYBACK_FEE_RECIPIENTS` (8 PublicKeys) added along with `pickBuybackFeeRecipient()` (a random pick spreads the load evenly)
- `offchain/pumpfun/buy.ts`: the imports plus both fields in `.accountsStrict({...})`
- A bonus: a new `offchain/pumpfun/errors.ts` with `PUMP_ERROR_NAMES` (6000-6024 + 6061-6063) and `extractPumpErrorName()`. `pumpfun.simulation_failed` now logs `errorCode` and `errorName` (readable instead of raw JSON). The thrown message carries a `(BuybackFeeRecipientMissing)` suffix.

**Verification (integration test, 2026-05-12):**
```bash
TEST_MINT_PUMPFUN=A4r8QAgi2TD2z8qbDUHmNPJHcVUbkbnRkRTDhAEppump \
  npm run test:integration -- --testPathPattern="buy.test" \
  --testNamePattern="should buy token on pump.fun"
```
→ `venue: pumpfun`, signature `354zUj9WYL2jacJ4...`, duration 3.5s. PASS. Not verified in the orchestrator context — that is the plan for run #3.

#### A note on the input generator

`generate_lottery_input.ts` assigns `1 + Math.floor(Math.random() * 4)` recipients per mint (1-4), so with 2 mints it uses only 8 of 40 wallets. Getting ~40 recipients for burst testing means changing the generator (an even spread). Accepted deliberately here: 8 recipients are enough for a smoke check of venue routing and the dashboards.

### Dashboards: provisioning changes

| File | What |
|---|---|
| `infra/grafana/provisioning/dashboards/errors-and-alerts.json` | `time.from "now-1h" → "now-6h"`; 22 queries `[1h] → [6h]`. Applied with `docker restart lottery-grafana`. |

### Open TODOs for the next run

1. Rerun with the fixes applied and verify:
   - native pumpfun successes > 0 (no fallbacks)
   - state file: `sendsCompleted + sendsSatisfied = sendsTotal`
   - the dashboard's `lottery.complete sendsDelivered=N/M` agrees (the new field)
2. Decide on the generator — keep 1-4 per mint or add a `RECIPIENTS_PER_MINT` env for burst scenarios.
3. Pin a Helius RPC instead of the public mainnet-beta (a `bigint` warning was seen in stderr — not blocking, but it clogs Loki with `JSONParserErr`).

### Cleanup commands for this run

```bash
LOTTERY_ID=test_1778318666578
WALLETS=offchain/wallets_1778318643.json
KEEPER=CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq

kill $(cat logs/hybrid-runs/hybrid_${LOTTERY_ID}.pid) 2>/dev/null
cp logs/lottery_${LOTTERY_ID}.json logs/hybrid-runs/
cp logs/batch_*.json logs/hybrid-runs/ 2>/dev/null
cp offchain/test_lottery.json logs/hybrid-runs/input_${LOTTERY_ID}.json
cp $WALLETS logs/hybrid-runs/

cd offchain && npx ts-node tests/end-to-end/cleanup_wallets.ts \
  ../$WALLETS $KEEPER $KEEPER
```

---

## Run #3 — the plan (verifying Bug #1 + Bug #2, 2026-05-13)

### Goal

Confirm in an orchestrator scenario (not just a single-buy integration test) that:
1. **The Bug #2 fix** — every pumpfun purchase goes native through the 18-account ix, with 0 DEX fallbacks.
2. **The Bug #1 fix** — `sendsCompleted + sendsSatisfied = sendsTotal`, and the new `sendsDelivered` field in `lottery.complete` agrees with the chain.

### Configuration (the same as run #2)

| Parameter | Value |
|---|---|
| totalSol | 0.3 SOL |
| keeper | `CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq` (balance ≥0.4 SOL) |
| mints | pumpfun: `A4r8QAgi2TD2z8qbDUHmNPJHcVUbkbnRkRTDhAEppump` (bonding curve active 2026-05-12) + DEX: `DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV` (DOOD/Doodles) |
| recipients | 40 wallets, **no** OVERRIDE — the generator hands out 1-4/mint (~8 unique wallets get tokens) |
| buyConcurrency | default (100) |
| window | 50 min (buying) + 10 min (retries) |

### Preconditions (at the start)

- [ ] Keeper balance ≥0.4 SOL: `curl -X POST -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["<keeper>"]}' $RPC`
- [ ] The Bug #1 and #2 fixes are in the code (commits `5e9c4de`, `8e196cd` on `feature/monitoring`)
- [ ] Mint `A4r8QAgi...` is still non-graduated (`complete=false` in the BondingCurve PDA) — check through `getAccountInfo` on the PDA `["bonding-curve", mint]`
- [ ] The docker daemon is running
- [ ] The buyer image was built after the Bug #2 fix: `docker compose build buyer`
- [ ] The monitoring stack: `docker compose up -d loki grafana buyer`
- [ ] Grafana is reachable: http://localhost:3001 (admin / `$GRAFANA_PASSWORD`)

### Commands (in order)

```bash
KEEPER=CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq
MINTS="A4r8QAgi2TD2z8qbDUHmNPJHcVUbkbnRkRTDhAEppump,DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV"
TS=$(date +%s)
WALLETS=offchain/wallets_run3_${TS}.json
INPUT=offchain/test_lottery_run3.json

# 1. Generate 40 wallets
npx ts-node offchain/tests/end-to-end/generate_wallets.ts 40 $WALLETS

# 2. Generate the lottery input (no OVERRIDE — the generator decides recipients per mint)
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  $WALLETS 0.3 "$MINTS" 40 $INPUT

# 3. (Optional) bring the buyer stack up if it is not already
docker compose up -d --build buyer
docker compose up -d loki grafana

# 4. Trigger through the API (if the buyer runs in docker)
#    Without docker, fall back to run_lottery.ts (logs go to a file only, not to Loki)
LOTTERY_ID="test_run3_${TS}"
curl -sS -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $BUYER_API_KEY" \
  -d @$INPUT

# 5. The run takes ~50-60 min. In parallel, open Grafana and watch it live.

# 6. Cleanup afterwards
npx ts-node offchain/tests/end-to-end/cleanup_wallets.ts \
  $WALLETS $KEEPER $KEEPER
```

### What to check AFTER the run

| Criterion | Where to look | PASS if |
|---|---|---|
| **Native pumpfun > 0** | `state file purchases[].venue` or Grafana "Purchases by venue" | `venue=pumpfun` count > 0 |
| **Pumpfun fallback = 0** | the `buy.fallback.pumpfun_to_dex` log count | 0 for the whole run |
| **Send accounting** | the `lottery.complete` log: `sendsDelivered=N/M` | `N == M` (or completed+satisfied = total) |
| **Satisfied > 0 on early buying** | `state file: sends[].status="satisfied"` | at least 1 present (if deficit=0 ever happened) |
| **Dashboards** | Grafana panels with data | every main panel is filled |
| **0 error 6062s** | `pumpfun.simulation_failed` with `errorName="BuybackFeeRecipientMissing"` | 0 in the log |

### Open TODOs for run #3

1. If `pumpfun.simulation_failed` > 0 but not 6062, it is a different error: dig in by `errorName`.
2. If recipients < 8, the generator spread them badly (random). Not blocking.
3. Write a "Results #3" section in hybrid-e2e-plan.md with the real numbers.

### Cleanup commands (post-run)

```bash
WALLETS=offchain/wallets_run3_*.json
# FUND_LAMPORTS=0.01 is already in the script (cleanup_wallets.ts:40, fixed after runs #1/#2)
npx ts-node offchain/tests/end-to-end/cleanup_wallets.ts $WALLETS $KEEPER $KEEPER
```

