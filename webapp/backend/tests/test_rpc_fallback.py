"""The proxy the browser reaches the chain through, when its provider says no.

On 2026-09-22 the devnet plan ran out of credits. Helius answered `-32429 max
usage reached` to every method that costs anything, and kept answering 200 to
`getHealth`, which is free, so nothing looked broken from the outside. The
proxy had one upstream and no way to leave it: it built a Helius URL whenever a
key was set and never looked at `SOLANA_HTTP_ENDPOINT`, which was pointing at a
working node the whole time.

What that cost was the wallet. Without `getLatestBlockhash` there is no
transaction to sign, so nobody could commit anything, on a site whose only
action is committing.

The same key is configured on mainnet.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from urllib import error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from presentation.rpc import rpc_router as proxy  # noqa: E402

HELIUS = "https://devnet.helius-rpc.com/?api-key=secret-key-value"
PUBLIC = "https://api.devnet.solana.com"

SPENT = json.dumps({"jsonrpc": "2.0", "error": {"code": -32429, "message": "max usage reached"}}).encode()
GOOD = json.dumps({"jsonrpc": "2.0", "result": {"value": {"blockhash": "abc"}}, "id": 1}).encode()
REAL_RPC_ERROR = json.dumps({"jsonrpc": "2.0", "error": {"code": -32602, "message": "bad params"}}).encode()


class Request:
    """Enough of a FastAPI request for the handler."""

    def __init__(self, payload: bytes):
        self._payload = payload
        self.client = type("C", (), {"host": "10.0.0.1"})()
        self.headers: dict[str, str] = {}

    async def body(self) -> bytes:
        return self._payload


@pytest.fixture
def two_upstreams(monkeypatch):
    monkeypatch.setattr(proxy, "_upstream_urls", lambda: [HELIUS, PUBLIC])
    # The rate limiter keeps state between tests and this one client IP would
    # trip it; the proxy's own limit is covered by its own suite.
    monkeypatch.setattr(proxy, "_enforce_rate_limit", lambda *_: None)


def call(payload: bytes = b'{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash"}'):
    return asyncio.run(proxy.proxy_rpc(Request(payload)))


def answers(mapping):
    """Forwarder that replies per upstream, recording who was asked."""
    asked: list[str] = []

    def forward(body, url, timeout):
        asked.append(url)
        outcome = mapping[url]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    return forward, asked


class TestWhenTheFirstUpstreamIsSpent:
    def test_it_asks_the_next_one(self, two_upstreams, monkeypatch):
        # The refusal arrives as HTTP 200 with the code in the body, so the
        # status alone would have called this a success and passed it on.
        forward, asked = answers({HELIUS: SPENT, PUBLIC: GOOD})
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        response = call()

        assert asked == [HELIUS, PUBLIC]
        assert response.status_code == 200
        assert b"blockhash" in response.body

    def test_a_429_moves_on_too(self, two_upstreams, monkeypatch):
        forward, asked = answers({
            HELIUS: error.HTTPError(HELIUS, 429, "Too Many Requests", {}, None),
            PUBLIC: GOOD,
        })
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        response = call()

        assert asked == [HELIUS, PUBLIC]
        assert b"blockhash" in response.body

    def test_so_does_a_provider_having_a_bad_minute(self, two_upstreams, monkeypatch):
        forward, asked = answers({
            HELIUS: error.HTTPError(HELIUS, 503, "Service Unavailable", {}, None),
            PUBLIC: GOOD,
        })
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        assert b"blockhash" in call().body
        assert asked == [HELIUS, PUBLIC]

    def test_and_an_unreachable_host(self, two_upstreams, monkeypatch):
        forward, asked = answers({HELIUS: error.URLError("no route"), PUBLIC: GOOD})
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        assert b"blockhash" in call().body
        assert asked == [HELIUS, PUBLIC]


class TestWhatItMustNotHide:
    def test_a_bad_request_is_not_retried_elsewhere(self, two_upstreams, monkeypatch):
        # A 400 is our own payload being wrong. Asking somebody else spends a
        # round trip to be told the same thing, and hides the mistake.
        forward, asked = answers({
            HELIUS: error.HTTPError(HELIUS, 400, "Bad Request", {}, None),
            PUBLIC: GOOD,
        })
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        response = call()

        assert asked == [HELIUS]
        assert response.status_code == 400

    def test_a_real_rpc_error_is_passed_through(self, two_upstreams, monkeypatch):
        # A method complaining about its parameters is an answer, not a refusal.
        forward, asked = answers({HELIUS: REAL_RPC_ERROR, PUBLIC: GOOD})
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        response = call()

        assert asked == [HELIUS]
        assert b"bad params" in response.body

    def test_when_everyone_is_spent_the_caller_is_told(self, two_upstreams, monkeypatch):
        forward, asked = answers({HELIUS: SPENT, PUBLIC: SPENT})
        monkeypatch.setattr(proxy, "_forward_rpc_request", forward)

        response = call()

        assert asked == [HELIUS, PUBLIC]
        assert b"max usage reached" in response.body


class TestTheListItself:
    def test_the_configured_endpoint_is_always_a_fallback(self, monkeypatch):
        # The bug in one line: with a key set, the configured endpoint used to
        # be unreachable no matter what happened to the provider.
        class S:
            helius_api_key = "k"
            helius_das_base_url = "https://mainnet.helius-rpc.com"
            network = "devnet"
            solana_http_endpoint = PUBLIC

        monkeypatch.setattr(proxy, "get_settings", lambda: S())
        urls = proxy._upstream_urls()

        assert len(urls) == 2
        assert urls[0].startswith("https://devnet.helius-rpc.com")
        assert urls[1] == PUBLIC

    def test_no_duplicate_when_they_are_the_same(self, monkeypatch):
        class S:
            helius_api_key = ""
            helius_das_base_url = ""
            network = "devnet"
            solana_http_endpoint = PUBLIC

        monkeypatch.setattr(proxy, "get_settings", lambda: S())
        assert proxy._upstream_urls() == [PUBLIC]

    def test_a_log_line_never_carries_the_key(self):
        # These lines name the upstream that failed, and the key is in its query.
        assert "secret-key-value" not in proxy._safe_url(HELIUS)
        assert proxy._safe_url(HELIUS) == "https://devnet.helius-rpc.com/"
