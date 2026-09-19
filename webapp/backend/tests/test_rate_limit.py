"""Rate limiting: counts per address, does not get in the way of normal use.

We check exactly what it was written for: a script cannot create a hundred
accounts or burn our limits at external sources, while an ordinary visitor with
the pool page open never hits the limit.
"""
from __future__ import annotations

import os
import sys

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import rate_limit as module  # noqa: E402
from shared.rate_limit import (  # noqa: E402
    DEFAULT_RULE,
    client_key,
    rate_limit_middleware,
    reset_for_tests,
    rule_for,
)


@pytest.fixture(autouse=True)
def clean():
    reset_for_tests()
    yield
    reset_for_tests()


@pytest.fixture
def client():
    app = FastAPI()
    app.middleware("http")(rate_limit_middleware)

    @app.get("/ping")
    async def ping():
        return {"ok": True}

    @app.post("/auth/register")
    async def register():
        return {"ok": True}

    @app.post("/lottery/check-mint")
    async def check_mint():
        return {"ok": True}

    @app.get("/lottery/current")
    async def current():
        return {"ok": True}

    return TestClient(app)


def _post(client: TestClient, path: str, ip: str = "10.0.0.1"):
    return client.post(path, headers={"x-forwarded-for": ip})


def test_registration_stops_after_the_fifth_attempt(client):
    for attempt in range(5):
        assert _post(client, "/auth/register").status_code == 200, f"attempt {attempt + 1}"
    blocked = _post(client, "/auth/register")
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0
    assert "try again" in blocked.json()["detail"].lower()


def test_the_limit_is_per_address(client):
    for _ in range(5):
        _post(client, "/auth/register", ip="10.0.0.1")
    assert _post(client, "/auth/register", ip="10.0.0.1").status_code == 429
    # A neighbour on the internet must not suffer for somebody else's script.
    assert _post(client, "/auth/register", ip="10.0.0.2").status_code == 200


def test_rules_do_not_leak_into_each_other(client):
    for _ in range(5):
        _post(client, "/auth/register")
    assert _post(client, "/auth/register").status_code == 429
    # Coin validation lives on its own counter.
    assert _post(client, "/lottery/check-mint").status_code == 200


def test_check_mint_holds_thirty_a_minute(client):
    for attempt in range(30):
        assert _post(client, "/lottery/check-mint").status_code == 200, f"attempt {attempt + 1}"
    assert _post(client, "/lottery/check-mint").status_code == 429


def test_an_open_pool_page_never_hits_the_limit(client):
    # The page polls the server every three seconds: twenty requests a minute per
    # tab. Even ten tabs have to pass freely.
    for _ in range(200):
        assert client.get("/lottery/current", headers={"x-forwarded-for": "10.0.0.9"}).status_code == 200


def test_health_check_is_never_limited(client):
    for _ in range(DEFAULT_RULE.limit + 50):
        assert client.get("/ping", headers={"x-forwarded-for": "10.0.0.3"}).status_code == 200


def test_rules_cover_the_paths_we_care_about():
    assert rule_for("/auth/register").limit == 5
    assert rule_for("/lottery/check-mint").limit == 30
    assert rule_for("/lottery/current") == DEFAULT_RULE
    assert rule_for("/ping") is None
    assert rule_for("/chat/ws/12") is None


def test_address_comes_from_the_proxy_header():
    scope = {
        "type": "http",
        "headers": [(b"x-forwarded-for", b"203.0.113.7, 10.0.0.1")],
        "client": ("10.0.0.1", 1234),
    }
    assert client_key(Request(scope)) == "203.0.113.7"

    without_header = {"type": "http", "headers": [], "client": ("10.0.0.5", 1234)}
    assert client_key(Request(without_header)) == "10.0.0.5"


def test_counters_do_not_grow_forever(client):
    for index in range(50):
        _post(client, "/auth/register", ip=f"10.1.0.{index}")
    # The dictionary is cleaned by time, but even before cleaning it is bounded by the number of addresses.
    assert len(module._counters._hits) <= 50
