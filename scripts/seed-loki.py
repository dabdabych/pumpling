#!/usr/bin/env python3
"""Seed Loki with synthetic buyer logs so Grafana dashboards have data to draw."""
import json
import random
import time
import urllib.request

LOKI_URL = "http://localhost:3100/loki/api/v1/push"
LABELS = {"container_name": "lottery-buyer"}

EVENTS = [
    # (event, level, weight, extra fields)
    ("purchase.completed", "info", 40, {"venue": "pumpfun", "fallback": "false"}),
    ("purchase.completed", "info", 25, {"venue": "dex", "fallback": "false"}),
    ("purchase.completed", "info", 8, {"venue": "dex", "fallback": "true"}),
    ("purchase.retry_attempt", "warn", 12, {}),
    ("purchase.retry_success", "info", 8, {}),
    ("purchase.retry_failed", "warn", 4, {}),
    ("purchase.slippage_retry", "warn", 6, {}),
    ("purchase.abandoned_non_retryable", "error", 2, {}),
    ("purchase.abandoned_max_attempts", "error", 3, {}),
    ("purchase.abandoned_window_expired", "error", 2, {}),
    ("purchase.pending_confirmed", "info", 5, {}),
    ("buy.fallback.pumpfun_to_dex", "warn", 5, {}),
    ("pumpfun.graduation_detected", "info", 3, {}),
    ("pumpfun.send_failed", "error", 3, {}),
    ("pumpfun.simulation_failed", "error", 2, {}),
    ("pumpfun.on_chain_failure", "error", 2, {}),
    ("dex.on_chain_failure", "error", 2, {}),
    ("dex.no_route", "warn", 3, {}),
    ("dex.quote_failed", "warn", 2, {}),
    ("dex.swap_build_failed", "error", 1, {}),
    ("dex.timeout", "warn", 2, {}),
    ("lottery.start", "info", 4, {}),
    ("lottery.complete", "info", 3, {}),
    ("lottery.token_buy_complete", "info", 30, {}),
    ("lottery.token_buy_failed", "error", 4, {}),
    ("lottery.token_skipped_zero_budget", "warn", 2, {}),
    ("batch.init", "info", 8, {}),
    ("batch.retry_start", "info", 3, {}),
    ("batch.complete", "info", 8, {}),
    ("api.keeper_loaded", "info", 1, {}),
    ("api.listening", "info", 1, {}),
    ("api.lottery_completed", "info", 4, {}),
    ("api.lottery_failed", "error", 1, {}),
    ("send.batch_failed", "error", 3, {}),
    ("send.batch_completed", "info", 25, {}),
    ("send.round_empty", "info", 8, {}),
    ("send.round_start", "info", 10, {}),
    ("send.sweep_round", "info", 2, {}),
    ("send.carry_forward", "debug", 6, {}),
    ("send.last_round_retry_success", "info", 2, {}),
    ("send.ata_mismatch_blocked", "error", 1, {}),
    ("send.compute_limit_split", "warn", 2, {}),
]

WINDOW_SECONDS = 30 * 60  # last 30 minutes
TOTAL_LINES = 600


def pick_event():
    total = sum(w for _, _, w, _ in EVENTS)
    r = random.uniform(0, total)
    acc = 0
    for ev, lvl, w, extra in EVENTS:
        acc += w
        if r <= acc:
            return ev, lvl, extra
    return EVENTS[0][0], EVENTS[0][1], EVENTS[0][3]


def build_payload():
    now_ns = int(time.time() * 1e9)
    window_ns = WINDOW_SECONDS * int(1e9)
    values = []
    for _ in range(TOTAL_LINES):
        ts_ns = now_ns - random.randint(0, window_ns)
        event, level, extra = pick_event()
        entry = {
            "level": level,
            "event": event,
            "mint": f"Mint{random.randint(1000, 9999)}",
            "amount_sol": round(random.uniform(0.01, 0.5), 4),
            **extra,
            "msg": event,
        }
        values.append([str(ts_ns), json.dumps(entry)])
    values.sort(key=lambda v: int(v[0]))
    return {"streams": [{"stream": LABELS, "values": values}]}


def main():
    payload = build_payload()
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        LOKI_URL, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req) as resp:
        print(f"Loki responded {resp.status} — pushed {TOTAL_LINES} lines")


if __name__ == "__main__":
    main()
