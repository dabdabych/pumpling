"""A dead address costs a short wait once, not the request timeout every time.

On the devnet stand, on 2026-10-02, api.dexscreener.com, frontend-api-v3.pump.fun
and mainnet.helius-rpc.com all resolved to 8.47.69.0 and 8.6.112.0, and the
second could not be reached. The standard library gave it the whole 6 s
timeout before trying the first, so about half of all calls took six seconds.
Ten connections to DexScreener took 42.1 s that way and 1.6 s through
`shared/fast_http.py`. These tests run on fake sockets: no network.
"""
from __future__ import annotations

import os
import socket
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import fast_http  # noqa: E402

LIVE = ("8.47.69.0", 443)
DEAD = ("8.6.112.0", 443)
V6 = ("2606:4700::6812:1", 443, 0, 0)


@pytest.fixture
def network(monkeypatch):
    """Fake resolver and sockets. `answers` is what getaddrinfo returns; `connect_seconds`
    says how long each address takes to accept (None: never)."""
    state = {"answers": [], "connect_seconds": {}, "attempts": []}

    def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return [(socket.AF_INET6 if len(addr) == 4 else socket.AF_INET, socket.SOCK_STREAM, 6, "", addr) for addr in state["answers"]]

    class FakeSocket:
        def __init__(self, family, socktype, proto):
            self.timeout = None

        def settimeout(self, value):
            self.timeout = value

        def bind(self, address):
            pass

        def connect(self, sockaddr):
            needed = state["connect_seconds"].get(sockaddr, 0.01)
            state["attempts"].append((sockaddr, self.timeout))
            if needed is None or (self.timeout is not None and needed > self.timeout):
                raise TimeoutError("timed out")

        def close(self):
            pass

    monkeypatch.setattr(fast_http.socket, "getaddrinfo", getaddrinfo)
    monkeypatch.setattr(fast_http.socket, "socket", FakeSocket)
    with fast_http._dead_lock:
        fast_http._dead_until.clear()
    yield state
    with fast_http._dead_lock:
        fast_http._dead_until.clear()


def test_a_dead_address_gets_a_short_try_then_the_live_one_answers(network):
    network["answers"] = [DEAD, LIVE]
    network["connect_seconds"] = {DEAD: None}

    sock = fast_http.create_connection(("api.dexscreener.com", 443), timeout=6)

    assert network["attempts"] == [(DEAD, fast_http.CONNECT_ATTEMPT_SECONDS), (LIVE, fast_http.CONNECT_ATTEMPT_SECONDS)]
    assert sock.timeout == 6, "once connected, the request keeps its full timeout"


def test_and_for_the_next_two_minutes_it_goes_last(network):
    network["answers"] = [DEAD, LIVE]
    network["connect_seconds"] = {DEAD: None}
    fast_http.create_connection(("api.dexscreener.com", 443), timeout=6)
    network["attempts"].clear()

    fast_http.create_connection(("frontend-api-v3.pump.fun", 443), timeout=6)

    assert network["attempts"] == [(LIVE, fast_http.CONNECT_ATTEMPT_SECONDS)], "the same dead address, behind another name, is not tried first"


def test_a_slow_but_live_server_is_not_cut_off(network):
    # Both addresses take 3 s to accept: longer than the short try, shorter than the timeout.
    network["answers"] = [LIVE, DEAD]
    network["connect_seconds"] = {LIVE: 3.0, DEAD: 3.0}

    sock = fast_http.create_connection(("slow.example", 443), timeout=6)

    assert network["attempts"][-1] == (LIVE, 6), "after the short tries, the first address gets all the time there is"
    assert sock.timeout == 6


def test_a_single_address_gets_the_whole_timeout(network):
    network["answers"] = [LIVE]
    network["connect_seconds"] = {LIVE: 3.0}

    fast_http.create_connection(("one.example", 443), timeout=6)

    assert network["attempts"] == [(LIVE, 6)]


def test_an_unreachable_family_is_skipped_at_once(network):
    # IPv6 without a route fails straight away; it must not cost a timeout.
    network["answers"] = [V6, LIVE]

    class Unreachable(OSError):
        pass

    real_connect = None

    def refuse_v6(self, sockaddr):
        if len(sockaddr) == 4:
            network["attempts"].append((sockaddr, self.timeout))
            raise Unreachable("Network is unreachable")
        return real_connect(self, sockaddr)

    real_connect = fast_http.socket.socket.connect
    fast_http.socket.socket.connect = refuse_v6
    try:
        fast_http.create_connection(("api.dexscreener.com", 443), timeout=6)
    finally:
        fast_http.socket.socket.connect = real_connect

    assert [a for a, _ in network["attempts"]] == [V6, LIVE]
    assert V6 not in fast_http._dead_until, "a refusal is an answer, not a dead address"


def test_when_nothing_answers_the_error_comes_through(network):
    network["answers"] = [DEAD]
    network["connect_seconds"] = {DEAD: None}

    with pytest.raises(TimeoutError):
        fast_http.create_connection(("dead.example", 443), timeout=6)


def test_every_outside_call_in_the_backend_goes_through_it():
    """A new `urlopen` straight from urllib would bring the six-second waits back."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    offenders = []
    for folder, _dirs, files in os.walk(root):
        if "/tests" in folder or "__pycache__" in folder or "/migrations" in folder:
            continue
        for name in files:
            if not name.endswith(".py") or name == "fast_http.py":
                continue
            path = os.path.join(folder, name)
            for number, line in enumerate(open(path, encoding="utf-8"), 1):
                code = line.split("#", 1)[0]
                if "urlopen(" in code and "fast_http.urlopen(" not in code:
                    offenders.append(f"{os.path.relpath(path, root)}:{number}")
    assert offenders == []
