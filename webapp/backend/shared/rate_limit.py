"""Rate limiting.

Why: registration, sign-in and coin validation are available without an
invitation, and `check-mint` also goes outside at our expense. One script could
create a thousand accounts in a minute or burn our limits at Helius and
DexScreener.

How it works: every rule has its own fixed-window counter keyed by the client
address. The counters live in process memory; the backend runs as a single
uvicorn process (see the Dockerfile), so that is enough. If there are ever
several processes the counters will have to move to Redis — the rules would not
change, only the storage.

Worth being clear about: this protects against a fool and a script, not against
a distributed attack. Real protection from that lives at the proxy and the provider.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Optional

from fastapi import Request
from fastapi.responses import JSONResponse


@dataclass(frozen=True)
class Rule:
    """How many requests per address in how many seconds."""

    limit: int
    window_seconds: int


#: Rules by path prefix. The order matters: the first match wins, so longer
#: paths come above shorter ones.
RULES: tuple[tuple[str, Rule], ...] = (
    # Creating accounts and sending email is the most expensive thing available without signing in.
    ("/auth/register", Rule(limit=5, window_seconds=900)),
    ("/auth/request-password-reset", Rule(limit=5, window_seconds=900)),
    ("/auth/reset-password", Rule(limit=10, window_seconds=900)),
    ("/auth/confirm-email", Rule(limit=20, window_seconds=900)),
    # Guessing a password or a wallet signature.
    ("/auth/login", Rule(limit=15, window_seconds=300)),
    ("/auth/wallet/nonce", Rule(limit=30, window_seconds=300)),
    ("/auth/wallet/verify", Rule(limit=30, window_seconds=300)),
    # Coin validation goes outside: we stay well below the sources' limits.
    ("/lottery/check-mint", Rule(limit=30, window_seconds=60)),
    # A commit is bounded by the wallet and the network, but it should not be unlimited.
    ("/lottery/bet", Rule(limit=20, window_seconds=60)),
)

#: The general ceiling for everything else. The pool page polls the server every
#: few seconds, which is roughly twenty requests a minute per tab; six hundred
#: leaves room for a dozen tabs and for a shared office address.
DEFAULT_RULE = Rule(limit=600, window_seconds=60)

#: Paths we do not count at all: liveness checks and the chat websocket.
EXEMPT_PREFIXES = ("/ping", "/chat/ws", "/api/ws")


class _Counters:
    """Fixed-window counters: key -> (when the window ends, how many there were)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: dict[tuple[str, str], tuple[float, int]] = {}
        self._last_sweep = time.monotonic()

    def check(self, key: tuple[str, str], rule: Rule, now: float) -> Optional[float]:
        """Returns how many seconds to wait when the limit is used up."""
        with self._lock:
            self._sweep(now)
            expires_at, count = self._hits.get(key, (0.0, 0))
            if now >= expires_at:
                self._hits[key] = (now + rule.window_seconds, 1)
                return None
            if count >= rule.limit:
                return max(1.0, expires_at - now)
            self._hits[key] = (expires_at, count + 1)
            return None

    def _sweep(self, now: float) -> None:
        # Once a minute we throw out the stale entries so the dictionary does not grow forever.
        if now - self._last_sweep < 60:
            return
        self._last_sweep = now
        self._hits = {key: value for key, value in self._hits.items() if value[0] > now}

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
            self._last_sweep = time.monotonic()


_counters = _Counters()


def rule_for(path: str) -> Optional[Rule]:
    """Which rule applies to this path; None means no limit."""
    if path.startswith(EXEMPT_PREFIXES):
        return None
    for prefix, rule in RULES:
        if path.startswith(prefix):
            return rule
    return DEFAULT_RULE


def client_key(request: Request) -> str:
    """The client address: behind a proxy, the first address in X-Forwarded-For."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    client = request.client
    return client.host if client else "unknown"


async def rate_limit_middleware(request: Request, call_next):
    rule = rule_for(request.url.path)
    if rule is None:
        return await call_next(request)

    retry_after = _counters.check(
        (rule_key(request.url.path), client_key(request)),
        rule,
        time.monotonic(),
    )
    if retry_after is not None:
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests. Slow down and try again in a moment."},
            headers={"Retry-After": str(int(retry_after))},
        )
    return await call_next(request)


def rule_key(path: str) -> str:
    """Which key to count a path under: rules are shared across the paths they cover."""
    for prefix, _ in RULES:
        if path.startswith(prefix):
            return prefix
    return "*"


def reset_for_tests() -> None:
    _counters.reset()
