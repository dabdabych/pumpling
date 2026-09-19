# CLAUDE.md — end-to-end testing

## Overview

The end-to-end test runs a full `executeLottery()` cycle: batched buying of a
coin plus delivery to recipients.

## Files

```
tests/end-to-end/
├── generate_wallets.ts         # Step 1: generate recipient wallets
├── generate_lottery_input.ts   # Step 2: build the input data
├── run_lottery.ts              # Step 3: run executeLottery()
└── cleanup_wallets.ts          # Step 4: sell the tokens, return the SOL
```

## Commands

```bash
# every command from the repository root

# Step 1: generate 1 recipient wallet
npx ts-node offchain/tests/end-to-end/generate_wallets.ts 1 offchain/wallets.json

# Step 2: build the input (0.1 SOL, 1 mint, 1 recipient)
npx ts-node offchain/tests/end-to-end/generate_lottery_input.ts \
  offchain/wallets.json 0.1 "6tGwYs5EcxLMN3q7iprp9XYza2miHZDzZte1RhFmpump" 1 offchain/test_lottery.json

# Step 3: run the round (10 purchases, 10 send rounds)
cd offchain && OVERRIDE_N=10 OVERRIDE_SEND_N=10 npx ts-node tests/end-to-end/run_lottery.ts test_lottery.json

# Step 4: cleanup — sell the tokens, return the SOL to the keeper
cd offchain && npx ts-node tests/end-to-end/cleanup_wallets.ts \
  wallets.json <KEEPER_PUBKEY> <KEEPER_PUBKEY>
```

`wallets.json` and `test_lottery.json` hold real secret keys. They are ignored
by git and must stay that way.

## What happens at each step

### Step 1: generate_wallets.ts
- Creates a Solana keypair (the recipient)
- Saves it to `wallets.json` (publicKey + secretKey)
- The wallet needs no SOL, the keeper sends the tokens

### Step 2: generate_lottery_input.ts
- Builds `test_lottery.json` for `executeLottery()`
- Arguments: wallets file, SOL budget, mint address(es), wallet count, output file
- `totalSol` = how much SOL to spend buying (NOT what was committed)
- `recipients[].amount` = what that wallet committed, used for proportions (irrelevant with a single recipient)

### Step 3: run_lottery.ts → executeLottery()

#### Phase 1: preparation (~2 sec)
- Snapshot of the recipient's ATA (does a token account exist)
- Delivery reserve: ~0.002 SOL (ATA) plus fees
- Buy budget: totalSol - sendReserve ≈ 0.098 SOL
- `OVERRIDE_N=10` → 10 purchases of ~0.0098 SOL
- Creates the state file `./logs/lottery_test_....json`

#### Phase 2: buying and delivery in parallel (~50 min)

**Buy loop** (a 50 minute window):
- 10 purchases spread randomly across 50 minutes (roughly every 5 minutes)
- Each purchase: `isBondingCurveActive()` → `buyPumpfun()` or `buyDex()`
- Transaction → confirmation (~5-30 sec)
- Plus a 10 minute retry buffer (slippage escalation: 1% → 3% → 5%)

**Send loop** (50 minutes, 10 rounds of 5 minutes):
- `OVERRIDE_SEND_N=10` → a delivery in every round
- Deficit based: each round counts how many tokens were bought and sends the proportion
- Carry-forward: if the balance is 0 (buying has not produced anything yet) the delivery moves to the next round

#### Phase 3: finalize
- Writes `finishedAt` into the state file
- Exit code 0 means fine, 1 means there were failures

### Step 4: cleanup_wallets.ts
For every wallet in wallets.json:
1. Fund: keeper → 0.0003 SOL for gas
2. Sell: a Jupiter swap of all tokens → SOL
3. Close the ATA: rent comes back (~0.002 SOL)
4. Return: SOL back to the keeper

The funder and the receiver are both the keeper address.

## Env overrides (temporary, for tests)

| Variable | Where | What it does |
|---|---|---|
| `OVERRIDE_N` | `scheduler/fees.ts` → `calculateN()` | forces the purchase count, ignoring the formula |
| `OVERRIDE_SEND_N` | `orchestrator/sendRounds.ts` → `calculateSendN()` | forces the number of delivery rounds per recipient |

**Remove before production.**

## Output files

```
offchain/
├── wallets.json                      # generated wallets
├── test_lottery.json                 # input data
└── logs/
    ├── run_test_1741....log          # console output (stdout + stderr)
    ├── lottery_test_1741....json     # orchestrator state (buys, sends)
    └── batch_....json                # details of every purchase in batchBuy
```

## SOL spent

| Item | SOL |
|--------|-----|
| 10 purchases | ~0.098 |
| keeper ATA (if missing) | ~0.002 |
| recipient ATA | ~0.002 |
| tx fees (~12 tx) | ~0.0001 |
| cleanup funding | ~0.0003 |
| **Total** | ~0.102 |

Most of it comes back during cleanup (selling the tokens plus rent). What is
gone for good is slippage and fees, about 0.005-0.01 SOL.

## Test mints

| Mint | Type | State | Runs |
|------|-----|--------|-------|
| `6tGwYs5EcxLMN3q7iprp9XYza2miHZDzZte1RhFmpump` | Token-2022, bonding curve | dead (0.002 SOL real reserves) | #1 |
| `EyrHghvDK5QsxNuH98RsAkTaHwsxfnnAKL5gX1Nypump` | Token-2022, bonding curve | dead (~31 SOL reserves, no live trades) | #2, #3, #4 |
| `2fGbynWMUZnMs8RvzhgzUg59MnLh4QVTDEsNf1LNpump` | Token-2022, bonding curve | alive, trading | #5, #6, #7 |
| `7GPviorAr6tHeFBVGF6Hc2i1RvMd4m54bVbCb7aBNC9q` | Token-2022, bonding curve | alive | #6 |
| `8PaK9mufsAyiGCpFN6Z6pyXs1ZzdC8tWcLV5Qmokpump` | Token-2022, bonding curve | alive | #7 |
| `Dz4bX3snTDxqdKyZwdUgKoDvSjyvmoA23E6j5odZpump` | Token-2022, graduated | graduated → PumpSwap AMM | #8 |
| `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | SPL (Token program), BONK | Raydium/Orca DEX | #8 |

---

## Run log

The history of individual end-to-end runs (parameters, budgets, results, logs)
is in `RUNS.md`. Do not add to this file: a new run gets a section in `RUNS.md`,
so that this one stays an instruction rather than a lab notebook.
