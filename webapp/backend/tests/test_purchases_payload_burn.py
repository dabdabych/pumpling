"""The buyer payload carries each wallet's exact stake and burn weight.

Checked against the contract file the buyer's own tests read
(`offchain/tests/unit/fixtures/payload-contract.json`): the backend must build
exactly those recipients from those bets, and the buyer must accept them.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from shared.purchases_payload import recipients_for

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[3] / "offchain" / "tests" / "unit" / "fixtures" / "payload-contract.json").read_text()
)


def _bets(rows=None):
    return [
        SimpleNamespace(meme_coin_address=CONTRACT["mint"], wallet_address=row["wallet"], sol_amount=row["sol"], burn_bps=row["burn_bps"])
        for row in (rows or CONTRACT["bets"])
    ]


def test_the_backend_builds_exactly_the_contract():
    assert recipients_for(CONTRACT["mint"], _bets()) == CONTRACT["recipients"]


def test_two_commits_of_one_wallet_keep_their_own_choices_exactly():
    # 1 SOL at 0% and 2 SOL at 50%: a third of the wallet's share, to the
    # lamport, rather than an average rounded to whole basis points.
    first = next(r for r in recipients_for(CONTRACT["mint"], _bets()) if r["publickey"] == CONTRACT["bets"][0]["wallet"])
    assert int(first["burnWeight"]) * 3 == int(first["amountLamports"]) * 10_000


def test_a_commit_recorded_before_the_column_existed_burns_nothing():
    old = [SimpleNamespace(meme_coin_address=CONTRACT["mint"], wallet_address="w", sol_amount=0.5)]
    assert recipients_for(CONTRACT["mint"], old) == [
        {"publickey": "w", "amount": 0.5, "amountLamports": "500000000", "burnBps": 0.0, "burnWeight": "0"}
    ]


def test_other_coins_and_empty_commits_are_left_out():
    bets = _bets() + [
        SimpleNamespace(meme_coin_address="other", wallet_address="x", sol_amount=5.0, burn_bps=0),
        SimpleNamespace(meme_coin_address=CONTRACT["mint"], wallet_address="y", sol_amount=0.0, burn_bps=0),
    ]
    assert recipients_for(CONTRACT["mint"], bets) == CONTRACT["recipients"]


def test_a_value_out_of_range_is_clamped_not_passed_on():
    bets = [SimpleNamespace(meme_coin_address="m", wallet_address="w", sol_amount=1.0, burn_bps=20_000)]
    assert recipients_for("m", bets)[0]["burnWeight"] == str(1_000_000_000 * 10_000)
