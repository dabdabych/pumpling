# CLAUDE.md — the off-chain buyer

## Overview

The off-chain service that buys memecoins and delivers tokens to the wallets
that backed them. Three layers:

- **Layer 1:** `buy()` and `send()` — one purchase or one transfer, atomic
- **Layer 2:** `batchBuy()` — one coin end to end: split into N purchases, schedule, retry, persistence
- **Layer 3:** `executeLottery()` — the whole round: every coin bought in parallel plus delivery

---

## File layout

```
offchain/
├── index.ts                    # Barrel exports for the module
├── buy.ts                      # Router: bonding curve → pumpfun, otherwise → dex (Jupiter)
├── send.ts                     # Sends SPL tokens to a recipient (Token + Token-2022)
├── logger.ts                   # pino logger
│
├── pumpfun/                    # Buying on pump.fun (bonding curve)
│   ├── buy.ts                  # fetchBondingCurveInfo → calculateBuyParams → buildTx → send
│   ├── bondingCurve.ts         # isBondingCurveActive(mint) — reads the complete flag
│   ├── graduation.ts           # getBondingCurveState(), checkGraduation() (deprecated)
│   ├── price.ts                # getTokenPrice(), estimateTokensOut() — AMM formula
│   ├── errors.ts               # typed pump.fun errors
│   └── idl.ts                  # pump.fun IDL for Anchor
│
├── dex/                        # Buying through a DEX
│   └── buy.ts                  # buyDex() — Jupiter quote → swap → confirm; NoRouteError
│
├── pumpswap/                   # Buying straight from a PumpSwap pool (fallback from Jupiter)
│   └── buy.ts                  # buyPumpswap() — @pump-fun/pump-swap-sdk → buy → confirm
│
├── solana/                     # Shared Solana utilities
│   ├── connection.ts           # Connection singleton, createProvider(keypair)
│   ├── transaction.ts          # signTransaction(), sendTransaction()
│   ├── priorityFee.ts          # compute budget and priority price per path
│   ├── rateLimiter.ts          # send rate limiting shared across paths
│   └── config.ts               # Program addresses, PDA derivations, Jupiter config
│
├── scheduler/                  # Layer 2: batch purchase orchestrator
│   ├── index.ts                # Barrel exports
│   ├── types.ts                # BatchBuyParams, BatchState, PurchaseRecord, BatchBuyResult
│   ├── batch.ts                # batchBuy() — the main loop
│   ├── fees.ts                 # calculateN(), calculateFees(), splitAmount()
│   ├── timing.ts               # generateScheduleOffsets(), createSchedule(), sleepUntil()
│   ├── slippage.ts             # getSlippageForAttempt(), canRetry() — slippage escalation
│   ├── errors.ts               # classifyError(), retryable/non-retryable/unknown patterns
│   └── state.ts                # BatchStateManager — writes JSON after every operation
│
├── orchestrator/               # Layer 3: round orchestrator
│   ├── index.ts                # Barrel exports
│   ├── types.ts                # ExecuteLotteryParams, LotteryState, SendRecord and the rest
│   ├── orchestrator.ts         # executeLottery() — buy and send in parallel, 3 phases
│   ├── semaphore.ts            # Semaphore — concurrency control
│   ├── fees.ts                 # calculateSendReserve(), distributeBuyBudget()
│   ├── sendRounds.ts           # calculateSendN(), assignRounds(), executeSendRounds()
│   ├── batchTransfer.ts        # buildBatchSendTransaction() — up to 5 recipients per tx
│   ├── refunds.ts              # returns unspent SOL to the people who committed it
│   ├── resume.ts               # picks up rounds left unfinished by a crash
│   └── state.ts                # OrchestratorStateManager — JSON persistence
│
├── api/                        # HTTP wrapper around the buyer → api/CLAUDE.md
│
└── tests/                      # → tests/CLAUDE.md
    ├── setup.ts                # loadKeeper(), loadTestMints(), skip helpers
    ├── unit/                   # Unit tests (no network): pumpfun, dex, solana, scheduler
    └── integration/            # Integration (mainnet, needs KEEPER_SECRET_KEY)
```

---

## Layer 1: buy() and send()

### buy(mint, solAmount, keeper, slippageBps?)

The entry point for buying one coin. File: `buy.ts`

```
1. isBondingCurveActive(mint) — reads the bonding curve account on chain
2. If active → buyPumpfun() (straight onto the curve)
   If that fails → fall back to buyDex() (the coin may have graduated between
   the check and the purchase, or the curve is not quoted in SOL — see Custom Pairs)
3. If not active → buyDex() (Jupiter aggregator)
4. If buyDex() threw NoRouteError (Jupiter has no route) → buyPumpswap() (the pool directly)
```

Returns `{ signature, venue: "pumpfun" | "dex" | "pumpswap" }`.

### buyPumpfun(mint, solAmount, keeper, slippageBps)

File: `pumpfun/buy.ts`

**The instruction is `buy_exact_sol_in`, not `buy`.** `buy` takes an amount of
TOKENS and charges its fee on top of the curve price, which meant guessing the
fee rate. That rate moves: measurements on mainnet on 2026-08-29 returned 0, 95
and 125 bps, and from 2026-09-01 20:00 UTC it became a step function of market
cap. `buy_exact_sol_in` takes an amount of SOL and subtracts the fee itself, so
the rate does not have to be known at all.

What simulation on mainnet established, and what the implementation rests on:

- there are **18** accounts, while the public IDL describes 16: the deployed
  program also requires `bondingCurveV2` and `buybackFeeRecipient` (with 16 it
  rejects with `BuybackFeeRecipientMismatch`);
- **the fee recipient is chosen by the `is_mayhem_mode` flag on the bonding
  curve itself, NOT by the global `mayhem_mode_enabled`.** A Mayhem-mode coin
  accepts only `reserved_fee_recipient`/`reserved_fee_recipients[]`, an ordinary
  one only `fee_recipient`/`fee_recipients[]`; either way round it is
  `NotAuthorized`. The global flag only enables the mode as a possibility.

  History: the measurement on 2026-08-29 tied the list to the global flag. A
  Mayhem coin happened to be the one measured, and the coincidence was taken
  for a rule. The mistake broke **every** purchase of an ordinary coin, which is
  the main path the money takes. Found on 2026-09-08 by simulating against live
  coins, then checked both ways:

  | coin | ordinary list | reserved list |
  |---|---|---|
  | `is_mayhem_mode = 1` | `NotAuthorized` | ok |
  | `is_mayhem_mode = 0` | ok | `NotAuthorized` |

  The `Global` layout was cross-checked through account owners: ordinary
  recipients belong to the System Program, reserved ones to the Mayhem program
  `MAyhSmzX…`, buyback to the fee program `pfeeUxB6…`. Owners matching the
  meaning of the fields means the offsets have not drifted.

  The rule is covered by unit tests (`tests/unit/pumpfun/feeRecipients.test.ts`),
  including a regression for picking by the global flag.

**The curve is not necessarily quoted in SOL.** On 2026-09-09 pump.fun opened
"Custom Pairs": a coin can be launched quoted in USDC, WBTC or a tokenized
stock (`AAPLx` and other xStocks). For those, `buy_exact_sol_in` answers
`UnsupportedQuoteMint` (6063) — they cannot be bought for SOL on the curve.

`fetchBondingCurveInfo` reads `quote_mint` at offset **83** of the curve
account, and `buildPumpfunBuyTransaction` refuses to assemble a transaction for
a non-SOL quote. The refusal happens BEFORE reading the fee config, the
blockhash, the signature and the simulation, otherwise every one of a hundred
purchases would spend that work on a doomed attempt. It is a pre-send error, so
the router in `buy.ts` moves such a coin to the aggregator.

**But while that coin is still ON THE CURVE, the aggregator cannot get it
either.** A live check on 2026-09-10 (log `tests/RUNS.md`, run #9) disproved the
earlier conclusion that "a quote exists, therefore we can buy": the quote exists
and the transaction does not fit. The route from SOL goes through the quote and
then the curve, two hops, 1246–1402 bytes against a 1232 limit; `maxAccounts`
40/32/24 and `onlyDirectRoutes` lose the route entirely. `serialize()` fails
with `encoding overruns Uint8Array` BEFORE sending, so the money is safe but no
purchase happens.

What fixes it is not the quote, it is graduation: once off the curve the coin
trades in an ordinary pool and buys normally (measured: 7 of 8 fit, 546–1130
bytes). So a non-SOL curve is **rejected when the commit is accepted**, rather
than let through with a route check, because probing a quote does not tell these
cases apart.

**This rejection no longer runs.** It lived in the `pumpfun` branch of
`lottery_router._validate_mint_by_lottery_type`, and that branch went with the
`pumpfun` round type. The remaining path (`lottery_router._validate_mint`) reads
the curve through `get_pumpfun_curve_info` the same way, but only to tell a
young coin from a dead one: `_has_live_pumpfun_curve` answers false for a
non-SOL curve, and the coin then falls through to "allow at user's risk"
alongside every coin with no pool.

The ordinary round never had the rejection — it was only ever on the pump.fun
round — so nothing regressed when the branch went. What is true is that the risk
above is now unguarded: such a commit is taken, the purchase falls through to
the PumpSwap fallback, which derives the pool with quote = WSOL and gets the
wrong address for a non-SOL coin, and the buy ends `abandoned` with the SOL on
the keeper. Whether to move the rejection into `_validate_mint` is a product
call, not a leftover.

```
1. fetchBondingCurveInfo() — reads on-chain state (reserves, creator,
   token program, is_mayhem_mode, quote_mint)
2. calculateBuyParams() — spendable_sol_in = the whole budget (the program
   subtracts its fee), min_tokens_out = expectation at the worst fee minus slippage
3. buildCreateAtaIx() — idempotent creation of the buyer's ATA
4. buildBuyIx() — the buy_exact_sol_in instruction with 18 accounts
   (global, bondingCurve, creatorVault, globalVolumeAccumulator,
   userVolumeAccumulator, feeConfig, feeProgram, bondingCurveV2,
   buybackFeeRecipient and the rest). Checked against a live mainnet
   transaction on 2026-08-29: 18 accounts, same order. tokenProgram comes
   from the mint owner, so Token-2022 works — such coins do show up on pump.fun.
5. sendTransaction() — sign + send + confirm
```

The key point: both recipient lists are read from the on-chain `Global` account
(not hardcoded) and cached for 10 minutes; which list applies is decided by the
flag on the individual coin.

### buyDex(mint, solAmount, keeper, slippageBps)

File: `dex/buy.ts`

```
1. getQuote() — GET Jupiter /swap/v1/quote (30s timeout)
2. buildSwapTransaction() — POST Jupiter /swap/v1/swap → VersionedTransaction
3. sign + sendTransaction + confirmTransaction
```

Uses lite-api.jup.ag (no API key). Configured through env: `JUPITER_BASE_URL`,
`JUPITER_MAX_ACCOUNTS`, `JUPITER_ONLY_DIRECT_ROUTES`.

**Jupiter routing gap (incident 2026-07-01, round 9tu3EZFd, mint BmU6x…Dpump):**
Jupiter's routing set is not the same as "every live pool". A graduated pump.fun
token can trade on its own PumpSwap pool for months while Jupiter answers
`TOKEN_NOT_TRADABLE`, having dropped it from routing (noticed after a long spell
of low activity; the threshold is not liquidity in any simple sense: $1.9k
routed, $1.4k did not; Token-2022 had nothing to do with it). This used to be
non-retryable → abandoned → SOL left sitting on the keeper. Now `getQuote()`
throws a typed `NoRouteError` (route missing or TOKEN_NOT_TRADABLE) and the
router in `buy.ts` switches to `buyPumpswap()`, the pool directly (below).
On top of that, commit validation on the backend probes a Jupiter quote
(`webapp/backend/mint_validator.py`) and rejects mints with neither a Jupiter
route nor a live pool.

### buyPumpswap(mint, solAmount, keeper, slippageBps)

File: `pumpswap/buy.ts`

```
1. canonicalPumpPoolPda(mint) — the canonical PumpSwap pool (quote = WSOL), throws if there is none
2. OnlinePumpAmmSdk.swapSolanaState(pool, keeper) — reads the pool, reserves, accounts
3. PumpAmmSdk.buyQuoteInput(state, lamports, slippage%) — instructions (ATA + wSOL wrap + buy)
4. sign + sendRawTransaction + confirmTransaction
```

The fallback for graduated tokens Jupiter will not route (`NoRouteError` from
`buyDex`). We use the official `@pump-fun/pump-swap-sdk` rather than assembling
a 27-account instruction by hand: the SDK keeps up with the account set of the
fee program, which does get breaking upgrades. The SDK takes slippage in percent
(0-100), so we pass `slippageBps / 100`.

**SDK version: 1.19.0 minimum, never lower.** The pool has a
`virtual_quote_reserves` field, and price is computed from
`pool_quote_token_account.amount + virtual_quote_reserves`. SDK 1.18.0 knew the
`Pool` struct as only 12 fields, never read that one, and so priced the pool
roughly 70x below the truth — every purchase bounced with `ExceededSlippage
(6004)`, meaning the whole fallback was dead. 1.19.0 adds the 13th field and
`effectiveQuoteReserve = quoteReserve + virtualQuoteReserves`.

Checked on 2026-09-08 against the live pool `HozpRXYt…` (mint `EgV2VD8Z…`), the
same script minutes apart:

| SDK | `virtualQuoteReserves` | 0.001 / 0.05 / 0.1 / 0.25 / 0.5 SOL |
|---|---|---|
| 1.18.0 | field absent | all five → `ExceededSlippage 6004` |
| 1.19.0 | 17,584,505,288 | all five go through, ~115.6k CU |

**Dependencies:** the SDK brings its own `@coral-xyz/anchor@0.31` +
`@solana/spl-token@0.4` (nested; our code stays on 0.29 / 0.3);
`@solana/web3.js` and `bn.js` dedupe to a single version. Going 1.18.0 → 1.19.0
did not move the dependency tree: 477 package versions before and after, one
line changed, the SDK itself (4 lines in the lock file). `@solana/web3.js` stays
as a single copy on disk, otherwise `instanceof PublicKey` would break across
module boundaries. The SDK is imported in exactly one file, `pumpswap/buy.ts`,
so it does not touch the pump.fun path (instruction built by hand), Jupiter
(HTTP) or delivery (our `spl-token@0.3`).

PumpSwap slippage codes (6004, 6040) are only recognised by the classifier
together with the venue label — see `scheduler/errors.ts`.

### send(mint, recipient, amount, sender)

File: `send.ts`

```
1. detectTokenProgram() — Token vs Token-2022, from the owner of the mint account
2. getMintDecimals() — reads decimals
3. createAssociatedTokenAccountIdempotentInstruction — the recipient's ATA
4. createTransferCheckedInstruction — the transfer
5. sendTransaction()
```

Amount is in raw units (1_000_000 = 1 token at 6 decimals).

---

## Layer 2: batchBuy()

### Why batch at all

1. **Attention** — many green candles instead of one, the coin looks alive
2. **Front-running protection** — small purchases are not worth attacking
3. **Less slippage** — less time in the mempool per transaction

Note: price impact (AMM maths) is NOT reduced by batching.

### The algorithm (batch.ts)

```
PHASE 1: INIT
  calculateN(totalSol) → N purchases
  calculateFees(totalSol, N, hasAta) → fee reserve
  splitAmount(netAmount, N) → amounts[] (randomised ±10%)
  createSchedule(N, startTime, 50min) → scheduledTimes[] (random inside equal slots)
  BatchStateManager.create() → JSON file

PHASE 2: MAIN LOOP (50 min)
  for each purchase:
    sleepUntil(scheduledTime)
    buy(mint, amount, keeper, slippage=100bps)
    → completed | failed | abandoned (if non-retryable)

PHASE 3: RETRY BUFFER (10 min)
  for each failed (retryable and unknown errors only):
    up to MAX_RETRIES=2 extra attempts
    slippage escalation: 100 → 300 → 500 bps
    classifyError() on every error:
      non-retryable → abandon at once, do not spend a retry
      unknown → retry + warning log
    → completed | abandoned

PHASE 4: FINALIZE
  stateManager.finalize() — writes the final summary into the JSON
```

### The N formula (fees.ts)

| SOL | N | SOL per purchase |
|-----|---|-------------|
| <= 0.1    | 1 | all of it   |
| 0.1-1     | floor(sol/0.1), min 2 | ~0.1 |
| 1-5       | 10 + (sol-1)*2.5 | 0.1-0.25 |
| 5-50      | 20 + (sol-5)*(80/45) | 0.25-0.5 |
| > 50      | 100 (cap) | 0.5+ |

### Fee reserve (fees.ts)

```
ATA_FEE = 0.00204 SOL (when there is no ATA)
BUY_TX_FEE = 0.000105 SOL (base 0.000005 + priority 0.0001)
TX_FEE     = 0.00001  SOL (base 0.000005 + priority 0.000005) — delivery and refunds
totalFees = (hasAta ? 0 : ATA_FEE) + N * BUY_TX_FEE * 2 (x2 as retry headroom)
```

The reserve is computed from the priority CEILING, not from the expected price:
too little means the last purchases of a round fail with `insufficient funds`,
and that is other people's money, while too much simply goes back to them along
with the rest of the unspent SOL. The reserve ceilings and the ceilings in
`solana/priorityFee.ts` are tied together by a test
(`tests/unit/solana/priorityFee.test.ts`): the reserve must cover what we
actually pay.

The pump.fun trading fee is deliberately NOT reserved here: since the move to
`buy_exact_sol_in` the program subtracts it from `spendable_sol_in`, so the
debit equals the planned amount whatever the rate. Slippage is not subtracted
either, here or there: it is a ceiling on execution, not a cost, and it is only
spent when the price moves up. Headroom for it has to be on the keeper balance;
there is no check of that balance before buying right now, and `insufficient
funds` is classified as non-retryable.

### Timing (timing.ts)

The window is divided into N equal slots with a random moment inside each.
Minimum gap between purchases: 5 seconds.

### State persistence (state.ts)

`BatchStateManager` writes JSON after every status change. Format:

```json
{
  "runId": "batch_2026-02-08T12-30-00_abc123",
  "mint": "...",
  "totalSolAmount": 5,
  "purchaseCount": 20,
  "config": { "windowMinutes": 50, "retryBufferMinutes": 10, ... },
  "purchases": [
    { "index": 1, "status": "completed", "signature": "...", "venue": "pumpfun", ... }
  ],
  "summary": { "completedPurchases": 18, "abandonedPurchases": 2, "totalSolSpent": 4.491 }
}
```

Saved to `./logs/batch_{runId}.json` by default.

### Error classification (errors.ts)

`classifyError(error)` returns `{ errorClass, pattern }`:

| Class | Behaviour | Examples |
|-------|-----------|----------|
| **retryable** | retry normally | ECONNREFUSED, 429, 503, blockhash expired, timeout, slippage exceeded |
| **non-retryable** | abandon at once, 0 retries | insufficient funds, Mint not found, No route found, invalid public key |
| **unknown** | retry + warning log | anything that matched neither list |

Order matters: non-retryable is checked first, so that "insufficient funds" does
not match a retryable pattern.

Effect on retries:

| Scenario | buy() calls | Without classification |
|----------|--------------|-------------------|
| non-retryable in the main loop | 1 | 3 (wasted) |
| non-retryable in the retry phase | 2 | 3 (wasted) |
| unknown error | 3 (retried as usual) | 3 |
| retryable error | up to 3 | up to 3 |

---

## Configuration (solana/config.ts, env)

| Variable | Default | Meaning |
|------------|---------|----------|
| `NETWORK` | mainnet | mainnet / devnet |
| `RPC_MAINNET` | api.mainnet-beta.solana.com | RPC endpoint |
| `RPC_DEVNET` | api.devnet.solana.com | RPC endpoint |
| `KEEPER_SECRET_KEY` | - | secret key as a JSON array |
| `JUPITER_BASE_URL` | lite-api.jup.ag | Jupiter API |
| `SLIPPAGE_BPS` | 300 | default slippage |
| `PRIORITIZATION_FEE_LAMPORTS` | 5000 | priority fee |
| `JUPITER_MAX_ACCOUNTS` | 64 | account limit per tx |
| `JUPITER_ONLY_DIRECT_ROUTES` | 0 | direct routes only |

### On-chain addresses

```
PUMP_PROGRAM_ID       = 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
PUMP_FEE_PROGRAM_ID   = pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ
PUMPSWAP_PROGRAM_ID   = PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP  (unused)
```

PDA derivations: `getGlobalAddress()`, `getBondingCurveAddress(mint)`,
`getEventAuthorityAddress()` — all in config.ts.

---

## Testing

```bash
npm test                  # everything
npm run test:unit         # unit (no network)
npm run test:integration  # integration (needs KEEPER_SECRET_KEY + mainnet)
```

Jest: `jest.config.js` (two projects: unit + integration).
Env: `TEST_MINT_PUMPFUN`, `TEST_MINT_GRADUATED`, `TEST_MINT_DEX`, `TEST_RECIPIENT`.

- **Unit** (21 suites, 338 tests as of 2026-09-10) — formulas and routing with no
  network: AMM (`calculateBuyParams`), PDAs, `calculateN`/fees/timing/slippage,
  `classifyError`, fee recipient selection (`feeRecipients`), curve quote
  (`quoteMint`), Token-2022 extensions, `batchBuy` orchestration (with buy()
  mocked).
- **Integration** (mainnet) — real purchases: non-graduated → pump.fun,
  graduated/DEX → Jupiter, `send()`.

**Careful with the run count: read both lines, `Test Suites` and `Tests`.** A
suite that failed to compile silently drops out of the count, and the total
number of tests goes down while the output stays green. That is exactly what
happened when a required field was added to `BondingCurveInfo`: `tsc --noEmit`
stayed clean (tests are not in its config) and the `calculateBuyParams` suite
stopped building.

**What the integration tests do NOT check.** 8 of the 9 are skipped until
`TEST_MINT_*` is set and the keeper is funded, which is to say all the ones that
actually buy. "Integration green" without those variables proves nothing. The
convenient way to check the path for real is simulation: it is free, it works
against the public node `api.mainnet-beta.solana.com`, and it catches drift from
the deployed program before any money moves (that is how both the SDK 1.18.0 bug
and the fee recipient rule were found).

Which suites exist and what each covers is in the files themselves under
`tests/unit/**` and `tests/integration/**`. The end-to-end cycle
(`executeLottery` on mainnet) is in `tests/CLAUDE.md`.

---

## Retry: worst case analysis

### How long one buy() takes

For pumpfun:
```
isBondingCurveActive()     ~150ms   (1 RPC)
fetchBondingCurveInfo()    ~300ms   (2 RPC: getAccountInfo + fetch)
fetchFeeRecipient()        ~0ms     (cached after the first call)
getLatestBlockhash()       ~150ms   (1 RPC)
sendRawTransaction()       ~200ms   (1 RPC)
confirmTransaction()       ~5-30s   (polling until confirmed)
─────────────────────────────────────
Total:                     ~6-31 sec
```

For dex (Jupiter):
```
isBondingCurveActive()     ~150ms   (1 RPC)
Jupiter getQuote()         ~300ms   (1 HTTP)
Jupiter buildSwap()        ~300ms   (1 HTTP)
sendTransaction()          ~200ms   (1 RPC)
confirmTransaction()       ~5-30s   (polling)
─────────────────────────────────────
Total:                     ~6-31 sec
```

The bottleneck is `confirmTransaction()`, 5-30 seconds waiting for a block.

### Worst case: 5 coins x 50 SOL, total failure

- `calculateN(50)` = 100 purchases per coin
- 500 purchases in all
- all 500 failed

One coin, 100 failed purchases:
```
100 purchases x ~10 sec (average) = ~1000 sec ≈ 17 min (one pass)
With 2 retries: up to 300 attempts ≈ 50 min worst case
```

**10 minutes is nowhere near enough for a total failure.**

### Contention between 5 parallel coins

5 parallel batchBuy() means at most 5 concurrent buy() calls:
```
Peak load: 5 parallel buys x ~7 RPC calls ≈ 35 RPC requests
```

| Helius plan | RPS | Enough? |
|-------------|-----|---------|
| Free | 10 | No, there will be 429s |
| Developer | 50 | Just barely in normal operation |
| Business | 200 | Yes, with room |

Contention for liquidity is minimal, the pools are different. The only shared
resource is RPC. On the Developer plan (50 RPS) 5 parallel streams are fine, but
a mass retry of 500 purchases can produce 429s.

### The answer: an adaptive retry buffer

The retry window is computed from the **number** of failed purchases, not from
their share:

```
window = min(15, max(retryBufferMinutes, ceil(failed * 25s / 60)))
```

With the default minimum of 3 minutes:

| failures | window |
|---|---|
| 1–7 | 3 min |
| 10 | 5 min |
| 20 | 9 min |
| 36 and up | 15 min (cap) |

Why the count and not the share: the work depends on how many purchases have to
be repeated. The old formula `10 + share * 10` gave 15 minutes for five failures
out of ten and 10 minutes for five out of a hundred, although five is what needs
repeating in both cases. It was generous where pennies would do and stingy where
it would not have helped anyway.

**Why the cap is 15 and not 10 or 20.** Ten would be enough for completeness:
the worst case of a 111 SOL round is 70 winning coins at 1.538 SOL each, which
is 11 purchases per coin, and 10 minutes fits up to 15 retries per coin. But a
short window compresses the same work into less time and **raises** the peak
load on the node:

| window | concurrent purchases | purchase RPS | +delivery | Developer (50 RPS) |
|---|---|---|---|---|
| 10 min | 40 | 40 | 48 | just barely |
| 15 min | 27 | 27 | 35 | 30% headroom |
| 20 min | 20 | 20 | 28 | lots of headroom |

Twenty minutes would load the node even less but would stretch a publicly
announced round: delivery runs for 50 minutes in parallel, and the batch only
ends after the retries.

The estimate assumes ~10 RPC calls and ~10 seconds per attempt. If confirmations
come slower, the duty cycle drops and RPS with it.

## TODO

### Done

- **Returning unspent SOL** — `orchestrator/refunds.ts`, phase 2.9 before the
  round closes. Whatever is left on a coin (allocated minus spent) is split
  between the people who backed it, in proportion to what they put in; the
  network fee comes out of the refund and transfers go in batches of eight
  recipients per transaction. Refunds below a threshold are not sent, the fee
  would eat them whole. Nobody is paid twice: a record has a "sent but not
  confirmed" status with a signature, and that signature is checked on chain
  before any repeat.

- **Crash recovery** — `orchestrator/resume.ts`. On startup the buyer finds
  rounds in `./logs` with no finish time and continues them through the same
  code as a normal run (`runBuyAndSend`). Only the remainder is bought: how much
  was already spent is counted from completed purchases in the batch files, and
  a batch file name is known in advance (`batch_<lottery>_<mint8>_<attempt>.json`).
  Deliveries stuck `in_progress` go back into the queue; the signature check in
  `sendRounds` is what prevents a double send. What is left of the buying window
  is measured from the start of the round, with a two minute minimum.

- **Priority fee** — `solana/priorityFee.ts`. Until 2026-09-19 the buyer paid
  for queue position on Jupiter only, and even there a flat 5000 lamports:
  purchases on the curve, PumpSwap, delivery and refunds all went out with no
  priority at all. Now all four paths carry budget instructions, the price comes
  from the network (`getRecentPrioritizationFees` over the accounts the
  transaction writes), and the compute limits come from measuring our own
  mainnet history:

  | path | our usage (median / max) | limit | priority ceiling |
  |---|---|---|---|
  | pump.fun curve | 78,587 / 91,079 | 140,000 | 0.0001 SOL |
  | PumpSwap | 119,757 / 136,845 | 200,000 | 0.0001 SOL |
  | Jupiter | 137,018 / 210,497 | Jupiter sets its own | 0.0001 SOL |
  | delivery | 1,594 / 116,620 | 15,000 + 30,000 per recipient | 0.000005 SOL |
  | refund | 150 / 3,000 (20 transfers) | 1,000 + 400 per transfer | 0.000005 SOL |

  Asking for the price with no accounts is pointless: the network returns the
  minimum across all of them, and that is almost always zero (measured
  2026-09-19: 150 samples, all zeros). On the curve the market pays around
  158,000 lamports per transaction, but that is snipers competing for the first
  slot; the buyer spends an hour in small portions and can retry, so the ceiling
  stays at 0.0001 SOL and the priority is additionally capped at a percentage of
  the purchase itself.

- **RPC rate limiter** — `solana/rateLimiter.ts`, with the shared `sendTxLimiter`
  instance in `solana/connection.ts`. The rate is set by `SEND_TX_RATE_LIMIT`
  (default 4, a little under the Helius Developer ceiling). The slot is taken
  BEFORE signing on all four send paths: pump.fun and delivery
  (`solana/transaction.ts`), PumpSwap (`pumpswap/buy.ts`), Jupiter
  (`dex/buy.ts`). On a bigger plan the limit goes up through an environment
  variable, the code does not change.

### Not done

- **Jito integration** — replace sendTransaction() with a Jito bundle (front-running protection)
- **Claim flow** — manual claim for `ata_mismatch` (after the MVP)

### Open questions

- What if a token graduates in the middle of a batch?
- Stop buying if the price rises by X%?
- Several rounds in parallel: do the batches compete?

---

## Layer 3: executeLottery()

Layer 3 runs the whole round: every coin bought in parallel plus delivery. Buy
and send run **at the same time**, so people receive tokens as the buying goes
on instead of waiting 50 minutes.

### Files

```
orchestrator/
├── index.ts              # Barrel exports
├── types.ts              # All the types (ExecuteLotteryParams, SendRecord, LotteryState, …)
├── orchestrator.ts       # executeLottery() — the main function
├── semaphore.ts          # Semaphore (acquire/release/use) — concurrency control
├── fees.ts               # calculateSendReserve(), distributeBuyBudget()
├── sendRounds.ts         # calculateSendN(), assignRounds(), executeSendRounds()
├── batchTransfer.ts      # buildBatchSendTransaction() — up to 5 recipients per tx
└── state.ts              # OrchestratorStateManager — JSON persistence
```

### Limits

- At most 100 distinct coins in one round
- `buyConcurrency` = 50 by default (every coin in parallel)
- `sendConcurrency` = 20 by default
- With 100 parallel batchBuy the average RPC load is ~3 RPC/sec (fine on the Developer plan at 50 RPS)

### The algorithm (3 phases)

```
PHASE 1: PREPARATION
  generateSendRecords(tokens, totalRounds)
    → per recipient: calculateSendN() → assignRounds() → SendRecord[]
  calculateSendReserve() — SOL held back for ATA and tx fees
  buyBudget = totalSol - sendReserve
  distributeBuyBudget() — proportionally between coins
  OrchestratorStateManager.create() → JSON file

PHASE 2: PARALLEL BUY + SEND
  Promise.all([
    buyLoop:  Semaphore(100) → batchBuy() per coin
    sendLoop: executeSendRounds() — 10 rounds x 5 min
  ])

PHASE 3: FINALIZE
  Remaining failed sends → abandoned
  stateManager.finalize() → final summary
```

### API

```typescript
executeLottery({
    lotteryId: string,
    tokens: Array<{
        mint: PublicKey,
        totalSol: number,
        recipients: Array<{
            publickey: PublicKey,
            amount: number,          // SOL committed
        }>
    }>,
    keeper: Keypair,
    buyConcurrency?: number,    // default 100
    sendConcurrency?: number,   // default 20
    buyWindowMinutes?: number,  // default 50
    sendRounds?: number,        // default 10
    stateFilePath?: string,
}) → LotteryResult
```

### The two streams

```
Time:   0 min ──────── 25 min ──────── 50 min

buyLoop (Semaphore=100):
        ████████████████████████████████████
        up to 100 batchBuy() in parallel

sendLoop (10 rounds x 5 min):
        ·     ·     █     ·     █     ·     ·     █     ·     █   (8 SOL, sendN=4)
        ·     ·     ·     ·     ·     ·     ·     ·     ·     █   (0.05 SOL, sendN=1)
        █     █     █     █     █     █     █     █     █     █   (20+ SOL, sendN=10)
```

Small commits get their tokens in the last round. Large ones get something every
round. Medium ones are spread across the window.

### calculateSendN() — how many rounds

```
< 1 SOL  → 1
1-20 SOL → floor(3 + (sol - 5) × 7/15)   linear, 3 at 5 SOL
≥ 20 SOL → 10
```

| SOL | sendN |
|-----|-------|
| 0.05 | 1 |
| 1 | 1 |
| 5 | 3 |
| 10 | 5 |
| 20 | 10 |

### assignRounds() — spreading rounds across the window

Deliveries are spread evenly and the last one always lands in the final round:

```
sendN=1  → [10]              small: the last round only
sendN=3  → [4, 7, 10]        medium: evenly
sendN=4  → [3, 5, 8, 10]
sendN=10 → [1..10]           large: every round
```

Formula: `round[i] = ceil(i × totalRounds / sendN)` for i = 1..sendN

### Send reserve

```
totalSol = 250 SOL (from the vault)
sendReserve = Σ(sendN × TX_FEE + (ATA_FEE when there is no ATA)) per unique (mint, recipient)
buyBudget = totalSol - sendReserve
```

Layer 2 (`batchBuy`) knows nothing about recipients, it receives an amount that
is already reduced.

### Working out the amount in each round (deficit based)

In every round, for every mint:
1. `balance = getTokenBalance(mint, keeper)` — the real balance
2. `totalTokens = balance + sum(completed send amounts)` — how much was bought in total
3. Per recipient: `target = totalTokens × share`, `deficit = target - alreadySent`
4. If `sum(deficits) > balance`, scale down proportionally

Example: A(share=0.952, sendN=5), B(share=0.048, sendN=1), totalTokens=1000
```
Round 2:  totalTokens=200, A target=190, sent=0   → A gets 190, leaves 10
Round 4:  totalTokens=400, A target=380, sent=190  → A gets 190, leaves 20
...
Round 10: totalTokens=1000, A target=952, sent=761 → A gets 191
                            B target=48,  sent=0   → B gets 48
Final: A=952 (95.2%), B=48 (4.8%) ✓ exact proportions
```

Without the deficit approach A would take 100% of the balance in rounds without
B, and B would end up ~17% short.

**Carry-forward:** if the balance is 0 (buying has not produced anything yet)
the sends stay `pending` and are picked up by the next round. Filter:
`round <= currentRound && status === "pending"`.

**Delivery retries.** A failed delivery is not lost. On a retryable error it
goes back to `pending` and the next round takes it, until `MAX_SEND_ATTEMPTS`
runs out; on a non-retryable one it goes straight to `abandoned`. Compute limit
errors (`isComputeLimitError`) additionally trigger a retry with the batch split
up. On top of that, a sweep phase 2.5 after the main rounds moves `abandoned`
records with a retryable error back to `pending` and makes one more pass. There
is no `failed` status for deliveries at all, only purchases have one.

### ATA mismatch policy (MVP)

**< 1 SOL**
- Take an ATA snapshot at the start.
- If the ATA existed and disappeared before delivery:
  - `< 0.5 SOL` → **do not send**, status `ata_mismatch` in the report.
  - `0.5–1 SOL` → **let it go**, send as usual (creating the ATA if needed).
- If there was no ATA to begin with → send and create the ATA at our expense.

**>= 1 SOL**
- Take an ATA snapshot at the start.
- If the ATA existed and disappeared:
  - before the last round → **postpone**, accumulate the amount.
  - in the last round → **send everything accumulated**, creating the ATA if needed.
- If there was no ATA to begin with → send (creating the ATA on the first delivery).

The `ata_mismatch` status is written into the JSON report for transparency.

### Batch transfers

Instead of one transaction per recipient, up to 5 go into one:

```
Transaction {
  // Recipient 1
  createATA(Alice, $PEPE)                        // idempotent, ~25k CU
  transferChecked(keeper → Alice, 500 tokens)    // ~10k CU
  // Recipient 2
  createATA(Bob, $PEPE)
  transferChecked(keeper → Bob, 300 tokens)
  // ... up to 5 recipients
}
```

One signature, one fee (~0.000005 SOL), one confirm. The limit of 5 comes from
the compute budget: ~35k CU × 5 = 175k CU (default limit 200k).

`sendConcurrency` (default 20) is how many such transactions fly in parallel.
20 txs × 5 recipients = up to 100 recipients at once.

### State persistence

`OrchestratorStateManager`, along the same lines as `BatchStateManager`. Atomic
write (tmp + rename). Format: `./logs/lottery_{lotteryId}.json`

### Tests (5 suites, 63 tests)

| Suite | Tests | What it covers |
|-------|--------|--------------|
| semaphore | 9 | capacity enforcement, FIFO, release on error, concurrent use() |
| fees | 11 | sendReserve for various recipients, proportional distribution |
| sendRounds | 28 | calculateSendN, assignRounds (spread), generateSendRecords, calculateRoundAmounts |
| batchTransfer | 8 | 1/3/5 recipients per tx, caching of token program and decimals |
| orchestrator | 7 | happy path, partial buy failure, send reserve, state persistence, config |
