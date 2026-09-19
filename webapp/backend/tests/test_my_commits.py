"""My commits: a person has to see themselves, and only themselves.

The personal history screen is the only place a participant sees that their SOL
is sitting somewhere. Two things the test has to guard: other people's commits
do not appear here, and your own are shown honestly — with the on-chain
signature, your share in the coin, and how much went into buying it.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from application.lottery.schemas import LotteryWinnerResultResponse  # noqa: E402
from presentation.lottery import lottery_router as router  # noqa: E402

NOW = datetime.now(timezone.utc)
MINT_A = "MintA11111111111111111111111111111111111111"
MINT_B = "MintB11111111111111111111111111111111111111"


class FakeBet:
    def __init__(self, user_id, lottery_id, mint, sol, wallet="Wal1et1111111111111111111111111111111111111", signature=None):
        self.user_id = user_id
        self.lottery_id = lottery_id
        self.meme_coin_address = mint
        self.sol_amount = sol
        self.wallet_address = wallet
        self.tx_signature = signature
        self.created_at = NOW


class FakeLotteryRow:
    def __init__(self, lottery_id):
        self.id = lottery_id
        self.lottery_type = "dex"
        self.status = "closed"
        self.created_at = NOW - timedelta(hours=3)
        self.end_date = NOW - timedelta(hours=1)
        self.vrf_seed = "seed"


class FakeQuery:
    """Answers three queries: my commits, the per-coin totals, the rounds."""

    def __init__(self, session, kind):
        self.session = session
        self.kind = kind
        self.lottery_id = None

    def filter(self, *conditions):
        # The round number is pulled out of the condition: it matters in the per-coin total.
        for condition in conditions:
            right = getattr(getattr(condition, "right", None), "value", None)
            if isinstance(right, int) and right in self.session.lottery_ids:
                self.lottery_id = right
        return self

    def order_by(self, *_):
        return self

    def group_by(self, *_):
        return self

    def all(self):
        if self.kind == "bets":
            return [bet for bet in self.session.bets if bet.user_id == self.session.user_id]
        if self.kind == "sums":
            totals: dict[str, float] = {}
            for bet in self.session.bets:
                if self.lottery_id is not None and bet.lottery_id != self.lottery_id:
                    continue
                totals[bet.meme_coin_address] = totals.get(bet.meme_coin_address, 0.0) + bet.sol_amount
            return list(totals.items())
        return [FakeLotteryRow(lottery_id) for lottery_id in self.session.lottery_ids]


class FakeSession:
    def __init__(self, bets, user_id):
        self.bets = bets
        self.user_id = user_id
        self.lottery_ids = sorted({bet.lottery_id for bet in bets}, reverse=True)

    def query(self, *entities):
        first = entities[0]
        if len(entities) > 1:
            return FakeQuery(self, "sums")
        name = getattr(first, "__name__", "")
        if name == "BetParticipationModel":
            return FakeQuery(self, "bets")
        return FakeQuery(self, "lotteries")


@pytest.fixture(autouse=True)
def stub_helpers(monkeypatch):
    monkeypatch.setattr(router, "_get_coin_metadata", lambda db, mint: (f"Coin {mint[:5]}", mint[:4].upper(), None))
    monkeypatch.setattr(
        router,
        "_build_lottery_winner_results",
        lambda db, lottery: [LotteryWinnerResultResponse(mint=MINT_A, wins=30, target_lamports=2_910_000_000, target_sol=2.91)],
    )


def _commits(session, user_id=1):
    return asyncio.run(router.get_my_commits(db=session, current_user_id=user_id))


def test_only_my_commits_are_returned():
    bets = [
        FakeBet(1, 128, MINT_A, 0.5, signature="sig-mine"),
        FakeBet(2, 128, MINT_A, 9.5, signature="sig-someone-else"),
    ]
    result = _commits(FakeSession(bets, user_id=1))

    assert result.total_sol == 0.5
    coin = result.rounds[0].coins[0]
    assert coin.my_sol == 0.5
    assert coin.signatures == ["sig-mine"]
    # Other people's money is only visible in the coin's total, with no names.
    assert coin.pool_sol == 10.0


def test_my_share_and_draw_are_shown():
    bets = [FakeBet(1, 128, MINT_A, 2.0, signature="sig-1"), FakeBet(1, 128, MINT_A, 1.0, signature="sig-2")]
    result = _commits(FakeSession(bets, user_id=1))

    coin = result.rounds[0].coins[0]
    assert coin.my_sol == 3.0
    assert coin.my_commits == 2
    assert coin.signatures == ["sig-1", "sig-2"]
    assert coin.drawn_sol == 2.91


def test_coins_are_sorted_by_my_stake():
    bets = [
        FakeBet(1, 128, MINT_A, 0.5),
        FakeBet(1, 128, MINT_B, 4.0),
    ]
    result = _commits(FakeSession(bets, user_id=1))

    assert [coin.mint for coin in result.rounds[0].coins] == [MINT_B, MINT_A]
    assert result.rounds[0].my_sol == 4.5


def test_rounds_are_listed_newest_first_and_capped(monkeypatch):
    monkeypatch.setattr(router, "MY_COMMITS_MAX_ROUNDS", 2)
    bets = [FakeBet(1, lottery_id, MINT_A, 1.0) for lottery_id in (130, 129, 128)]

    result = _commits(FakeSession(bets, user_id=1))

    assert [item.lottery_id for item in result.rounds] == [130, 129]


def test_wallets_are_listed_once():
    bets = [
        FakeBet(1, 128, MINT_A, 1.0, wallet="WalletOne"),
        FakeBet(1, 128, MINT_B, 1.0, wallet="WalletOne"),
        FakeBet(1, 128, MINT_B, 1.0, wallet="WalletTwo"),
    ]
    result = _commits(FakeSession(bets, user_id=1))

    assert result.rounds[0].wallets == ["WalletOne", "WalletTwo"]


def test_a_person_without_commits_gets_an_empty_answer():
    result = _commits(FakeSession([], user_id=7))

    assert result.total_sol == 0
    assert result.rounds == []
