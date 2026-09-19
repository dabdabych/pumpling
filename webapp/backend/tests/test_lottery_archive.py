"""The round archive: what makes it into the history and what does not.

While there are few participants a round still opens every few hours, and most
of them close empty. Showing those in the history is not an option: the page
would become a list of zeros with no live round visible. We check that empty
ones are hidden by default and that they can still be asked for explicitly.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from application.lottery.schemas import LotteryArchiveEntryResponse  # noqa: E402
from presentation.lottery import lottery_router as router  # noqa: E402

NOW = datetime.now(timezone.utc)


class FakeLottery:
    def __init__(self, lottery_id: int, sol: float):
        self.id = lottery_id
        self.sol = sol
        self.lottery_type = "dex"
        self.status = "closed"
        self.lottery_pda = f"pda{lottery_id}"
        self.created_at = NOW - timedelta(hours=lottery_id)
        self.end_date = NOW - timedelta(hours=lottery_id)
        self.close_reason = None
        self.initialize_abandoned_at = None
        self.initialize_abandoned_error = None


class FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def filter(self, *_):
        return self

    def order_by(self, *_):
        return self

    def all(self):
        return self._rows


class FakeSession:
    def __init__(self, rows):
        self._rows = rows

    def query(self, *_):
        return FakeQuery(self._rows)


@pytest.fixture
def rounds(monkeypatch):
    """Three rounds: two with money, one empty."""
    rows = [FakeLottery(1, 12.5), FakeLottery(2, 0.0), FakeLottery(3, 4.0)]

    monkeypatch.setattr(router, "_build_archive_close_event_map", lambda db, models: {})
    monkeypatch.setattr(router, "_resolve_archive_ended_at", lambda lottery, events: (lottery.end_date, "end_date"))
    monkeypatch.setattr(router, "_resolve_archive_started_at", lambda lottery: lottery.created_at)
    monkeypatch.setattr(router, "_build_lottery_winner_results", lambda db, lottery: [])
    monkeypatch.setattr(
        router,
        "_build_lottery_archive_entries",
        lambda db, lottery, winners: (
            []
            if lottery.sol <= 0
            else [
                LotteryArchiveEntryResponse(
                    rank=1,
                    mint=f"mint{lottery.id}",
                    name="Coin",
                    ticker="COIN",
                    total_solana_bet=lottery.sol,
                    won_sol=lottery.sol * 0.97,
                )
            ]
        ),
    )
    return FakeSession(rows)


def _archive(session, **kwargs):
    # We call the function directly, so we supply the defaults ourselves:
    # FastAPI would only substitute them from Query on a real request.
    params = {"lottery_type": "dex", "include_empty": False, "window_days": 7}
    params.update(kwargs)
    return asyncio.run(router.get_lottery_archive(db=session, **params))


def test_empty_rounds_are_hidden(rounds):
    result = _archive(rounds)

    assert [item.id for item in result.items] == [1, 3], "an empty round must not reach the history"
    assert all(item.total_pool_sol > 0 for item in result.items)


def test_empty_rounds_can_be_asked_for(rounds):
    result = _archive(rounds, include_empty=True)

    assert [item.id for item in result.items] == [1, 2, 3]


def test_window_is_reported_back(rounds):
    result = _archive(rounds, window_days=30)

    assert result.window_days == 30
    assert result.lottery_type == "dex"


def test_archive_is_capped(monkeypatch, rounds):
    monkeypatch.setattr(router, "ARCHIVE_MAX_ITEMS", 2)
    many = FakeSession([FakeLottery(index, 5.0) for index in range(1, 10)])

    result = _archive(many)

    assert len(result.items) == 2, "the history comes in pages, not all at once"
