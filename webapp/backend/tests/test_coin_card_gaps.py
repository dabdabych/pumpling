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


class TestThePictureIsFoundWhereItIs:
    """Where a small coin's picture comes from, and why it was never found.

    pump.fun has the picture from the moment a coin is created. Its old path
    started answering 404 for every coin and the 404 went unlogged, and the
    search stopped at the first source that knew anything at all, so a source
    with the name and no picture ended it.
    """

    @staticmethod
    def router():
        from presentation.lottery import lottery_router

        return lottery_router

    def test_pumpfun_is_asked_at_coins_v2(self, monkeypatch):
        router = self.router()
        asked = []

        class Answer:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"mint": "%s", "name": "Mochi", "symbol": "MOCHI", "image_uri": "https://ipfs.io/ipfs/mochi"}' % MINT.encode()

        def urlopen(request, timeout=None, context=None):
            asked.append(request.full_url)
            return Answer()

        monkeypatch.setattr(router.urllib_request, "urlopen", urlopen)
        metadata = router._fetch_pumpfun_token_metadata(MINT)

        assert asked == [f"https://frontend-api-v3.pump.fun/coins-v2/{MINT}"]
        assert metadata == {"token_name": "Mochi", "token_symbol": "MOCHI", "token_image_url": "https://ipfs.io/ipfs/mochi"}

    def test_a_404_is_logged_rather_than_taken_quietly(self, monkeypatch, caplog):
        import io
        from urllib import error as urllib_error

        router = self.router()

        def urlopen(request, timeout=None, context=None):
            raise urllib_error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b"{}"))

        monkeypatch.setattr(router.urllib_request, "urlopen", urlopen)
        with caplog.at_level("WARNING"):
            metadata = router._fetch_pumpfun_token_metadata(MINT)

        assert not any(metadata.values())
        assert "status=404" in caplog.text

    def test_a_name_without_a_picture_does_not_end_the_search(self, monkeypatch):
        router = self.router()
        empty = {"token_name": None, "token_symbol": None, "token_image_url": None}
        monkeypatch.setattr(router, "_fetch_pumpfun_token_metadata", lambda mint: {**empty, "token_name": "Convict.fun", "token_symbol": "CONVICT"})
        monkeypatch.setattr(router, "_fetch_helius_token_metadata", lambda mint: dict(empty))
        monkeypatch.setattr(router, "_fetch_dexscreener_token_metadata", lambda mint: {**empty, "token_name": "Other", "token_image_url": "https://cdn/convict.png"})

        metadata = router._fetch_token_metadata(MINT)

        # The name from the first source that had one, the picture from the one that had it.
        assert metadata == {"token_name": "Convict.fun", "token_symbol": "CONVICT", "token_image_url": "https://cdn/convict.png"}

    def test_and_stops_as_soon_as_everything_is_known(self, monkeypatch):
        router = self.router()
        calls = []

        def complete(mint):
            calls.append("pumpfun")
            return {"token_name": "Mochi", "token_symbol": "MOCHI", "token_image_url": "https://ipfs.io/ipfs/mochi"}

        def later(name):
            def fetch(mint):
                calls.append(name)
                return {"token_name": None, "token_symbol": None, "token_image_url": None}
            return fetch

        monkeypatch.setattr(router, "_fetch_pumpfun_token_metadata", complete)
        monkeypatch.setattr(router, "_fetch_helius_token_metadata", later("helius"))
        monkeypatch.setattr(router, "_fetch_dexscreener_token_metadata", later("dexscreener"))

        router._fetch_token_metadata(MINT)

        assert calls == ["pumpfun"]

    def test_the_paid_source_is_asked_last_and_only_for_what_is_missing(self, monkeypatch):
        # DexScreener knows the name and the ticker but not the picture, as it
        # did for both coins of the 2026-09-29 round; Helius DAS, 10 credits a
        # lookup, is asked only after it, for the picture.
        router = self.router()
        calls = []
        empty = {"token_name": None, "token_symbol": None, "token_image_url": None}

        def source(name, answer):
            def fetch(mint):
                calls.append(name)
                return {**empty, **answer}
            return fetch

        monkeypatch.setattr(router, "_fetch_pumpfun_token_metadata", source("pumpfun", {}))
        monkeypatch.setattr(router, "_fetch_dexscreener_token_metadata", source("dexscreener", {"token_name": "lapa.page", "token_symbol": "lapa"}))
        monkeypatch.setattr(router, "_fetch_helius_token_metadata", source("helius", {"token_image_url": "https://ipfs.io/ipfs/lapa"}))

        metadata = router._fetch_token_metadata(MINT)

        assert calls == ["pumpfun", "dexscreener", "helius"]
        assert metadata == {"token_name": "lapa.page", "token_symbol": "lapa", "token_image_url": "https://ipfs.io/ipfs/lapa"}

    def test_das_lookups_have_a_ceiling_for_everybody_together(self, monkeypatch):
        from types import SimpleNamespace

        router = self.router()
        router._DAS_CALLS.clear()
        monkeypatch.setattr(router, "get_settings", lambda: SimpleNamespace(
            helius_api_key="paid-key", helius_das_base_url="https://mainnet.helius-rpc.com",
            helius_das_limit_per_minute=3, external_lookup_timeout_seconds=1.0,
        ))
        sent = []

        class Answer:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"result": {"content": {"metadata": {"name": "Mochi", "symbol": "MOCHI"}, "links": {"image": "https://ipfs.io/ipfs/mochi"}}}}'

        def urlopen(request, timeout=None, context=None):
            sent.append(request.full_url)
            return Answer()

        monkeypatch.setattr(router.urllib_request, "urlopen", urlopen)
        answers = [router._fetch_helius_token_metadata(f"Mint{i}") for i in range(5)]
        router._DAS_CALLS.clear()

        # Three paid lookups in the minute, then nothing is sent at all.
        assert len(sent) == 3
        assert [bool(a["token_name"]) for a in answers] == [True, True, True, False, False]

    def test_the_default_ceiling_bounds_what_das_can_cost(self):
        from shared.settings import get_settings

        # 10 credits a lookup: at most 300 credits a minute however many
        # people check coins.
        assert 0 < get_settings().helius_das_limit_per_minute <= 30
