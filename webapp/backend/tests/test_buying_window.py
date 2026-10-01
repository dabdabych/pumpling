"""The buying window, the second pass, and when a round is allowed to close.

The buyer spends fifty minutes on its main pass. Whatever it could not buy in
that time it buys again afterwards, in a window it sizes itself from the number
of purchases that have to be repeated: three minutes at the least, fifteen at
the most. A round where everything went through has no second pass at all.

Round 1790348400190 on mainnet, 2026-09-25, is what this is written against:
one purchase of twenty-nine expired on the way and was bought in the second
pass. Nothing outside the buyer knew that had happened. The page counted down a
fixed window of fifty-five minutes, which was neither number, and the round was
closed on that clock whatever the buyer was doing.

Two things follow, and both are checked here. The site's window has to be the
buyer's window, or the page tells people the buying is over while purchases are
still going out. And the pause before the next pool has to run from the moment
the round actually closed, not from arithmetic on when the buying started — a
round that needed the extra fifteen minutes closes fifteen minutes later, and
by the old arithmetic its pause would already be over.
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(_ROOT, "workers"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

import lottery_phase_worker as worker  # noqa: E402
from shared.settings import (  # noqa: E402
    _default_execution_countdown_seconds,
    _default_fallback_countdown_seconds,
)

NOW = datetime(2026, 9, 25, 16, 20, tzinfo=timezone.utc)


def _read(relative_path: str) -> str:
    with open(os.path.join(_ROOT, relative_path), encoding="utf-8") as handle:
        return handle.read()


class TestTheWindowIsTheBuyersWindow:
    """Two numbers in two languages that have to be the same number."""

    def test_the_main_window_is_the_buyers_main_pass(self):
        source = _read("offchain/orchestrator/orchestrator.ts")
        match = re.search(r'envNumber\("BUY_WINDOW_MINUTES",\s*(\d+)\)', source)
        assert match, "the buyer no longer declares BUY_WINDOW_MINUTES this way"

        assert _default_execution_countdown_seconds("mainnet") == int(match.group(1)) * 60

    def test_the_second_pass_is_the_buyers_retry_cap(self):
        source = _read("offchain/scheduler/batch.ts")
        match = re.search(r"MAX_RETRY_WINDOW_MINUTES\s*=\s*(\d+)", source)
        assert match, "the buyer no longer declares MAX_RETRY_WINDOW_MINUTES this way"

        assert _default_fallback_countdown_seconds("mainnet") == int(match.group(1)) * 60

    def test_a_pool_takes_commits_for_seventy_minutes(self):
        # "1 hour" on the site; 70 minutes, the same on both networks.
        from shared.settings import _default_autostart_prediction_seconds

        assert _default_autostart_prediction_seconds("mainnet") == 70 * 60
        assert _default_autostart_prediction_seconds("devnet") == 70 * 60

    def test_devnet_is_shorter_but_still_has_one(self):
        # A devnet round exists to be watched end to end in a few minutes, and
        # a second pass that never runs is a path nobody would ever test.
        assert _default_execution_countdown_seconds("devnet") == 15 * 60
        assert 0 < _default_fallback_countdown_seconds("devnet") < _default_fallback_countdown_seconds("mainnet")


class FakeLottery:
    def __init__(self, lottery_id: int = 1790348400190):
        self.id = lottery_id


class TestWhenARoundMayClose:
    """The buying is over at one of two moments, and only the buyer knows which."""

    @pytest.fixture(autouse=True)
    def forget_the_last_answer(self):
        # The worker holds the buyer's answer for a few seconds so a loop that
        # runs every second does not ask nine hundred times. Each case here is
        # a different answer about the same round.
        worker._buyer_phase_cache.clear()
        yield
        worker._buyer_phase_cache.clear()

    def close_due(self, monkeypatch, payload, *, at_seconds: float) -> bool:
        """`at_seconds` is measured from the moment the buying started."""
        class Client:
            def fetch_purchases(self, lottery_id):
                if isinstance(payload, Exception):
                    raise payload
                return payload

        monkeypatch.setattr(worker, "build_offchain_api_client", lambda: Client())
        # Each call is a different answer about the same round, and the worker
        # holds the last one for a few seconds.
        worker._buyer_phase_cache.clear()
        return asyncio.run(
            worker._close_is_due(FakeLottery(), NOW, NOW + timedelta(seconds=at_seconds))
        )

    @property
    def window(self):
        settings = worker._settings()
        return (
            settings.execution_countdown_seconds,
            settings.fallback_countdown_seconds,
        )

    def test_not_while_the_main_window_still_runs(self, monkeypatch):
        main, _fallback = self.window
        assert self.close_due(monkeypatch, {"phase": "buying"}, at_seconds=main - 60) is False

    def test_not_before_the_window_ends_even_when_the_buyer_says_it_is_done(self, monkeypatch):
        main, _fallback = self.window
        # The round used to close up to five minutes early on this word, and
        # the word was false at the start of every round (2026-09-29). The end
        # of the window is public; nothing the buyer says brings it forward.
        for at_seconds in (1, 60, main - 5 * 60 + 1, main - 60, main - 1):
            assert self.close_due(monkeypatch, {"phase": "finished"}, at_seconds=at_seconds) is False, at_seconds
            assert self.close_due(monkeypatch, None, at_seconds=at_seconds) is False, at_seconds

    def test_on_time_when_the_buyer_is_done(self, monkeypatch):
        main, _fallback = self.window
        assert self.close_due(monkeypatch, {"phase": "finished"}, at_seconds=main) is True

    def test_the_second_pass_holds_the_round_open(self, monkeypatch):
        main, fallback = self.window

        assert self.close_due(monkeypatch, {"phase": "fallback"}, at_seconds=main + 60) is False
        assert self.close_due(monkeypatch, {"phase": "fallback"}, at_seconds=main + fallback - 1) is False

    def test_but_not_past_the_ceiling(self, monkeypatch):
        main, fallback = self.window
        # A buyer stuck in a loop must not be able to hold a public round open.
        assert self.close_due(monkeypatch, {"phase": "fallback"}, at_seconds=main + fallback) is True

    def test_a_finished_buyer_closes_the_round(self, monkeypatch):
        main, _fallback = self.window
        assert self.close_due(monkeypatch, {"phase": "finished"}, at_seconds=main + 60) is True

    def test_a_main_pass_still_finishing_holds_the_round_open(self, monkeypatch):
        main, fallback = self.window
        # The buyer's window starts a moment after the one counted here, and
        # its last purchase can be on its way for up to two minutes when the
        # clock runs out. Closing then put "This pool is done" over purchases
        # that were still going out.
        assert self.close_due(monkeypatch, {"phase": "buying"}, at_seconds=main) is False
        assert self.close_due(monkeypatch, {"phase": "buying"}, at_seconds=main + 60) is False
        assert self.close_due(monkeypatch, {"phase": "buying"}, at_seconds=main + fallback - 1) is False

    def test_and_under_the_same_ceiling(self, monkeypatch):
        main, fallback = self.window
        assert self.close_due(monkeypatch, {"phase": "buying"}, at_seconds=main + fallback) is True

    def test_an_answer_we_did_not_expect_closes_it(self, monkeypatch):
        main, _fallback = self.window
        assert self.close_due(monkeypatch, {"phase": "paused"}, at_seconds=main + 60) is True

    def test_and_so_does_silence(self, monkeypatch):
        main, _fallback = self.window
        assert self.close_due(monkeypatch, None, at_seconds=main + 60) is True
        assert self.close_due(monkeypatch, RuntimeError("connection refused"), at_seconds=main + 60) is True

    def test_rubbish_is_silence(self, monkeypatch):
        main, _fallback = self.window
        assert self.close_due(monkeypatch, {"phase": 12}, at_seconds=main + 60) is True
        assert self.close_due(monkeypatch, "<html>502</html>", at_seconds=main + 60) is True


class TestThePauseRunsFromTheClose:
    """`_next_pool_at`: the countdown people watch between rounds."""

    def next_pool_at(self, closed_at):
        from presentation.lottery.lottery_router import _next_pool_at

        return _next_pool_at(NOW, closed_at)

    def test_from_the_moment_it_closed(self):
        from shared.settings import get_settings

        closed_at = NOW + timedelta(minutes=63)
        gap = get_settings().lottery_autostart_gap_seconds

        assert self.next_pool_at(closed_at) == closed_at + timedelta(seconds=gap)

    def test_without_it_the_ceiling_stands_in(self):
        from shared.settings import get_settings

        settings = get_settings()
        expected = NOW + timedelta(
            seconds=settings.execution_countdown_seconds
            + settings.fallback_countdown_seconds
            + settings.lottery_autostart_gap_seconds
        )

        # A round from before the column, or one closed by something that did
        # not record the moment. The ceiling is late rather than early: a
        # countdown that has already expired while no pool opens is the worse
        # of the two.
        assert self.next_pool_at(None) == expected

    def test_the_moment_reaches_the_page(self):
        """`/lottery/current` reads rounds through the repository, as entities.

        The entity had no `closed_at`, so the router's `getattr(..., None)` was
        always None and every countdown used the ceiling: fifteen minutes past
        the moment the worker actually opened the next pool, on every round.
        """
        from domain.lottery.entities.lottery import LotteryStatus
        from infrastructure.database.models.lottery_model import LotteryModel
        from infrastructure.lottery.database_lottery_repository import DatabaseLotteryRepository
        from presentation.lottery.lottery_router import _next_pool_at
        from shared.settings import get_settings

        closed_at = NOW + timedelta(minutes=52)
        model = LotteryModel(
            id=1790708345700, name="pool", created_by_user_id=1, created_at=NOW - timedelta(hours=2),
            status=LotteryStatus.CLOSED, lottery_type="dex", proceeding_purchases_started_at=NOW, closed_at=closed_at,
        )
        entity = DatabaseLotteryRepository(db=None)._model_to_entity(model)

        assert entity.closed_at == closed_at
        gap = get_settings().lottery_autostart_gap_seconds
        assert _next_pool_at(entity.proceeding_purchases_started_at, entity.closed_at) == closed_at + timedelta(seconds=gap)
