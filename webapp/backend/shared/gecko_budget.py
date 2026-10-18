"""One budget of calls to GeckoTerminal for the whole API.

Their keyless API allows about ten calls a minute per address: "GeckoTerminal
endpoints: ~10 calls/min", and "All keyless requests share an IP-based rate
pool" (CoinGecko, "Keyless Public API", read on 2026-10-18). It was thirty a
minute once and older pages of theirs still say so; the stand got 429s after
seven calls in a minute on 2026-10-18, which is the ten.

Two things here ask it: the hover chart on the pool page
(`shared/coin_chart.py`), on demand, and the thread that keeps the charts of
the main page's bubbles (`application/lottery/coin_story.py`), on a schedule. Until 2026-10-18 each kept a ceiling of
20 of its own. One count now, for both, and the API runs as one process
(`uvicorn` with no workers), so it is the server's count.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

#: Under their "~10", with room for a call counted on their side and not on ours.
CALLS_PER_MINUTE = 8


class Budget:
    """At most `per_minute` calls in any sixty seconds."""

    def __init__(self, per_minute: int = CALLS_PER_MINUTE, clock: Callable[[], float] = time.monotonic):
        self._per_minute = per_minute
        self._clock = clock
        self._calls: list[float] = []
        self._lock = threading.Lock()

    def take(self) -> bool:
        """Counts a call and says yes, or says no and counts nothing."""
        with self._lock:
            now = self._clock()
            self._calls = [at for at in self._calls if now - at < 60]
            if len(self._calls) >= self._per_minute:
                return False
            self._calls.append(now)
            return True

    def left(self) -> int:
        """How many calls this minute still has."""
        with self._lock:
            now = self._clock()
            self._calls = [at for at in self._calls if now - at < 60]
            return self._per_minute - len(self._calls)

    def reset(self) -> None:
        with self._lock:
            self._calls.clear()


#: The one the API spends.
BUDGET = Budget()
