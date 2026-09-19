"""Loading coin metadata in the background.

`GET /lottery/current` used to go to Helius itself for the name and picture of
an unknown mint. The request is synchronous with a shared timeout, and the pool
page, which polls that endpoint every few seconds, could wait tens of seconds
for an answer. Now the endpoint answers immediately with what is in the
database, and one background thread fetches what is missing into
`token_metadata` — on the next poll the coin already has a name.

One thread rather than a pool: there are not many lookups, and a one-at-a-time
queue stops us fanning out requests at Helius for no reason.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# How long to leave a mint alone after a failed attempt.
RETRY_AFTER_SECONDS = 30 * 60

_lock = threading.Lock()
_queued: set[str] = set()
_attempted: dict[str, datetime] = {}
_worker: Optional[threading.Thread] = None
_queue: list[str] = []
_wakeup = threading.Condition(_lock)

#: Who actually downloads and stores it; set once at startup.
_filler: Optional[Callable[[str], bool]] = None


def configure(filler: Callable[[str], bool]) -> None:
    """Set the function that downloads and stores the metadata for one mint."""
    global _filler
    _filler = filler


def request_fill(mint: str) -> None:
    """Queue a mint, if it is not there already and was not tried recently."""
    if not mint or _filler is None:
        return

    now = datetime.now(timezone.utc)
    with _wakeup:
        if mint in _queued:
            return
        attempted_at = _attempted.get(mint)
        if attempted_at and now - attempted_at < timedelta(seconds=RETRY_AFTER_SECONDS):
            return
        _queued.add(mint)
        _queue.append(mint)
        _ensure_worker_locked()
        _wakeup.notify()


def _ensure_worker_locked() -> None:
    global _worker
    if _worker is not None and _worker.is_alive():
        return
    _worker = threading.Thread(target=_run, name="token-metadata-filler", daemon=True)
    _worker.start()


def _run() -> None:
    while True:
        with _wakeup:
            while not _queue:
                # The thread lives while there is work: an empty queue means we
                # exit, and the next request starts it again.
                if not _wakeup.wait(timeout=60):
                    return
            mint = _queue.pop(0)

        try:
            filled = _filler(mint) if _filler else False
        except Exception:
            filled = False
            logger.exception("failed to fill token metadata in background (mint=%s)", mint)

        with _wakeup:
            _queued.discard(mint)
            if not filled:
                _attempted[mint] = datetime.now(timezone.utc)
            else:
                _attempted.pop(mint, None)


def forget(mint: str) -> None:
    """Forget a failure: the mint was learned another way, so it can be tried again."""
    with _wakeup:
        _attempted.pop(mint, None)


def pending_count() -> int:
    with _wakeup:
        return len(_queue)
