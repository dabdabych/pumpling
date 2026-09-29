"""Two ways a coin card came up empty, and stayed that way.

**The chart.** GeckoTerminal is free, has no key and answers in anything from a
fraction of a second to about six. The timeout was six, shared with every other
outside call, so a slow answer was a lost one — and a lost one was remembered
as "no chart" for three minutes. Hovering over the same coin again showed the
same blank.

**The picture.** A coin reaching a round without an image kept a grey circle
for ever. The metadata row existed, so `_get_coin_metadata` returned it and
nothing ever asked the source again. Images do turn up later: a coin launched
minutes before a round often has its picture uploaded after it.

Neither is worth blocking anybody for. A chart already held is served while a
new one is fetched behind the request, and a missing picture is asked about
again now and then rather than never.
"""
from __future__ import annotations

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import coin_chart as chart_module  # noqa: E402
from shared import token_metadata_queue as queue_module  # noqa: E402
from shared.coin_chart import STALE_TTL_SECONDS, coin_chart  # noqa: E402
from shared.settings import get_settings  # noqa: E402

MINT = "56AsKxgMEVXcXSdqgzHHcPGJ7owdJwzfd9GyRvh8pump"
POOL = "HozpRXYtGKPUE1nLPNPPPSbmNmXkAaEWvKnWdcZB3Eo1"


@pytest.fixture(autouse=True)
def clean_caches():
    with chart_module._lock:
        chart_module._cache.clear()
        chart_module._stale.clear()
        chart_module._calls.clear()
        chart_module._inflight.clear()
    yield
    with chart_module._lock:
        chart_module._cache.clear()
        chart_module._stale.clear()
        chart_module._calls.clear()
        chart_module._inflight.clear()


def candles(price: float) -> list[list[float]]:
    """Two minute candles, which is the least a chart can be drawn from."""
    return [[1_790_000_060, price, price, price, price, 1.0],
            [1_790_000_000, price, price, price, price, 1.0]]


class TestTheChartIsNotLostToOneSlowAnswer:
    def test_a_held_chart_is_served_while_a_new_one_is_fetched(self):
        first = coin_chart(MINT, POOL, "pumpswap", timeout_seconds=1, fetcher=lambda *_: candles(1.0))
        assert first.available

        # It goes stale, and the source is now slow enough to have failed before.
        with chart_module._lock:
            chart_module._cache.clear()

        started = threading.Event()
        release = threading.Event()

        def slow(pool_address: str, timeout: float):
            started.set()
            release.wait(timeout=5)
            return candles(2.0)

        served = coin_chart(MINT, POOL, "pumpswap", timeout_seconds=5, fetcher=slow)

        # Answered from the chart we already had, without waiting.
        assert served.available
        assert served.points[0][1] == 1.0
        assert started.wait(timeout=2), "the refresh did not start"
        release.set()

        # And the new one lands, so the next hover has it.
        for _ in range(50):
            if coin_chart(MINT, POOL, "pumpswap", timeout_seconds=5, fetcher=slow).points[0][1] == 2.0:
                break
            time.sleep(0.05)
        assert coin_chart(MINT, POOL, "pumpswap", timeout_seconds=5, fetcher=slow).points[0][1] == 2.0

    def test_a_failure_does_not_push_out_the_chart_we_have(self):
        coin_chart(MINT, POOL, "pumpswap", timeout_seconds=1, fetcher=lambda *_: candles(1.0))
        with chart_module._lock:
            chart_module._cache.clear()

        def broken(pool_address: str, timeout: float):
            raise TimeoutError("the source took too long")

        served = coin_chart(MINT, POOL, "pumpswap", timeout_seconds=1, fetcher=broken)
        assert served.available, "a failed refresh must not blank the card"
        assert served.points[0][1] == 1.0

    def test_with_nothing_held_it_still_answers_rather_than_hangs(self):
        def broken(pool_address: str, timeout: float):
            raise TimeoutError("the source took too long")

        chart = coin_chart(MINT, POOL, "pumpswap", timeout_seconds=1, fetcher=broken)
        assert chart.available is False
        assert chart.points == []

    def test_asking_again_sooner_does_not_reach_the_source_again(self):
        """The front now forgets a blank after eight seconds instead of forty-five.

        That is a question about our own API, not about GeckoTerminal: the
        server remembers a failure for three minutes and answers from that
        memory without going out. Ten hovers in a row are one outside call.
        """
        calls = {"n": 0}

        def counted(pool_address: str, timeout: float):
            calls["n"] += 1
            raise TimeoutError("the source took too long")

        for _ in range(10):
            assert coin_chart(MINT, POOL, "pumpswap", timeout_seconds=1, fetcher=counted).available is False

        assert calls["n"] == 1, "a failure is remembered, not re-asked"

    def test_and_a_coin_with_no_pool_costs_nothing_at_all(self):
        calls = {"n": 0}

        def counted(pool_address: str, timeout: float):
            calls["n"] += 1
            return candles(1.0)

        # No pool address: there is nothing to ask about and we do not ask.
        assert coin_chart(MINT, None, None, timeout_seconds=1, fetcher=counted).available is False
        assert calls["n"] == 0

    def test_our_own_ceiling_is_below_the_sources(self):
        from shared.coin_chart import MAX_CALLS_PER_MINUTE

        # GeckoTerminal's free access is about thirty a minute per address.
        assert MAX_CALLS_PER_MINUTE <= 25

    def test_the_stale_window_is_minutes_not_hours(self):
        # The tooltip prints a price. Three minutes behind on minute candles is
        # a few candles; an hour behind would be a wrong number on the screen.
        assert 60 <= STALE_TTL_SECONDS <= 300

    def test_the_chart_gets_more_time_than_a_commit_check_does(self):
        settings = get_settings()
        # Nobody is blocked by the chart, and somebody is always blocked by the
        # check: a person is standing in front of the commit dialog.
        assert settings.chart_lookup_timeout_seconds > settings.external_lookup_timeout_seconds
        assert settings.chart_lookup_timeout_seconds >= 9


class TestThePictureIsAskedForAgain:
    """The queue's own rules, which are what make "again" not mean "constantly"."""

    @pytest.fixture(autouse=True)
    def clean_queue(self):
        with queue_module._wakeup:
            queue_module._queued.clear()
            queue_module._attempted.clear()
            queue_module._attempts.clear()
            queue_module._queue.clear()
        yield
        with queue_module._wakeup:
            queue_module._queued.clear()
            queue_module._attempted.clear()
            queue_module._attempts.clear()
            queue_module._queue.clear()

    def test_an_incomplete_answer_is_tried_again_later(self, monkeypatch):
        # The filler reports "not done" when the picture is still missing.
        monkeypatch.setattr(queue_module, "_filler", lambda mint: False)

        queue_module.request_fill(MINT)
        for _ in range(100):
            if queue_module._attempts.get(MINT):
                break
            time.sleep(0.02)

        assert queue_module._attempts.get(MINT) == 1
        assert MINT in queue_module._attempted

    def test_not_again_straight_away(self, monkeypatch):
        monkeypatch.setattr(queue_module, "_filler", lambda mint: False)
        with queue_module._wakeup:
            from datetime import datetime, timezone

            queue_module._attempted[MINT] = datetime.now(timezone.utc)

        queue_module.request_fill(MINT)

        assert queue_module.pending_count() == 0, "half an hour has to pass first"

    def test_and_not_for_ever(self, monkeypatch):
        monkeypatch.setattr(queue_module, "_filler", lambda mint: False)
        with queue_module._wakeup:
            queue_module._attempts[MINT] = queue_module.MAX_ATTEMPTS

        queue_module.request_fill(MINT)

        assert queue_module.pending_count() == 0, "a coin with no image at all is given up on"

    def test_a_complete_answer_clears_the_score(self, monkeypatch):
        monkeypatch.setattr(queue_module, "_filler", lambda mint: True)
        with queue_module._wakeup:
            queue_module._attempts[MINT] = 3

        queue_module.request_fill(MINT)
        for _ in range(100):
            if MINT not in queue_module._attempts:
                break
            time.sleep(0.02)

        assert MINT not in queue_module._attempts
        assert MINT not in queue_module._attempted

    def test_the_cap_is_a_few_hours_of_trying_not_a_few_minutes(self):
        hours = queue_module.MAX_ATTEMPTS * queue_module.RETRY_AFTER_SECONDS / 3600
        assert 2 <= hours <= 12
