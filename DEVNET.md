# Devnet: a full round end to end

Why this file exists: you cannot buy a coin on devnet (pump.fun, PumpSwap and
Jupiter are not deployed there), but everything else can be checked — creating a
round, commits, the draw, closing, and above all **returning SOL to
participants** when the buying did not happen. SOL transfers work properly on
devnet, so the refund is visible for real and costs nothing.

## What devnet does cover

| Mechanic | Where to look |
|---|---|
| The round cycle | the worker opens a pool by itself; for tests the cycle shrinks to half an hour |
| Commits and the pool table | the `/pool` page |
| The draw | coin shares after the VRF |
| **Returning unspent SOL** | every purchase fails → SOL goes back to participants |
| **Recovery after a crash** | kill the buyer container mid-round |
| My commits, archive | `/me`, `/archive` |
| Alerts | "round stuck", "worker silent", buyer errors |

A real purchase on the curve and on a DEX is only covered by the mainnet run in
`offchain/tests/CLAUDE.md` (budget ~0.1 SOL, cleanup afterwards).

## What to put in `.env.dev`

```bash
NETWORK=devnet
SOLANA_HTTP_ENDPOINT=https://devnet.helius-rpc.com/?api-key=…   # the public RPC throttles hard
RPC_DEVNET=https://devnet.helius-rpc.com/?api-key=…             # same address for the buyer

# Who runs the rounds. Public keys go in a list; the signer's private key is
# placed on the server and never reaches the repository.
LOTTERY_ADMIN_PUBKEYS=EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ
LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON=[[…]]    # the private key of that same wallet

# Where the fee goes, and which wallet the buyer buys from.
# They must differ: the worker refuses to open a round if they match.
LOTTERY_AUTOSTART_FEE_WALLET=EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ
LOTTERY_AUTOSTART_KEEPER_WALLET=<the keeper public key>
KEEPER_SECRET_KEY=[…]                        # the private key of THAT SAME keeper

# The pool cap for tests. The early-close threshold is derived from it
# (cap minus the minimum commit), no separate variable needed.
LOTTERY_AUTOSTART_MAX_TOTAL_SOL=20

# A short cycle for testing: 20 minutes open, 10 minutes buying, a minute of pause.
LOTTERY_AUTOSTART_PREDICTION_SECONDS=1200
EXECUTION_COUNTDOWN_SECONDS=600
# The "done" pause between rounds, during which the page counts down to the next
# pool. Five minutes by default on mainnet, a minute is enough for tests.
LOTTERY_AUTOSTART_GAP_SECONDS=60
# Careful: a round is closed on chain CLOSE_LOTTERY_BUFFER_SECONDS before the end
# of the buying window. The default buffer is 600, so with a 600 second window the
# close would land exactly on the start of the buying. For a ten minute window use a minute.
CLOSE_LOTTERY_BUFFER_SECONDS=60

# The buyer fits inside the window: a purchase will not go through on devnet
# anyway, so there is no point waiting a full hour.
BUY_WINDOW_MINUTES=8
SEND_ROUNDS=3
OVERRIDE_N=2

# Solscan links have to point at devnet, otherwise the explorer answers "tx not found".
SOLANA_EXPLORER_QUERY=?cluster=devnet

# The alert channel (otherwise the Grafana rules fire into the void).
TELEGRAM_ERROR_BOT_TOKEN=…
TELEGRAM_ERROR_CHAT_ID=…
```

Two things people usually get wrong:

* The buyer's `KEEPER_SECRET_KEY` is the key of **the very wallet** named in
  `LOTTERY_AUTOSTART_KEEPER_WALLET`. The program sends the pool there, and if the
  key belongs to a different wallet the buyer will be spending an empty one.
* `LOTTERY_ADMIN_PUBKEYS` must contain the signer's wallet. The pool address is
  derived from the pair "program + admin", and the backend looks for rounds
  across every key in that list.

## The refund run

1. Bring up the stand: `./deploy.sh .env.dev`.
2. Sign in with a wallet from `LOTTERY_ADMIN_PUBKEYS`. The admin role is granted
   by address, at wallet sign-in.
3. Wait for a round to open by itself (or create one by hand in
   `/admin/create-lottery`).
4. Commit SOL from two or three different wallets behind different coins. Any
   mainnet mints will do: they do not trade on devnet anyway, and a failed
   purchase is exactly what we want.
5. Wait for the pool to close and the draw to run.
6. The buyer starts, every purchase fails, the coins are marked `failed`.
7. **Watch the refund.** In the buyer logs: `refund.start`, then `refund.sent`
   with a signature. The round state (`./logs/lottery_<id>.json`) grows a
   `refunds` list with statuses. On the participants' wallets: SOL arrives,
   minus the fee.

What should come out: everyone got their share of the unspent SOL back, the
share is worked out from what they committed behind that particular coin, and
one transaction's fee is split between the recipients in that batch (up to eight
per transaction).

A known remainder: the delivery reserve (`sendReserve`, roughly 0.002 SOL per
coin-recipient pair) stays on the keeper. It is set aside before the buying and
is not part of the refund.

## The recovery run

1. Wait for the buyer to start buying (`lottery.phase2_start` in the logs).
2. `docker compose restart buyer` — the state in `./logs` survives a restart.
3. The logs should show `api.resume_found`, then `lottery.resume` with the number
   of purchases left and deliveries put back in the queue.
4. The round plays out and closes, with no double sends.

## What devnet will not give you

* Purchases: `isBondingCurveActive` will not find a curve and Jupiter will not
  return a route. That is expected, and it is the precondition for testing refunds.
* Token delivery: there is nothing bought, so there is nothing to send.
* The "round stuck" alert will fire if the buyer is not running on the stand at
  all, leaving the round in `proceeding_purchases`. That is the rule behaving
  correctly.
