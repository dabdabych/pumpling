"""The purchase feed passes deliveries and burns through, and drops what is malformed.

The buyer's feed is the input here (`offchain/api/purchaseFeed.ts`). The page
builds its three kinds of rows from this response, so a field that goes missing
here goes missing on the page.
"""
from __future__ import annotations


import pytest

from presentation.lottery import lottery_router as router

MINT_A = "MintA11111111111111111111111111111111111111"
MINT_B = "MintB11111111111111111111111111111111111111"


def feed() -> dict:
    return {
        "lotteryId": "7",
        "summary": {"finishedAt": None},
        "phase": "buying",
        "tokens": [
            {
                "mint": MINT_A, "status": "in_progress", "targetSol": 2.0, "spentSol": 1.0,
                "plannedPurchases": 4, "completedPurchases": 2, "decimals": 6, "burnBps": 2500,
                "burn": {"boughtRaw": "1000", "owedRaw": "250", "burnedRaw": "200",
                         "supplyAtStart": "1000000", "blockedReason": "the coin's mint is paused"},
            },
            {"mint": MINT_B, "status": "completed", "targetSol": 1.0, "spentSol": 1.0,
             "plannedPurchases": 1, "completedPurchases": 1, "burnBps": 0},
        ],
        "purchases": [{"mint": MINT_A, "index": 1, "solAmount": 0.5, "signature": "buy1", "venue": "pumpfun", "at": 1_790_000_000_000}],
        "deliveries": [
            {"mint": MINT_A, "signature": "tx1", "rawAmount": "150", "recipients": ["W1", "W2"], "at": 1_790_000_100_000},
            {"mint": MINT_A, "signature": "", "rawAmount": "1", "recipients": [], "at": 1},
            {"mint": MINT_A, "signature": "tx2", "rawAmount": "1.5", "recipients": [], "at": 1},
        ],
        "burns": [
            {"mint": MINT_A, "signature": "burn1", "rawAmount": "200", "at": 1_790_000_200_000},
            {"mint": MINT_A, "signature": "burn2", "rawAmount": "-5", "at": 1},
        ],
        "totals": {"targetSol": 3.0, "spentSol": 2.0, "plannedPurchases": 5, "completedPurchases": 3},
    }


@pytest.fixture(autouse=True)
def stubs(monkeypatch):
    monkeypatch.setattr(router, "_get_coin_metadata", lambda db, mint: (f"Coin {mint[:5]}", mint[:4].upper(), None))


def _get(monkeypatch, payload):
    monkeypatch.setattr(router, "_cached_purchase_feed", lambda lottery_id: payload)
    # A plain function now, run in FastAPI's thread pool (tests/test_event_loop_free.py).
    return router.get_lottery_purchases(7, db=None)


def test_deliveries_and_burns_come_through_with_the_coin_they_belong_to(monkeypatch):
    response = _get(monkeypatch, feed())
    assert [d.signature for d in response.deliveries] == ["tx1"]
    delivery = response.deliveries[0]
    assert (delivery.raw_amount, delivery.decimals, delivery.recipients, delivery.symbol) == ("150", 6, ["W1", "W2"], "MINT")
    assert [b.signature for b in response.burns] == ["burn1"]
    assert response.burns[0].raw_amount == "200"


def test_the_coin_carries_its_burn(monkeypatch):
    coins = {coin.mint: coin for coin in _get(monkeypatch, feed()).coins}
    a, b = coins[MINT_A], coins[MINT_B]
    assert a.decimals == 6 and a.burn_bps == 2500
    assert a.burn.owed_raw == "250" and a.burn.burned_raw == "200" and a.burn.supply_at_end is None
    assert a.burn.blocked_reason == "the coin's mint is paused"
    assert b.burn is None and b.decimals is None


def test_a_feed_from_before_the_burn_still_reads(monkeypatch):
    payload = feed()
    for key in ("deliveries", "burns"):
        payload.pop(key)
    for token in payload["tokens"]:
        for key in ("decimals", "burnBps", "burn"):
            token.pop(key, None)
    response = _get(monkeypatch, payload)
    assert response.deliveries == [] and response.burns == []
    assert all(coin.burn is None and coin.burn_bps == 0 for coin in response.coins)


def test_a_half_written_burn_block_is_dropped_not_guessed(monkeypatch):
    payload = feed()
    payload["tokens"][0]["burn"] = {"boughtRaw": "1000", "owedRaw": None, "burnedRaw": "0"}
    assert _get(monkeypatch, payload).coins[0].burn is None


def test_refunds_come_through_and_junk_is_dropped(monkeypatch):
    payload = feed()
    payload["refunds"] = [
        {"mint": MINT_A, "signature": "ref1", "sol": 0.4825, "recipients": ["W1", "W2"], "at": 1_790_000_300_000},
        {"mint": MINT_A, "signature": "", "sol": 0.1, "recipients": [], "at": 1},
        {"mint": MINT_A, "signature": "ref2", "sol": "junk", "recipients": [], "at": 1},
        {"mint": MINT_A, "signature": "ref3", "sol": 0, "recipients": [], "at": 1},
    ]
    response = _get(monkeypatch, payload)
    assert [r.signature for r in response.refunds] == ["ref1"]
    refund = response.refunds[0]
    assert (refund.sol_amount, refund.recipients, refund.symbol) == (0.4825, ["W1", "W2"], "MINT")


def test_a_feed_without_refunds_still_reads(monkeypatch):
    assert _get(monkeypatch, feed()).refunds == []
