"""The coin's price chart for the last few minutes.

The pool page needs it: hover over a coin and see what is happening to it right
now. The data comes from GeckoTerminal (free access, no key, minute candles for
a specific pool) — Helius has no price history, and paying for another key just
for a hover tooltip makes no sense.

Three rules, which are why this module exists on its own:

* **never hold a person's request for more than a few seconds** — the timeout is
  short and an error turns into "no chart" rather than into waiting;
* **one request to the source for all visitors** — the answer sits in the cache
  until it goes stale, and parallel requests for the same coin wait for the first;
* **our own request counter** — free access allows about thirty requests a
  minute per address, and we stay below that by serving whatever is already
  cached for that time.

A coin can be younger than the first candle: then we return the points there
are, and how many minutes they cover, and the interface honestly says "the first
minutes".
"""

from __future__ import annotations

import json
import logging
import ssl
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional
from urllib import error, request

import certifi

logger = logging.getLogger(__name__)

#: Our own root certificates: python from python.org has no system ones, and
#: without them any https request fails certificate validation. The router does the same.
_HTTPS_CONTEXT = ssl.create_default_context(cafile=certifi.where())

GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2"
#: How long to hold an answer: a minute candle does not update more often anyway.
CACHE_TTL_SECONDS = 45.0
#: How long not to go back if the source stayed silent.
FAILURE_TTL_SECONDS = 180.0
#: Our own ceiling on requests per minute, below the free access limit.
MAX_CALLS_PER_MINUTE = 20
#: How many minute candles to ask for.
DEFAULT_POINTS = 60


@dataclass
class CoinChart:
    """The chart points: time in seconds and price in dollars."""
    available: bool = False
    points: list[tuple[int, float]] = field(default_factory=list)
    #: How many minutes the points cover — the interface labels the chart by it.
    minutes: int = 0
    #: The address of the pool the chart is built from.
    pool: Optional[str] = None
    #: The pool's venue: raydium, pumpswap and so on.
    venue: Optional[str] = None


_lock = threading.Lock()
_cache: dict[str, tuple[float, CoinChart]] = {}
_calls: list[float] = []
_inflight: dict[str, threading.Event] = {}


def coin_chart(
    mint: str,
    pool_address: Optional[str],
    venue: Optional[str],
    *,
    timeout_seconds: float,
    fetcher: Optional[Callable[[str, float], list[list[float]]]] = None,
) -> CoinChart:
    """A coin's chart. No pool, no chart, and that is a normal answer."""
    if not pool_address:
        return CoinChart(available=False)

    cached = _cached(mint)
    if cached is not None:
        return cached

    # While one thread goes for the candles, the rest wait for it and take the result.
    with _lock:
        pending = _inflight.get(mint)
        if pending is None:
            pending = threading.Event()
            _inflight[mint] = pending
            owner = True
        else:
            owner = False

    if not owner:
        pending.wait(timeout=timeout_seconds + 1)
        return _cached(mint) or CoinChart(available=False)

    try:
        if not _allow_call():
            # We hit our own ceiling: better to have no chart than to have the
            # source cut us off entirely.
            logger.info("coin chart skipped, rate limit reached (mint=%s)", mint)
            chart = CoinChart(available=False)
            _remember(mint, chart, FAILURE_TTL_SECONDS)
            return chart

        raw = (fetcher or _fetch_ohlcv)(pool_address, timeout_seconds)
        points = _to_points(raw)
        chart = CoinChart(
            available=len(points) >= 2,
            points=points,
            minutes=max(0, round((points[-1][0] - points[0][0]) / 60)) if len(points) >= 2 else 0,
            pool=pool_address,
            venue=venue,
        )
        _remember(mint, chart, CACHE_TTL_SECONDS if chart.available else FAILURE_TTL_SECONDS)
        return chart
    except Exception:
        logger.warning("coin chart unavailable (mint=%s)", mint, exc_info=True)
        chart = CoinChart(available=False)
        _remember(mint, chart, FAILURE_TTL_SECONDS)
        return chart
    finally:
        with _lock:
            _inflight.pop(mint, None)
        pending.set()


def _cached(mint: str) -> Optional[CoinChart]:
    with _lock:
        entry = _cache.get(mint)
        if entry and time.monotonic() < entry[0]:
            return entry[1]
    return None


def _remember(mint: str, chart: CoinChart, ttl: float) -> None:
    with _lock:
        _cache[mint] = (time.monotonic() + ttl, chart)
        if len(_cache) > 256:
            for key, _ in sorted(_cache.items(), key=lambda item: item[1][0])[:64]:
                _cache.pop(key, None)


def _allow_call() -> bool:
    now = time.monotonic()
    with _lock:
        while _calls and now - _calls[0] >= 60:
            _calls.pop(0)
        if len(_calls) >= MAX_CALLS_PER_MINUTE:
            return False
        _calls.append(now)
        return True


def _fetch_ohlcv(pool_address: str, timeout_seconds: float) -> list[list[float]]:
    url = (
        f"{GECKOTERMINAL_BASE}/networks/solana/pools/{pool_address}/ohlcv/minute"
        f"?aggregate=1&limit={DEFAULT_POINTS}&currency=usd"
    )
    req = request.Request(
        url=url,
        method="GET",
        headers={"Accept": "application/json;version=20230302", "User-Agent": "pumpling/1.0"},
    )
    try:
        with request.urlopen(req, timeout=timeout_seconds, context=_HTTPS_CONTEXT) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
    except error.HTTPError as exc:
        if exc.code == 429:
            logger.info("coin chart source is rate limiting us (pool=%s)", pool_address)
        raise
    attributes = ((payload.get("data") or {}).get("attributes") or {})
    ohlcv = attributes.get("ohlcv_list")
    return ohlcv if isinstance(ohlcv, list) else []


def _to_points(raw: list[list[float]]) -> list[tuple[int, float]]:
    """GeckoTerminal candles — [time, open, high, low, close, volume], newest first."""
    points: list[tuple[int, float]] = []
    for candle in raw:
        if not isinstance(candle, (list, tuple)) or len(candle) < 5:
            continue
        try:
            timestamp = int(candle[0])
            close = float(candle[4])
        except (TypeError, ValueError):
            continue
        if timestamp <= 0 or close <= 0:
            continue
        points.append((timestamp, close))
    points.sort(key=lambda point: point[0])
    return points


def reset_for_tests() -> None:
    with _lock:
        _cache.clear()
        _calls.clear()
        _inflight.clear()
