"""Nobody can spend the Helius plan through the public RPC proxy faster than we allow.

The proxy stands in front of the same plan the buyer and the workers run on.
Three holes let a single script spend it at will:

- the client was the first address in X-Forwarded-For, which the client writes
  itself, so a new made-up address per request was a new client every time;
- a batch of ten calls counted as one request and cost ten calls;
- there was no ceiling for everybody together, so enough addresses could take
  the whole plan and its per-second limit away from the buyer.

These tests fail on the proxy as it was before 2026-09-30.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from presentation.rpc import rpc_router as proxy  # noqa: E402

GOOD = json.dumps({"jsonrpc": "2.0", "result": {"value": {"blockhash": "abc"}}, "id": 1}).encode()
ONE = b'{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash"}'
TEN = json.dumps([{"jsonrpc": "2.0", "id": i, "method": "getBalance", "params": ["11111111111111111111111111111111"]} for i in range(10)]).encode()


class Request:
    def __init__(self, payload: bytes, forwarded_for: str | None = None, host: str = "172.19.0.3"):
        self._payload = payload
        self.client = SimpleNamespace(host=host)
        self.headers = {"x-forwarded-for": forwarded_for} if forwarded_for else {}

    async def body(self) -> bytes:
        return self._payload


@pytest.fixture
def upstream(monkeypatch):
    proxy.reset_limits_for_tests()
    asked: list[bytes] = []

    def forward(body, url, timeout):
        asked.append(body)
        return GOOD

    monkeypatch.setattr(proxy, "_upstream_urls", lambda: ["https://node.example/"])
    monkeypatch.setattr(proxy, "_forward_rpc_request", forward)
    yield asked
    proxy.reset_limits_for_tests()


def limits(monkeypatch, per_client: int, everybody: int, batch: int = 10):
    monkeypatch.setattr(proxy, "get_settings", lambda: SimpleNamespace(
        rpc_proxy_max_batch_size=batch,
        rpc_proxy_rate_limit_per_minute=per_client,
        rpc_proxy_global_limit_per_minute=everybody,
        rpc_proxy_timeout_seconds=5.0,
    ))


def send(payload: bytes, forwarded_for: str | None = None):
    try:
        return asyncio.run(proxy.proxy_rpc(Request(payload, forwarded_for))).status_code
    except HTTPException as exc:
        return exc.status_code


class TestOneClient:
    def test_every_call_in_a_batch_counts(self, upstream, monkeypatch):
        limits(monkeypatch, per_client=20, everybody=10_000)
        assert send(TEN, "198.51.100.7") == 200
        assert send(TEN, "198.51.100.7") == 200
        # Twenty calls spent: one more is past the limit, batched or not.
        assert send(ONE, "198.51.100.7") == 429
        assert len(upstream) == 2

    def test_a_made_up_address_in_front_is_still_the_same_client(self, upstream, monkeypatch):
        limits(monkeypatch, per_client=5, everybody=10_000)
        # nginx appends the real address; everything before it is the client's.
        codes = [send(ONE, f"10.{i}.0.1, 198.51.100.7") for i in range(8)]
        assert codes == [200] * 5 + [429] * 3
        assert len(upstream) == 5

    def test_different_real_addresses_have_their_own_limits(self, upstream, monkeypatch):
        limits(monkeypatch, per_client=2, everybody=10_000)
        assert [send(ONE, "198.51.100.7") for _ in range(3)] == [200, 200, 429]
        assert send(ONE, "198.51.100.8") == 200


class TestEverybodyTogether:
    def test_rotating_addresses_stops_at_the_ceiling(self, upstream, monkeypatch, caplog):
        limits(monkeypatch, per_client=1_000, everybody=30)
        with caplog.at_level(logging.ERROR, logger=proxy.logger.name):
            codes = [send(TEN, f"203.0.113.{i}") for i in range(6)]
        assert codes == [200, 200, 200, 429, 429, 429]
        # Refused calls never reach Helius.
        assert len(upstream) == 3
        # Said once, not once per refusal.
        alarms = [r for r in caplog.records if "ceiling" in r.getMessage()]
        assert len(alarms) == 1

    def test_a_refusal_says_to_try_again(self, upstream, monkeypatch):
        limits(monkeypatch, per_client=1_000, everybody=1)
        assert send(ONE, "203.0.113.1") == 200
        try:
            asyncio.run(proxy.proxy_rpc(Request(ONE, "203.0.113.2")))
        except HTTPException as exc:
            assert exc.status_code == 429
            assert "try again" in str(exc.detail).lower()
        else:
            raise AssertionError("the second call went through")

    def test_the_default_ceiling_leaves_room_for_the_buyer(self):
        from shared.settings import get_settings

        settings = get_settings()
        # Helius Developer allows 50 RPC calls a second (helius.dev/docs/billing/plans);
        # the buyer sends up to 4 a second and reads beside them.
        assert settings.rpc_proxy_global_limit_per_minute / 60 <= 20
        assert settings.rpc_proxy_rate_limit_per_minute <= settings.rpc_proxy_global_limit_per_minute
