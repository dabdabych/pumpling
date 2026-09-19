# End-to-end runs — the log

The history of `executeLottery()` runs. Reference material, not context. How to
run them is in `CLAUDE.md`, along with the test mints.

## Run #2: 0.01 SOL, 5 purchases

**Date:** 2026-03-12

### Parameters

| Parameter | Value |
|----------|----------|
| totalSol | 0.01 SOL |
| mint | `EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump` |
| recipients | 1 (from wallets.json) |
| OVERRIDE_N | 5 (purchases) |
| OVERRIDE_SEND_N | 5 (send rounds) |
| buying window | 50 min (default) |

### Budget

```
totalSol           = 0.01 SOL
sendReserve        ≈ 0.002 SOL (the recipient's ATA) + tx fees
buyBudget          ≈ 0.008 SOL
per buy (N=5)      ≈ 0.0016 SOL
```

### Commands

```bash
# Step 1: the wallets already exist (wallets.json from run #1)

# Step 2: build the input data
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets.json 0.01 "EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump" 1 offchain/test_lottery.json

# Step 3: run the round (5 purchases, 5 send rounds)
cd offchain && OVERRIDE_N=5 OVERRIDE_SEND_N=5 npx ts-node tests/end-to-end/run_lottery.ts test_lottery.json

# Step 4: cleanup
cd offchain && npx ts-node tests/end-to-end/cleanup_wallets.ts \
  wallets.json CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq
```

### Expected SOL spend

| Item | SOL |
|--------|-----|
| 5 purchases | ~0.008 |
| keeper ATA (if missing) | ~0.002 |
| recipient ATA | ~0.002 |
| tx fees (~7 tx) | ~0.00005 |
| **Total** | ~0.012 |

### Expected timeline

- Phase 1 (preparation): ~2 sec
- Phase 2 (buy + send): ~50 min (5 purchases spread over the 50 min window, a send every 10 min)
- Phase 3 (finalize): ~2 sec
- **Total: ~50 min**

### Results of run #2 (2026-03-12)

**Status: PASSED (but through the DEX, not pumpfun)**

```
Completed: 5/5 buys, 5/5 sends, 0 abandoned
Duration: 42m 17s
```

All 5 purchases failed on pumpfun with `TooMuchSolRequired` (0x1772) and went through the Jupiter DEX fallback. The cause: `maxSolCost` did not account for the pump.fun fee (~1.25%), and slippage in batchBuy was 1%, which was not enough.

```
Our maxSolCost:    1,432,138 lamports (solAmount × 1.01)
The program wants: 1,435,684 lamports (solAmount + 1.25% fee)
Short by:              3,546 lamports
```

**Why did it work before PUMP_FEE_BPS?**

Before the February update (the cashback upgrade) the pump.fun fee was ~1% (100 bps, trading fee only). The 1% slippage buffer in batchBuy covered it, leaving a minimal margin for actual slippage, but for small amounts (0.001-0.01 SOL) that was enough.

The Feb 2026 update (the same one that added `bonding_curve_v2`) added a 30 bps creator fee on top of the 95 bps trading fee. The total became 125 bps (1.25%). Now 1% slippage < 1.25% fee, so `maxSolCost` is guaranteed to fall short even at zero actual slippage.

```
Before: fee ~100 bps, slippage buffer 100 bps → 100 ≥ 100 ✓ (just barely)
After:  fee  125 bps, slippage buffer 100 bps → 100 < 125 ✗ (25 bps short)
```

**The fix:** a `PUMP_FEE_BPS = 125` constant in `pumpfun/buy.ts`; `maxSolCost` is now `solAmount × (1 + fee + slippage)`. Fee and slippage are counted separately and do not overlap.

---

## Run #3: 0.01 SOL, 5 purchases (with the fee fix)

**Date:** 2026-03-15

### Goal

Check that purchases go through **pumpfun** (the bonding curve) rather than the DEX fallback, after fixing the fee in `maxSolCost`.

### Parameters

The same as run #2:

| Parameter | Value |
|----------|----------|
| totalSol | 0.01 SOL |
| mint | `EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump` |
| recipients | 1 (from wallets.json) |
| OVERRIDE_N | 5 (purchases) |
| OVERRIDE_SEND_N | 5 (send rounds) |
| buying window | 50 min (default) |

### Commands

```bash
# Step 2: build the input data
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets.json 0.01 "EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump" 1 offchain/test_lottery.json

# Step 3: run the round
OVERRIDE_N=5 OVERRIDE_SEND_N=5 npx ts-node offchain/tests/end-to-end/run_lottery.ts offchain/test_lottery.json
```

### What we check

- All 5 purchases have venue = `pumpfun` (not `dex`)
- All 5 sends completed
- No `TooMuchSolRequired` errors

### Results

**Status: PASSED — all through pumpfun**

```
Completed: 5/5 buys (all pumpfun), 5/5 sends, 0 abandoned
Duration: ~50 min (buy loop 47 min + send rounds)
Total SOL spent: 0.00985 SOL
```

Purchases:
```
│ # │ status    │ venue   │ attempts │ slippage │
│ 1 │ completed │ pumpfun │ 1        │ 1.0%     │
│ 2 │ completed │ pumpfun │ 1        │ 1.0%     │
│ 3 │ completed │ pumpfun │ 1        │ 1.0%     │
│ 4 │ completed │ pumpfun │ 1        │ 1.0%     │
│ 5 │ completed │ pumpfun │ 1        │ 1.0%     │
```

Every purchase went through the bonding curve on the first attempt. The fee fix (`PUMP_FEE_BPS = 125`) is confirmed.

Sends: 5/5 completed (rounds 2, 4, 6, 8, 10).

---

## Run #4: stress test (BUY_WINDOW_MINUTES=5)

**Date:** 2026-03-15

### Goal

Check behaviour with a compressed buying window: 5 minutes instead of 50, all 5 purchases in 5 minutes. It imitates the load of fast buying.

### Parameters

| Parameter | Value |
|----------|----------|
| totalSol | 0.01 SOL |
| mint | `EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump` |
| recipients | 1 (a new wallet) |
| OVERRIDE_N | 5 (purchases) |
| OVERRIDE_SEND_N | 5 (send rounds) |
| BUY_WINDOW_MINUTES | 5 (instead of 50) |

### Differences from run #3

- A 5 minute buying window → a purchase every ~60 sec instead of every ~10 min
- Send rounds every ~30 sec instead of every ~5 min
- A new recipient wallet (`DXGEMGDMmdffdJ4SiQZpR4GxUFSvHiRdoB1HoqFsByVp`) with a clean balance, so the exact token amount can be checked
- Wallet file: `wallets_1773579306.json`

### Commands

```bash
# Step 2: build the input data
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets_1773579306.json 0.01 "EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump" 1 offchain/test_lottery.json

# Step 3: run the stress test
BUY_WINDOW_MINUTES=5 OVERRIDE_N=5 OVERRIDE_SEND_N=5 npx ts-node offchain/tests/end-to-end/run_lottery.ts offchain/test_lottery.json
```

### What we check

- All 5 purchases succeed in the compressed window (venue = pumpfun)
- No timing problems (purchases do not overlap)
- Sends work properly with short rounds
- The recipient's balance equals the sum of every send (a clean wallet, easy to check)

### Results

**Status: PASSED (buys), partial (sends)**

```
Buys:  5/5 completed (all pumpfun), duration: 4m 54s
Sends: 1/5 completed, 4 skipped (balance=0)
Total SOL spent: 0.00781 SOL
Exit code: 0
Lottery ID: test_1773579626395
```

Purchases:
```
│ # │ status    │ venue   │ wait    │ SOL      │
│ 1 │ completed │ pumpfun │ 3s      │ 0.001623 │
│ 2 │ completed │ pumpfun │ 1m 38s  │ 0.001472 │
│ 3 │ completed │ pumpfun │ 1m 0s   │ 0.001722 │
│ 4 │ completed │ pumpfun │ 29s     │ 0.001545 │
│ 5 │ completed │ pumpfun │ 1m 33s  │ 0.001449 │
```

All 5 purchases inside 5 minutes: no timing problems, the purchases do not overlap.

**A send edge case:** every token went out in round 2 (the keeper's whole balance). In rounds 4-10 the balance was 0 and the remaining 4 sends were skipped. The recipient (`DXGEMGDMmdffdJ4SiQZpR4GxUFSvHiRdoB1HoqFsByVp`) got all their tokens, but in 1 send instead of 5. The cause: with a compressed window the buying finishes before the send rounds start, so the whole balance goes out in the first send.

This is not a bug: in production, with a 50 minute window and several recipients, the sends spread out properly (see run #3).

### Logs

```
logs/test_1773579626395/
├── lottery_test_1773579626395.json
├── run_test_1773579626395.log
└── batch_2026-03-15T13-01-06_1udlrp.json
```

---

## Run #5: a live token with active trading

**Date:** 2026-03-15

### Goal

Check buying a **live token** with active trading (real slippage, competition for liquidity). The previous tests (#3, #4) used a dead token (`EyrHghvD...`) with almost no volume.

### Parameters

| Parameter | Value |
|----------|----------|
| totalSol | 0.01 SOL |
| mint | `2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump` |
| recipients | 1 (a new wallet) |
| OVERRIDE_N | 5 (purchases) |
| OVERRIDE_SEND_N | 5 (send rounds) |
| BUY_WINDOW_MINUTES | 5 |

### Differences from run #4

- **A live token** with active trading: real slippage, the price can move between purchases
- A new recipient wallet (clean balance)

### Commands

```bash
# A new wallet
npx ts-node offchain/tests/end-to-end/generate_wallets.ts 1 offchain/wallets_<timestamp>.json

# The input data
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets_<timestamp>.json 0.01 "2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump" 1 offchain/test_lottery.json

# The run
BUY_WINDOW_MINUTES=5 OVERRIDE_N=5 OVERRIDE_SEND_N=5 npx ts-node offchain/tests/end-to-end/run_lottery.ts offchain/test_lottery.json
```

### What we check

- Purchases go through on a live token (venue = pumpfun)
- 1% slippage is enough with active trading
- No errors from competition for liquidity

### Results

**Status: PASSED — a live token, all through pumpfun**

```
Buys:  5/5 completed (all pumpfun), duration: 4m 44s
Sends: 1/5 completed, 4 skipped (balance=0)
Total SOL spent: 0.00577 SOL (net of the 0.00204 ATA fee)
Exit code: 0
Lottery ID: test_1773590473493
```

Purchases:
```
│ # │ venue   │ wait    │ SOL      │ price/token     │ bonding curve SOL │
│ 1 │ pumpfun │ 39s     │ 0.001250 │ 0.0000001311    │ 64.95             │
│ 2 │ pumpfun │ 29s     │ 0.001087 │ 0.0000001311    │ 64.96             │
│ 3 │ pumpfun │ 1m 19s  │ 0.001142 │ 0.0000001257    │ 63.60             │
│ 4 │ pumpfun │ 1m 16s  │ 0.001144 │ 0.0000001257    │ 63.60             │
│ 5 │ pumpfun │ 49s     │ 0.001147 │ 0.0000001257    │ 63.60             │
```

Between purchases #2 and #3 the price fell (~4%): someone sold and the bonding curve shrank from 64.96 to 63.60 SOL. 1% slippage is enough even with active trading. Every purchase went through on the first attempt.

Recipient wallet: `wallets_1773590204.json`

### Logs

```
logs/test_1773590473493/
├── lottery_test_1773590473493.json
├── run_test_1773590473493.log
└── batch_2026-03-15T16-01-29_ihd5nb.json
```

---

## Run #6: 10 recipients + 2 tokens

**Date:** 2026-03-15

### Goal

Check buying several tokens in parallel plus distribution between several recipients. The first test with batch transfers (up to 5 recipients per tx) and deficit-based distribution.

### Parameters

| Parameter | Value |
|----------|----------|
| totalSol | 0.06 SOL |
| mint #1 | `2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump` (live) |
| mint #2 | `7GPviorAr6tHeFBVGF6Hc2i1RvMd4m54bVbCb7aBNC9q` |
| recipients | 10 (new wallets) |
| OVERRIDE_N | 5 (purchases per token) |
| OVERRIDE_SEND_N | 5 (send rounds) |
| BUY_WINDOW_MINUTES | 5 |

### Budget

```
totalSol           = 0.06 SOL
ATA reserves       ≈ 20 ATAs × 0.00204 = 0.041 SOL (10 recipients × 2 tokens)
TX fees            ≈ 0.001 SOL
buyBudget          ≈ 0.018 SOL (~0.009 per token)
per buy (N=5)      ≈ 0.0018 SOL
```

### How the recipients were split

**Mint #1** (`2fGbynWM...`): 0.03 SOL, 5 recipients

| Recipient | Committed | Share |
|---|---|---|
| DcFsBhWB2iwq... | 5.543 SOL | 32.5% |
| CYwqrsjzngEj... | 0.505 SOL | 3.0% |
| AeJhZnq3kdeH... | 2.555 SOL | 15.0% |
| FCRgfBLKU6N8... | 2.130 SOL | 12.5% |
| 92xs7KuLhT47... | 6.339 SOL | 37.1% |

**Mint #2** (`7GPvior...`): 0.03 SOL, 5 recipients

| Recipient | Committed | Share |
|---|---|---|
| CMKpacXGGXGP... | 5.849 SOL | 31.1% |
| DhsRLh6cAqzp... | 7.616 SOL | 40.5% |
| 4zcJhGuLCWUo... | 1.013 SOL | 5.4% |
| CneoDM5S3CiH... | 3.760 SOL | 20.0% |
| 8fgH8Aydhnv2... | 0.544 SOL | 2.9% |

Wallets: `wallets_1773594685.json`
Input data: `test_lottery_1773594963198.json`

### What we check

- Two tokens bought in parallel (2 batchBuy at once)
- Batch transfers: up to 5 recipients per tx
- Deficit-based distribution between 10 recipients
- Different commit proportions (random amounts)

### Commands

```bash
# New wallets
npx ts-node offchain/tests/end-to-end/generate_wallets.ts 10 offchain/wallets_<timestamp>.json

# The input data (2 mints, comma separated)
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets_<timestamp>.json 0.06 \
  "2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump,7GPviorAr6tHeFBVGF6Hc2i1RvMd4m54bVbCb7aBNC9q" \
  10 offchain/test_lottery.json

# The run
BUY_WINDOW_MINUTES=5 OVERRIDE_N=5 OVERRIDE_SEND_N=5 npx ts-node offchain/tests/end-to-end/run_lottery.ts offchain/test_lottery.json
```

### Results

**Status: PASSED (buys), partial (sends — a known issue with SEND_INTERVAL)**

```
Buys:  10/10 completed (all pumpfun), 2 tokens in parallel
  - 2fGbynWM...: 5/5, duration 4m 50s, spent 0.01945 SOL
  - 7GPviorA...: 5/5, duration 4m 31s, spent 0.01741 SOL
Sends: 10/50 completed, 40 skipped (balance=0 after round 2)
Exit code: 0
Lottery ID: test_1773594963198
Runtime: ~52 min (buy 5 min + send loop 50 min — SEND_INTERVAL_MINUTES=5 is hardcoded)
```

**Batch transfers work:** round 2 sent to 5 recipients per mint in one tx (2 batch txs in total). All 10 recipients got their tokens.

**Known issue:** `SEND_INTERVAL_MINUTES=5` is not tied to `buyWindowMinutes`. At BUY_WINDOW_MINUTES=5 the buying finishes in 5 minutes but the send loop runs for 50 (10 rounds × 5 min). Rounds 3-10 are empty (balance=0).

### Logs

```
logs/test_1773594963198/
├── lottery_test_1773594963198.json
├── run_test_1773594963198.log
├── batch_2026-03-15T17-22-50_c840ea.json  (mint #1)
├── batch_2026-03-15T17-22-50_udhtlb.json  (mint #2)
├── test_lottery_1773594963198.json
└── wallets_1773594685.json
```

---

## Run #7: send stress test — 50 wallets, OVERRIDE_SEND_N=1

**Date:** 2026-03-15

### Goal

A send stress test on the Helius free tier (10 RPS). Every send in one round (the last), imitating the worst case of many small commits. We want to see whether we get 429s.

### Parameters

| Parameter | Value |
|----------|----------|
| totalSol | 0.3 SOL |
| mint #1 | `2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump` |
| mint #2 | `8PaK9mufsAyiGCpFN6Z6pyXs1ZzdC8tWcLV5Qmokpump` |
| recipients | 50 (new wallets) |
| OVERRIDE_N | 10 (purchases per token) |
| OVERRIDE_SEND_N | 1 (every send in the last round) |
| BUY_WINDOW_MINUTES | 5 |
| sendConcurrency | 20 (default) |

### Budget

```
totalSol           = 0.3 SOL
ATA reserves       = 100 ATAs (50 recipients × 2 tokens) × 0.00204 = 0.204 SOL
TX fees            ≈ 0.002 SOL
buyBudget          ≈ 0.094 SOL (~0.047 per token)
per buy (N=10)     ≈ 0.0047 SOL
```

### Expected load

```
Buy (0-5 min):     20 purchases × 7 RPC / 300 sec = 0.5 RPS
Send round 10:     100 recipients / 5 per batch = 20 batch txs
                   sendConcurrency=20 → all 20 at once
                   burst: 20 × ~5 RPC in <1 sec = 20+ RPS → 429s likely
```

### What we check

- Whether we get 429s during a send burst on the free tier
- Whether the retry logic picks the 429s up
- Whether every recipient ends up with their tokens

### Results

**Status: PASSED — 20/20 buys, 50/50 sends, 0 error 429s**

```
Buys:  20/20 completed (18 pumpfun + 2 dex fallback)
  - 2fGbynWM...: 10/10, all pumpfun, spent 0.07355 SOL, duration 4m 52s
  - 8PaK9muf...: 10/10, 8 pumpfun + 2 dex, spent 0.07151 SOL, duration 4m 47s
Sends: 50/50 completed, all in round 10 (OVERRIDE_SEND_N=1)
  - 10 batch tx (5 recipients × 2 mints × 5 per batch = 10 tx)
  - All 100 ATAs created (hadAtaAtStart=false)
Exit code: 0
Runtime: ~5m 2s (confirms the SEND_INTERVAL fix — it would have been ~52 min before)
Lottery ID: test_1773602197486
```

Budget:
```
totalSol     = 0.25 SOL
sendReserve  = 0.1025 SOL (100 ATA × 0.00204 + TX fees)
buyBudget    = 0.1475 SOL (0.07375 per token)
ATA reserves = 40.9% of totalSol
```

**DEX fallback (8PaK9muf...):** purchases #3 and #5 got `TooMuchSolRequired` on pumpfun and fell through to the Jupiter DEX. The token was actively traded and the price moved between the fetch and the send. 1% slippage was not enough. Not a bug — expected behaviour, and the DEX fallback caught it.

**Load on Helius (free tier, 10 RPS):**
- Buy: 20 purchases over 5 min = ~0.07 RPS (nowhere near the limit)
- The send burst in round 10: 10 batch txs × sendConcurrency=20 → all 10 at once
- Burst: ~10 × 5 RPC = 50 RPC calls, but spread over ~2 sec (the confirm wait)
- **Result: 0 error 429s.** The free tier (10 RPS) held.

**Conclusion:** getting 429s on sending needs >100 recipients (20+ batch txs at once) or sendConcurrency > 20.

### Logs

```
logs/test_1773602197486/
├── lottery_test_1773602197486.json
├── run_test_1773602197486.log
├── batch_2026-03-15T19-19-47_5gkjj6.json  (mint 2fGbynWM, 10/10 pumpfun)
├── batch_2026-03-15T19-19-47_91ud7y.json  (mint 8PaK9muf, 8 pumpfun + 2 dex)
├── test_lottery_1773602197486.json
└── wallets_1773602112.json
```

---

## Run #8: DEX only — graduated + BONK (not pump.fun)

**Date:** 2026-03-18

### Goal

Check buying and delivery through **Jupiter DEX** with no pump.fun bonding curve. Two scenarios:
1. A graduated pump.fun token → Jupiter → PumpSwap AMM
2. An ordinary SPL token (BONK) → Jupiter → Raydium/Orca

The first test where every purchase goes through `buyDex()` rather than `buyPumpfun()`.

### Parameters

| Parameter | Value |
|----------|----------|
| totalSol | 0.25 SOL |
| mint #1 | `Dz4bX3snTDxqdKyZwdUgKoDvSjyvmoA23E6j5odZpump` (graduated) |
| mint #2 | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK) |
| recipients | 60 (30 per mint) |
| OVERRIDE_N | 10 (purchases per token) |
| OVERRIDE_SEND_N | 1 (every send in the last round) |
| BUY_WINDOW_MINUTES | 5 |
| sendConcurrency | 20 (default) |

### Budget

```
totalSol           = 0.25 SOL
ATA reserves       ≈ 60 ATAs × 0.00204 = 0.1224 SOL (30 per mint × 2)
  - BONK: regular Token program ATA (0.00204 SOL each)
  - Graduated: a Token-2022 ATA (0.00204 SOL each)
TX fees            ≈ 0.002 SOL
buyBudget          ≈ 0.126 SOL (~0.063 per token)
per buy (N=10)     ≈ 0.0063 SOL
```

### What we check

- Every purchase through the Jupiter DEX (venue = `dex`), none through pumpfun
- `isBondingCurveActive()` correctly identifies a graduated token
- BONK (the regular token program) works with our send() (Token vs Token-2022 detection)
- Batch transfers work for mixed token programs
- Cleanup works for both token types

### Results

_(to be filled in after the run)_

---

## The log of the first run (archive)

### Step 1: generate_wallets

```bash
npx ts-node offchain/tests/end-to-end/generate_wallets.ts 1 offchain/wallets.json
```

Output:
```
Generated 1 wallets
Saved to offchain/wallets.json
```

Recipient: `HH6BMR4L8VCYVXHjVnnWy7i8ayh7Lubsmm4x5TpwUi3J`

### Step 2: generate_lottery_input

```bash
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets.json 0.1 "6tGwYs5EcxLMN3q7iprp9XYza2miHZDzZte1RhFmpump" 1 offchain/test_lottery.json
```

Output:
```
Wallets used: 1
Unique mints: 1
Saved to offchain/test_lottery.json
```

Result: `lotteryId: test_1773263226127`, recipient `HH6BMR4L8VCYVXHjVnnWy7i8ayh7Lubsmm4x5TpwUi3J`, amount 6.4 SOL (irrelevant: 1 recipient = 100%).

### Step 3: run_lottery

```bash
cd offchain && OVERRIDE_N=10 OVERRIDE_SEND_N=10 npx ts-node tests/end-to-end/run_lottery.ts test_lottery.json
```

Output: about 50 minutes of work expected, logs in `logs/run_{lotteryId}.log`

### Step 4: cleanup

```bash
cd offchain && npx ts-node tests/end-to-end/cleanup_wallets.ts \
  wallets.json <KEEPER_PUBKEY> <KEEPER_PUBKEY>
```

Output: expected

### Notes from the run

- `--loader ts-node/esm` does not work (Node v24, ERR_REQUIRE_CYCLE_MODULE). We use `npx ts-node` directly, with tsconfig `module: "commonjs"`.
- Steps 1-2 run from the repository root, steps 3-4 from `offchain/` (the cwd for logs and state files).
- The import in `buy.test.ts` was fixed: `../../src/buy` → `../../buy` (the old path did not exist).

---

## Bug: buyPumpfun Overflow (0x1788) — SOLVED

### Symptoms

`buyPumpfun()` failed during simulation with:
```
AnchorError thrown in programs/pump/src/lib.rs:463.
Error Code: Overflow. Error Number: 6024. Error Message: Overflow.
```

The error was swallowed in the `buy.ts` catch block → a silent fallback to the Jupiter DEX → `TOKEN_NOT_TRADABLE` (the token was on a bonding curve and Jupiter did not know it).

### Root cause

**A missing 17th account, `bonding_curve_v2`.**

In February 2026 pump.fun upgraded the on-chain program (the cashback upgrade). The `buy` instruction now requires **17 accounts** instead of 16, with a `bonding_curve_v2` PDA added:

```
seeds: ["bonding-curve-v2", mint.toBuffer()]
program: PUMP_PROGRAM_ID
```

That PDA does not have to exist on chain (it can be uninitialised). The program only uses it to index the remaining accounts correctly.

**Without that account the program read data from the wrong indices → garbage went into u64 arithmetic → "Overflow".** The error was misleading: it looked like an overflow in the AMM formula, when in fact the program was working with garbage data.

### False leads (what was NOT the cause)

1. **The feeConfig PDA seed** — corrected from `PUMP_PROGRAM_ID.toBuffer()` to the right constant from the IDL. A correct fix, but it did not solve the overflow
2. **The OptionBool third argument** — `trackVolume: { value: false }` added to the IDL and the call. A correct fix for the current IDL, but it did not solve the overflow
3. **buy_exact_sol_in** — tried the alternative instruction. The same overflow (the same cause: the missing account)
4. **Something about the token** — tried a dead one (`6tGwYs5E...`, 0.002 SOL) and a live one (`EyrHghvD...`, 7.5 SOL). Overflow on both, so it was not the token

### The fix

**`pumpfun/buy.ts`** — `bondingCurveV2` added as the 17th account:
```typescript
.accountsStrict({
    // ... the 16 existing accounts ...
    bondingCurveV2: getBondingCurveV2Address(info.mint),  // NEW
})
```

**`solana/config.ts`** — a `getBondingCurveV2Address(mint)` function added:
```typescript
export function getBondingCurveV2Address(mint: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve-v2"), mint.toBuffer()],
        PUMP_PROGRAM_ID
    );
    return pda;
}
```

**`pumpfun/idl.ts`** — `bondingCurveV2` added to the accounts of the `buy` instruction

**Also**: `accounts()` was replaced with `accountsStrict()` (as in a colleague's reference code) to pin the account order exactly.

### Verification

```bash
npm run test:integration -- --testPathPattern="buy.test" --testNamePattern="should buy token on pump.fun" --verbose
```

Result: `PASS`, venue: `pumpfun`, signature received.

### Source

- [How to Fix PumpFun Custom:6024 Overflow Error After the Cashback Upgrade](https://allenhark.com/blog/pumpfun-bonding-curve-custom-6024-overflow-fix-cashback-upgrade-guide)

---

## Run #9: a targeted check of the money paths on mainnet

**Date:** 2026-09-10
**Wallet:** `PrpNxdeSX8SwyUNv4H2pA7aZ6PRYzfAyEPPogCgCDnQ` (a test wallet; after
the run it is treated as compromised, the key was passed over chat)
**Spent:** 0.051321 SOL (~$5.14 at SOL $100.15), of which ~0.0122 is rent for six ATAs
**Node:** `api.mainnet-beta.solana.com` (Helius exhausted: `max usage reached`)

Not a full `executeLottery`, but a targeted check of the paths that until then
lived only in simulation or never executed at all. Every call went through the
production code (`buy()`, `buyPumpswap()`, `buildBatchSendTransaction()`), not
through replicas.

### Results

| Path | Outcome | Signature |
|---|---|---|
| pump.fun curve, ordinary coin (`is_mayhem_mode=0`) | `err=null`, 126,230,555,054 units | `4UfrJVEeXdhs9o5ZvUed7z7rWdrKJjcwrAck2h879Ag2ubYCSyq5LzaqMcE6PAXigzbLtrLoPNyzCdo9Jj6HRHDw` |
| pump.fun curve, Mayhem coin (`is_mayhem_mode=1`) | `err=null`, 1,448,076,641,643 units | `3dUPiB2S1PmSifAMPWHs6XX31ssVFaW9xLPudD4knekoCunxkkArrmN6S9FfAWv4eiz8v8ohj2HSr6aYTnx6YQ5a` |
| **PumpSwap, straight into the pool** | `err=null`, 553,551,557,204 units, 109,982 CU | `2e5D3NuoT5DRdQHdB6ceZ1uW5mv8xjTAbtnUJFs49HWqqGd3mpEdJF5eJd8YydeCd5WyCaxnrN4kjojzNapZ6aoB` |
| Purchase through Jupiter | `err=null`, 204,526,906,040 units | `5z7cxPFLzkzQWRwuGFHoM1NRT21JNvg6cU9hYf67rfBn5ZdLPpij4h5pZ2TgvxgDenyZeiV4a6SpsCQPk68qBoNZ` |
| Batched delivery, 2 recipients, Token-2022 | `err=null`, both got exactly what was promised | `22jUT3REpywzmyn9dxqUyACvywMPGQbyoimFF9ynQNPuUX2vLUWruwFJbL5peC3uTUPXnBpT86tMgynwpQnbZr8C` |

0.01 SOL per purchase, slippage 500 bps (900 for the non-SOL ones).

### What this run closed

**PumpSwap executed for the first time in the project's history.** On SDK 1.18.0
the path was dead outright (`ExceededSlippage 6004` because
`virtual_quote_reserves` was never read), and it had never been tried for real.
Now it is confirmed with money.

**The fee recipient choice was checked on coins of both types** — the fix from
2026-09-08 had rested on simulation alone until then.

**Delivery to recipients** ran on the code rewritten for Token-2022 extensions,
which had never run for real. Extensions 18/19 were recognised, there were no
blockers, and `deliveredAmounts` matched the actual balances on the recipients' accounts.

### Disproved: Custom Pairs coins ON THE CURVE cannot be bought

The earlier conclusion that "Jupiter gives a route, so we can buy" was **wrong**:
it rested on a quote existing. The quote exists and the transaction does not fit:

```
CTbo254v… (curve in USDC): route Quantum -> Byreal -> Pump.fun, 1402 bytes
A7zxU2uv… (curve in PUMP):  2 hops,                              1246 bytes
Solana transaction limit:                                        1232 bytes
```

`maxAccounts` 40/32/24 and `onlyDirectRoutes` give `NO_ROUTES_FOUND` — the route
disappears entirely. The error arrives as `encoding overruns Uint8Array` from
`serialize()`, that is BEFORE sending: the money is safe but no purchase happens.
It is classified as `unknown`, so three useless retries are spent.

What fixes it is not the quote, it is graduation. Measured on 10 non-SOL coins:

| State | Result |
|---|---|
| on the curve (`complete=false`) | no route, or it does not fit — **cannot be bought** |
| after graduation (`complete=true`) | 7 of 8 fit (546–1130 bytes) — bought normally |

Hence the change in `webapp/backend/presentation/lottery/lottery_router.py`: a
non-SOL curve is rejected when the commit is accepted. Probing a quote is not
enough — it passes, and the assembly is what fails. After graduation the coin
goes down the old branch.

### Along the way

Some older coins have a curve account of ~49 bytes, and our IDL does not parse
it (`offset out of range`). Checked against the anchor source
(`account.js:107`): moving from `program.account.bondingCurve.fetch()` to
`program.coder.accounts.decode()` has nothing to do with it — `.fetch()` calls
exactly the same decoder and the behaviour is unchanged. In production the
exception is caught by `isBondingCurveActive`, which moves the coin to the
aggregator; that is what happened in this run, and the purchase succeeded.

### Not covered

A coin with `TransferFeeConfig` is the only branch where `deliveredAmounts` must
differ from what was requested. Such coins are rare on pump.fun, and hunting for
one would mean spending budget blind. The branch is covered by unit tests but has
never run for real.
