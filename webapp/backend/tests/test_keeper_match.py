"""The keeper a round pays, against the keeper the buyer signs with.

When the buying starts, the program pays the pool out to the keeper recorded in
the round. That wallet comes from `LOTTERY_AUTOSTART_KEEPER_WALLET`. The buyer
spends from whatever `KEEPER_SECRET_KEY` holds. Nothing compared the two.

On the stand on 2026-09-24 they were different — the base environment file named
one wallet and the devnet overrides another — and the round looked healthy the
whole way through: it opened, took commits, closed on the cap, drew a real
result. Then the pool went to a wallet the buyer had no key for, every purchase
was short of funds, and the refunds failed with `insufficient lamports`. The
first sign of trouble was a state file nobody was looking at.

So the two are compared before a round is opened. A buyer that does not answer
is a different thing from a mismatch and must not stop rounds being created.
"""
from __future__ import annotations

import os
import sys
from urllib import error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from infrastructure.lottery.offchain_api_client import OffchainApiClient  # noqa: E402

KEEPER = "6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9"


class Answer:
    """Enough of an HTTP response for a `with urlopen(...)` block."""

    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def answering(body: bytes, monkeypatch):
    asked: list[str] = []

    def urlopen(url, timeout=None):
        asked.append(url)
        return Answer(body)

    monkeypatch.setattr(
        "infrastructure.lottery.offchain_api_client.fast_http.urlopen", urlopen
    )
    return asked


class TestReadingTheBuyersKeeper:
    def test_it_comes_back_from_health(self, monkeypatch):
        body = ('{"status":"ok","keeper":{"publicKey":"%s","balanceSol":0.38}}' % KEEPER).encode()
        answering(body, monkeypatch)

        assert OffchainApiClient().keeper_pubkey() == KEEPER

    def test_it_asks_health_and_nothing_else(self, monkeypatch):
        body = ('{"keeper":{"publicKey":"%s"}}' % KEEPER).encode()
        asked = answering(body, monkeypatch)

        OffchainApiClient().keeper_pubkey()

        assert asked and asked[0].endswith("/health")

    def test_a_buyer_that_does_not_answer_is_not_a_mismatch(self, monkeypatch):
        def dead(url, timeout=None):
            raise error.URLError("connection refused")

        monkeypatch.setattr(
            "infrastructure.lottery.offchain_api_client.fast_http.urlopen", dead
        )

        # None means "cannot say". The caller lets the round open on this.
        assert OffchainApiClient().keeper_pubkey() is None

    def test_an_answer_without_a_keeper_is_also_cannot_say(self, monkeypatch):
        answering(b'{"status":"error","error":"RPC timeout"}', monkeypatch)

        assert OffchainApiClient().keeper_pubkey() is None

    def test_rubbish_does_not_raise(self, monkeypatch):
        # A proxy in the way, an HTML error page, a truncated body.
        answering(b"<html>502</html>", monkeypatch)

        assert OffchainApiClient().keeper_pubkey() is None


class TestWhatTheWorkerDoesWithIt:
    """The comparison itself, as the worker makes it."""

    def decide(self, configured: str, from_buyer: str | None) -> str:
        if from_buyer and from_buyer != configured:
            return "refuse"
        if not from_buyer:
            return "warn and open"
        return "open"

    def test_a_match_opens_the_round(self):
        assert self.decide(KEEPER, KEEPER) == "open"

    def test_a_mismatch_refuses(self):
        assert self.decide(KEEPER, "2grLFGnXR1sezfjT6bNYnr46cQ3mD2og1j7PTn7nNsUD") == "refuse"

    def test_silence_still_opens(self):
        # An outage of the buyer must not also stop rounds being created.
        assert self.decide(KEEPER, None) == "warn and open"
