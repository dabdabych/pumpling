"""The coin chart: the cache, our own request ceiling and behaviour on failure.

The source is replaced by a function, so the test does not touch the network and
checks exactly what the module was written for: one visitor is enough for
everyone, the limit is respected, and a failure does not turn into endless retries.
"""
from __future__ import annotations

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import coin_chart as module  # noqa: E402
from shared.coin_chart import coin_chart, reset_for_tests  # noqa: E402

POOL = "PoolAddress1111111111111111111111111111111"


def candles(count: int, *, start: int = 1_700_000_000, price: float = 0.0001) -> list[list[float]]:
    # GeckoTerminal returns the newest candles first.
    return [[start + index * 60, price, price, price, price * (1 + index / 100), 10.0] for index in range(count)][::-1]


@pytest.fixture(autouse=True)
def clean():
    reset_for_tests()
    yield
    reset_for_tests()


def test_returns_points_in_time_order():
    chart = coin_chart("mint1", POOL, "raydium", timeout_seconds=1, fetcher=lambda *_: candles(10))

    assert chart.available is True
    assert len(chart.points) == 10
    assert chart.points == sorted(chart.points, key=lambda point: point[0])
    assert chart.minutes == 9
    assert chart.venue == "raydium"


def test_a_brand_new_coin_gives_what_it_has():
    chart = coin_chart("mint2", POOL, "pumpswap", timeout_seconds=1, fetcher=lambda *_: candles(2))

    assert chart.available is True
    assert chart.minutes == 1
    assert len(chart.points) == 2


def test_one_candle_is_not_a_chart():
    chart = coin_chart("mint3", POOL, None, timeout_seconds=1, fetcher=lambda *_: candles(1))

    assert chart.available is False


def test_no_pool_means_no_request_at_all():
    calls = 0

    def fetcher(*_):
        nonlocal calls
        calls += 1
        return candles(5)

    chart = coin_chart("mint4", None, None, timeout_seconds=1, fetcher=fetcher)

    assert chart.available is False
    assert calls == 0


def test_second_visitor_gets_the_cached_answer():
    calls = 0

    def fetcher(*_):
        nonlocal calls
        calls += 1
        return candles(5)

    first = coin_chart("mint5", POOL, None, timeout_seconds=1, fetcher=fetcher)
    second = coin_chart("mint5", POOL, None, timeout_seconds=1, fetcher=fetcher)

    assert calls == 1
    assert first.points == second.points


def test_parallel_visitors_make_one_request():
    calls = 0

    def slow_fetcher(*_):
        nonlocal calls
        calls += 1
        time.sleep(0.2)
        return candles(5)

    results = []
    threads = [
        threading.Thread(target=lambda: results.append(coin_chart("mint6", POOL, None, timeout_seconds=2, fetcher=slow_fetcher)))
        for _ in range(5)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert calls == 1
    assert all(result.available for result in results)


def test_a_failure_is_remembered_for_a_while():
    calls = 0

    def broken(*_):
        nonlocal calls
        calls += 1
        raise RuntimeError("source is down")

    first = coin_chart("mint7", POOL, None, timeout_seconds=1, fetcher=broken)
    second = coin_chart("mint7", POOL, None, timeout_seconds=1, fetcher=broken)

    assert first.available is False and second.available is False
    assert calls == 1, "after a failure we do not hammer the source on every hover"


def test_our_own_rate_limit_holds():
    calls = 0

    def fetcher(*_):
        nonlocal calls
        calls += 1
        return candles(5)

    for index in range(module.MAX_CALLS_PER_MINUTE + 8):
        coin_chart(f"mint-{index}", POOL, None, timeout_seconds=1, fetcher=fetcher)

    assert calls == module.MAX_CALLS_PER_MINUTE
