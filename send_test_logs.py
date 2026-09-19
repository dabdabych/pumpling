#!/usr/bin/env python3
"""
Sends test logs to Loki to verify all dashboard panels.
Usage: python3 send_test_logs.py           # batch mode (all events with distributed timestamps)
       python3 send_test_logs.py --stream  # streaming mode (one event about every 2 seconds)

Event table (script output to dashboard panel):

  Panel                       Event                               Count
  ──────────────────────────────────────────────────────────────────────
  Purchases / min             purchase.completed                  5
  Purchases / min             purchase.abandoned_*                3
  Errors / min                level=error                         7
  Errors / min                level=warn                          12
  Venue Routing               purchase.completed venue=pumpfun    3
  Venue Routing               purchase.completed venue=dex        1  (direct DEX, no fallback)
  Venue Routing               purchase.completed fallback=true    1  (pumpfun failed, then DEX)
  DEX Fallbacks               buy.fallback.pumpfun_to_dex         1
  PostSendErrors (CRIT)       pumpfun.send_failed                 1
  ATA Mismatches              send.ata_mismatch_blocked           1
  Send Failures               send.batch_failed                   1
  Retries / min               purchase.retry_attempt              3
  Retries / min               purchase.retry_success              2
  Retries / min               purchase.slippage_retry             1
  On-chain Failures (CRIT)    pumpfun.on_chain_failure            1
  On-chain Failures (CRIT)    dex.on_chain_failure                1  -> total 2
  Pending Confirmed           purchase.pending_confirmed          1
  Graduation Detected         pumpfun.graduation_detected         1
  Simulation Failed           pumpfun.simulation_failed           1
  DEX: No Route               dex.no_route                        1
  DEX: Quote Failed           dex.quote_failed                    1
  DEX: Swap Build Failed      dex.swap_build_failed               1
  DEX: Timeout                dex.timeout                         1
  Token Buy Failed            lottery.token_buy_failed            1
  Compute Limit Split         send.compute_limit_split            1
  Token Skipped (budget=0)    lottery.token_skipped_zero_budget   1
  Abandon Breakdown           purchase.abandoned_non_retryable    1
  Abandon Breakdown           purchase.abandoned_max_attempts     1
  Abandon Breakdown           purchase.abandoned_window_expired   1
  Abandon Breakdown           purchase.retry_failed               2
"""

import json
import time
import urllib.request
import urllib.error
import sys

STREAM_MODE = "--stream" in sys.argv

LOKI_URL = "http://localhost:3100/loki/api/v1/push"
STREAM = {"container_name": "lottery-buyer"}

MINT_A  = "6tGwYs5Etest1abc"
MINT_B  = "7uHxZt3Ftest2def"
MINT_C  = "8vJyAu4Gtest3ghi"  # token_buy_failed
MINT_D  = "9wKzBv5Htest4jkl"  # zero budget
LID     = "lottery-mock-test-001"
RUN_A   = "batch_mock_aaa"
RUN_B   = "batch_mock_bbb"

now_ns = int(time.time() * 1e9)

def ts(seconds_ago: float) -> str:
    """Return a nanosecond timestamp for N seconds ago."""
    return str(int(now_ns - seconds_ago * 1_000_000_000))

def log(seconds_ago: float, level: str, event: str, msg: str, **fields) -> tuple:
    payload = {"level": level, "event": event, "lotteryId": LID, "msg": msg, **fields}
    return (ts(seconds_ago), json.dumps(payload, ensure_ascii=False))

# =============================================================================
# Events ordered from oldest to newest (seconds_ago decreases).
# =============================================================================

entries = [

    # ---- API startup (T-35min) -----------------------------------------------
    log(2100, "info",  "api.keeper_loaded",  "Keeper loaded",
        publicKey="KeeperMock1111111111111111111111111111111111"),
    log(2095, "info",  "api.listening",      "API server listening on port 3000", port=3000),

    # ---- Lottery start (T-30min) ---------------------------------------------
    log(1800, "info",  "lottery.start",      "Lottery started",
        tokens=4, buyConcurrency=50, sendConcurrency=20, sendRounds=10),
    log(1795, "info",  "lottery.prepared",   "Prepared: 15.0 SOL, 24 sends, budget 14.93",
        totalSol=15.0, sendReserve=0.07, buyBudget=14.93, totalSends=24, uniqueRecipients=8),
    log(1794, "info",  "lottery.phase2_start", "Starting parallel buy + send"),

    # ---- Token D — zero budget (T-29min50s) ----------------------------------
    log(1790, "warn",  "lottery.token_skipped_zero_budget", "Token skipped: zero budget",
        mint=MINT_D),

    # ---- Batch init (T-29min) ------------------------------------------------
    log(1780, "info",  "batch.init",         "Batch buy initialized",
        runId=RUN_A, mint=MINT_A, purchases=10, hasAta=True,
        totalFees=0.00021, netAmount=4.999, windowMinutes=50),
    log(1779, "info",  "batch.init",         "Batch buy initialized",
        runId=RUN_B, mint=MINT_B, purchases=5, hasAta=False,
        totalFees=0.00031, netAmount=4.996, windowMinutes=50),

    # ---- Send round 1 (T-28min) ----------------------------------------------
    log(1680, "info",  "send.round_start",   "Send round 1/10", round=1, totalRounds=10),
    log(1679, "debug", "send.carry_forward", "Balance=0, carry forward",
        mint=MINT_A[:8], round=1),

    # ---- Purchases wave 1 (T-27min – T-22min, ~10 events) -------------------
    log(1620, "info",  "purchase.buying",    "Buying 0.499 SOL",
        mint=MINT_A[:8], purchaseIndex=1, solAmount=0.499, slippageBps=300, progress="1/10"),
    log(1615, "info",  "pumpfun.build_info", "Pumpfun buy params calculated",
        mint=MINT_A, pricePerToken=0.0000012, virtualSol=40.1,
        estimatedTokens=391_000, tokenProgram="Classic"),
    log(1610, "info",  "purchase.completed", "Completed via pumpfun",
        mint=MINT_A[:8], purchaseIndex=1, venue="pumpfun", fallback=False,
        signature="4xKp7mNqRsT1abcd", progress="1/10"),

    log(1600, "info",  "purchase.buying",    "Buying 0.501 SOL",
        mint=MINT_A[:8], purchaseIndex=2, solAmount=0.501, slippageBps=300, progress="2/10"),
    # Graduation detected → pre-send error → fallback to DEX
    log(1598, "warn",  "pumpfun.graduation_detected", "Token has graduated",
        mint=MINT_A),
    log(1597, "warn",  "buy.fallback.pumpfun_to_dex", "Pumpfun pre-send failed, switching to DEX",
        mint=MINT_A, reason="Token has graduated (bonding curve complete)"),
    log(1594, "info",  "dex.completed",      "DEX buy completed",
        mint=MINT_A[:8], signature="8yLr2nPsUvW3efgh"),
    log(1592, "info",  "purchase.completed", "Completed via dex (fallback)",
        mint=MINT_A[:8], purchaseIndex=2, venue="dex", fallback=True,
        signature="8yLr2nPsUvW3efgh", progress="2/10"),

    log(1580, "info",  "purchase.buying",    "Buying 0.498 SOL",
        mint=MINT_A[:8], purchaseIndex=3, solAmount=0.498, slippageBps=300, progress="3/10"),
    log(1575, "info",  "pumpfun.build_info", "Pumpfun buy params calculated",
        mint=MINT_A, pricePerToken=0.0000013, tokenProgram="Token-2022"),
    # Simulation failed
    log(1572, "error", "pumpfun.simulation_failed", "Simulation failed",
        mint=MINT_A, err={"InstructionError": [1, "Custom: 30"]}),
    # → slippage retry
    log(1570, "warn",  "purchase.slippage_retry", "Slippage error, instant retry 3.0% → 5.0%",
        mint=MINT_A[:8], purchaseIndex=3, fromBps=300, toBps=500),
    log(1565, "info",  "purchase.completed", "Completed via pumpfun (instant retry)",
        mint=MINT_A[:8], purchaseIndex=3, venue="pumpfun", instantRetry=True,
        signature="2aMs4pQtXzY5ijkl", progress="3/10"),

    log(1550, "info",  "purchase.buying",    "Buying 0.503 SOL",
        mint=MINT_B[:8], purchaseIndex=1, solAmount=0.503, slippageBps=300, progress="1/5"),
    log(1547, "info",  "dex.completed",      "DEX buy completed",
        mint=MINT_B[:8], signature="6bNt5qRuYaZ6mnop"),
    log(1545, "info",  "purchase.completed", "Completed via dex",
        mint=MINT_B[:8], purchaseIndex=1, venue="dex", fallback=False,
        signature="6bNt5qRuYaZ6mnop", progress="1/5"),

    # ---- Send round 2 (T-23min) ----------------------------------------------
    log(1380, "info",  "send.round_start",   "Send round 2/10", round=2, totalRounds=10),
    log(1378, "info",  "send.batch_completed", "Sent 3 recipients for 6tGwYs",
        mint=MINT_A[:8], recipients=3, signature="3cOu6rSvZbA7qrst", round=2, sweep=False),

    # ---- Purchases wave 2 (T-22min – T-17min) --------------------------------
    log(1320, "info",  "purchase.buying",    "Buying 0.497 SOL",
        mint=MINT_A[:8], purchaseIndex=4, solAmount=0.497, slippageBps=300, progress="4/10"),
    # Jupiter no route
    log(1318, "warn",  "dex.no_route",       "No route found for 6tGwYs — no liquidity",
        mint=MINT_A),
    log(1316, "info",  "purchase.deferred_to_retry", "Failed (retryable, will retry)",
        mint=MINT_A[:8], purchaseIndex=4, errorClass="retryable", error="No route found"),

    log(1300, "info",  "purchase.buying",    "Buying 0.502 SOL",
        mint=MINT_A[:8], purchaseIndex=5, solAmount=0.502, slippageBps=300, progress="5/10"),
    # Jupiter quote failed
    log(1298, "error", "dex.quote_failed",   "Jupiter quote failed: 429 Too Many Requests",
        mint=MINT_A, error="Jupiter quote failed: 429"),
    log(1296, "warn",  "purchase.deferred_to_retry", "Failed (retryable, will retry)",
        mint=MINT_A[:8], purchaseIndex=5, errorClass="retryable", error="429 Too Many Requests"),

    log(1280, "info",  "purchase.buying",    "Buying 0.500 SOL",
        mint=MINT_A[:8], purchaseIndex=6, solAmount=0.500, slippageBps=300, progress="6/10"),
    # Swap build failed
    log(1278, "error", "dex.swap_build_failed", "Jupiter swap build failed: 503",
        mint=MINT_A, error="Jupiter swap build failed: 503 Service Unavailable"),
    log(1276, "warn",  "purchase.abandoned_non_retryable", "Abandoned (non-retryable: insufficient_funds)",
        mint=MINT_A[:8], purchaseIndex=6, errorClass="non-retryable",
        pattern="insufficient_funds", error="insufficient lamports"),

    log(1260, "info",  "purchase.buying",    "Buying 0.499 SOL",
        mint=MINT_A[:8], purchaseIndex=7, solAmount=0.499, slippageBps=300, progress="7/10"),
    # DEX timeout
    log(1258, "warn",  "dex.timeout",        "Request timeout after 30000ms", mint=MINT_A),
    log(1256, "warn",  "purchase.deferred_to_retry", "Failed (retryable, will retry)",
        mint=MINT_A[:8], purchaseIndex=7, errorClass="retryable", error="timeout"),

    log(1240, "info",  "purchase.buying",    "Buying 0.501 SOL",
        mint=MINT_A[:8], purchaseIndex=8, solAmount=0.501, slippageBps=300, progress="8/10"),
    # PostSendError → on_chain_failure
    log(1238, "error", "pumpfun.on_chain_failure", "Transaction failed on-chain",
        mint=MINT_A, signature="5dPv7sTwAcB8uvwx",
        err={"InstructionError": [0, "Custom: 6001"]}),
    log(1236, "error", "pumpfun.send_failed", "Transaction send/confirm failed",
        mint=MINT_A, signature="5dPv7sTwAcB8uvwx", error="Transaction failed on-chain"),

    log(1220, "info",  "purchase.buying",    "Buying 0.497 SOL",
        mint=MINT_A[:8], purchaseIndex=9, solAmount=0.497, slippageBps=300, progress="9/10"),
    # DEX on-chain failure
    log(1218, "error", "dex.on_chain_failure", "DEX transaction failed on-chain",
        mint=MINT_A, signature="9eQw8uXyBdC9yzab",
        err={"InstructionError": [2, "Custom: 6002"]}),
    log(1216, "warn",  "purchase.deferred_to_retry", "Failed (unknown error, will retry)",
        mint=MINT_A[:8], purchaseIndex=9, errorClass="unknown",
        error="Transaction confirmed but failed on-chain"),

    log(1200, "info",  "purchase.buying",    "Buying 0.503 SOL",
        mint=MINT_A[:8], purchaseIndex=10, solAmount=0.503, slippageBps=300, progress="10/10"),
    log(1195, "info",  "purchase.completed", "Completed via pumpfun",
        mint=MINT_A[:8], purchaseIndex=10, venue="pumpfun", fallback=False,
        signature="1fRx9vYzCeD0abcd", progress="10/10"),

    # ---- Send rounds 3-6 (T-20min – T-12min) --------------------------------
    log(1200, "info",  "send.round_start",   "Send round 3/10", round=3, totalRounds=10),
    log(1198, "info",  "send.batch_completed", "Sent 2 recipients for 6tGwYs",
        mint=MINT_A[:8], recipients=2, signature="2gSy0wZaDfE1bcde", round=3, sweep=False),

    log(1000, "info",  "send.round_start",   "Send round 4/10", round=4, totalRounds=10),
    log(998,  "warn",  "send.ata_mismatch_blocked", "ATA mismatch blocked (< 0.5 SOL)",
        mint=MINT_B[:8], recipient="3hTz1xAbEgF2", betSol=0.3),
    log(995,  "info",  "send.batch_completed", "Sent 1 recipient for 7uHxZt",
        mint=MINT_B[:8], recipients=1, signature="4hTz1xAbEgF2cdef", round=4, sweep=False),

    log(800,  "info",  "send.round_start",   "Send round 5/10", round=5, totalRounds=10),
    # Compute limit split
    log(798,  "warn",  "send.compute_limit_split", "Compute limit hit, splitting batch",
        mint=MINT_A[:8], batchSize=5),
    log(796,  "info",  "send.batch_completed", "Sent 3 recipients for 6tGwYs",
        mint=MINT_A[:8], recipients=3, signature="5iUa2yBcFhG3defg", round=5, sweep=False),

    log(600,  "info",  "send.round_start",   "Send round 6/10", round=6, totalRounds=10),
    # Batch send failed (retryable → pending)
    log(598,  "warn",  "send.batch_failed",  "Failed batch for 7uHxZt: 429 Too Many Requests",
        mint=MINT_B[:8], recipients=2, errorClass="retryable",
        error="429 Too Many Requests", round=6),

    # ---- Batch retry phase (T-10min) -----------------------------------------
    log(600, "info",  "batch.retry_start",  "Retry buffer: 12 min, 4 failed",
        runId=RUN_A, failedCount=4, failedRate=40, retryWindowMinutes=12),

    # Retry attempt 1 - pending confirmed
    log(590, "info",  "purchase.retry_attempt", "Retry #1, slippage: 3.0%",
        mint=MINT_A[:8], purchaseIndex=4, attempt=1, slippageBps=300),
    log(585, "info",  "purchase.pending_confirmed", "Confirmed from pending tx",
        mint=MINT_A[:8], purchaseIndex=4, signature="6jVb3zCdGiH4efgh", phase="retry"),

    # Retry attempt - success
    log(570, "info",  "purchase.retry_attempt", "Retry #1, slippage: 3.0%",
        mint=MINT_A[:8], purchaseIndex=5, attempt=1, slippageBps=300),
    log(565, "info",  "purchase.retry_success", "Retry succeeded via dex",
        mint=MINT_A[:8], purchaseIndex=5, venue="dex", attempt=1, signature="7kWc4aDeHjI5fghi"),

    # Retry attempt - fail then success
    log(550, "info",  "purchase.retry_attempt", "Retry #1, slippage: 3.0%",
        mint=MINT_A[:8], purchaseIndex=7, attempt=1, slippageBps=300),
    log(548, "warn",  "purchase.retry_failed", "Retry #1 failed (retryable)",
        mint=MINT_A[:8], purchaseIndex=7, attempt=1, errorClass="retryable",
        error="ECONNREFUSED"),
    log(540, "info",  "purchase.retry_attempt", "Retry #2, slippage: 5.0%",
        mint=MINT_A[:8], purchaseIndex=7, attempt=2, slippageBps=500),
    log(535, "info",  "purchase.retry_success", "Retry succeeded via pumpfun",
        mint=MINT_A[:8], purchaseIndex=7, venue="pumpfun", attempt=2, signature="8lXd5bEfIkJ6ghij"),

    # Retry abandon - max attempts
    log(520, "info",  "purchase.retry_attempt", "Retry #1, slippage: 3.0%",
        mint=MINT_A[:8], purchaseIndex=9, attempt=1, slippageBps=300),
    log(518, "warn",  "purchase.retry_failed", "Retry #1 failed (retryable)",
        mint=MINT_A[:8], purchaseIndex=9, attempt=1, errorClass="retryable",
        error="blockhash expired"),
    log(510, "info",  "purchase.retry_attempt", "Retry #2, slippage: 5.0%",
        mint=MINT_A[:8], purchaseIndex=9, attempt=2, slippageBps=500),
    log(508, "warn",  "purchase.abandoned_max_attempts", "Abandoned after 2 attempts",
        mint=MINT_A[:8], purchaseIndex=9, attempts=2, error="blockhash expired"),

    # Retry abandon - window expired
    log(480, "warn",  "purchase.abandoned_window_expired", "Abandoned (retry window expired)",
        mint=MINT_B[:8], purchaseIndex=3),

    # Batch B - slippage retry failed (main loop)
    log(460, "warn",  "purchase.slippage_retry_failed", "Instant retry failed",
        mint=MINT_B[:8], purchaseIndex=2, error="slippage exceeded again"),

    # ---- Batch complete (T-5min) ---------------------------------------------
    log(300, "info",  "batch.complete",      "Batch complete: 8/10, spent 3.994 SOL",
        runId=RUN_A, mint=MINT_A[:8], completed=8, total=10, abandoned=2,
        totalSolSpent=3.994),
    log(299, "info",  "batch.complete",      "Batch complete: 4/5, spent 1.998 SOL",
        runId=RUN_B, mint=MINT_B[:8], completed=4, total=5, abandoned=1,
        totalSolSpent=1.998),
    log(298, "info",  "lottery.token_buy_complete", "Buy complete: 8 purchases",
        mint=MINT_A[:8], completed=8, abandoned=2, solSpent=3.994),
    log(297, "info",  "lottery.token_buy_complete", "Buy complete: 4 purchases",
        mint=MINT_B[:8], completed=4, abandoned=1, solSpent=1.998),

    # Token C — completely failed buy
    log(296, "error", "lottery.token_buy_failed", "Buy failed: RPC unresponsive",
        mint=MINT_C[:8], error="RPC unresponsive after 3 retries"),

    # ---- Send rounds 7-9 (T-4min) -------------------------------------------
    log(240, "info",  "send.round_start",   "Send round 7/10", round=7, totalRounds=10),
    log(238, "info",  "send.batch_completed", "Sent 5 recipients for 6tGwYs",
        mint=MINT_A[:8], recipients=5, signature="9mYe6cFgJlK7hijk", round=7, sweep=False),

    log(180, "info",  "send.round_start",   "Send round 8/10", round=8, totalRounds=10),
    log(178, "info",  "send.batch_completed", "Sent 3 recipients for 7uHxZt",
        mint=MINT_B[:8], recipients=3, signature="0nZf7dGhKmL8ijkl", round=8, sweep=False),

    # Last round retry
    log(120, "info",  "send.round_start",   "Send round 9/10", round=9, totalRounds=10),
    log(118, "info",  "send.last_round_retry_success", "Last round retry succeeded",
        mint=MINT_B[:8], recipients=2, signature="1oAg8eHiLnM9jklm"),

    log(60,  "info",  "send.round_start",   "Send round 10/10", round=10, totalRounds=10),
    log(58,  "info",  "send.batch_completed", "Sent 4 recipients for 6tGwYs",
        mint=MINT_A[:8], recipients=4, signature="2pBh9fIjMoN0klmn", round=10, sweep=False),

    # ---- Sweep phase (T-30s) ------------------------------------------------
    log(35, "info",  "lottery.sweep_start", "Sweep: 1 pending sends (1 reset)",
        pendingCount=1, resetFromAbandoned=1),
    log(30, "info",  "send.sweep_round",    "Sweep send round", round=1, totalRounds=1),
    log(25, "info",  "send.batch_completed", "Sent 1 recipient for 7uHxZt (sweep)",
        mint=MINT_B[:8], recipients=1, signature="3qCi0gJkNpO1lmno", round=1, sweep=True),

    # ---- Lottery complete (T-5s) ---------------------------------------------
    log(5,  "info",  "lottery.complete",   "Lottery complete: 2/4 bought, 18/24 sent",
        tokensBought=2, tokensTotal=4, tokensFailed=2,
        sendsCompleted=18, sendsTotal=24, sendsAbandoned=4, sendsAtaMismatch=2),
]

# =============================================================================
# SEND TO LOKI
# =============================================================================

def push(values: list) -> None:
    payload = {"streams": [{"stream": STREAM, "values": values}]}
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        LOKI_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        print(f"\n✗ HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"\n✗ Failed to connect to Loki: {e.reason}", file=sys.stderr)
        print("  Run: docker-compose up -d loki grafana", file=sys.stderr)
        sys.exit(1)


if STREAM_MODE:
    print(f"Streaming {len(entries)} events to Loki (about 2 seconds apart)...")
    print(f"URL: {LOKI_URL}")
    print("Press Ctrl+C to stop\n")
    for i, (_, line) in enumerate(entries):
        # Send each event with the current timestamp.
        now = str(int(time.time() * 1e9))
        push([[now, line]])
        evt = json.loads(line).get("event", "?")
        lvl = json.loads(line).get("level", "?")
        print(f"  [{i+1:02d}/{len(entries)}] {lvl:5s}  {evt}")
        if i < len(entries) - 1:
            time.sleep(2)
    print("\nDone. Open Grafana: http://localhost:3001 -> Buyer Overview")
else:
    payload_values = [[t, line] for t, line in entries]
    print(f"Sending {len(entries)} events to Loki...")
    print(f"URL: {LOKI_URL}")
    push(payload_values)
    print("✓ OK - logs sent")
    print("\nOpen Grafana: http://localhost:3001")
    print("  Dashboards → Buyer Overview → Last 1 hour")
