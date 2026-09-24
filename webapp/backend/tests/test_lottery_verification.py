"""The endpoint the "Verify this pool" button reads.

On 2026-09-19 that button showed "Could not load the proof right now" on every
live pool. Nothing was missing from the data: the handler referenced
`BetParticipationModel`, which this module imports inside the functions that
need it, and that one function never imported it. Every call answered 500 with a
NameError, so the one page that exists to remove the need for trust asked for
trust instead.

The whole handler is exercised here rather than the query alone: a name that is
only resolved at call time cannot be caught by reading the file, and this is the
single place where nobody signs in first, so nothing else would notice.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from presentation.lottery import lottery_router as router  # noqa: E402

NOW = datetime(2026, 9, 19, 18, 0, tzinfo=timezone.utc)
LOTTERY_ID = 1789840890636


class FakeLottery:
    def __init__(self):
        self.id = LOTTERY_ID
        self.lottery_type = "dex"
        self.status = "buying"
        self.vrf_seed = None
        self.is_offchain_vrf = False
        self.created_at = NOW
        self.end_date = NOW


class FakeQuery:
    """The two shapes the handler asks for: the round, and the sums per coin."""

    def __init__(self, rows, lottery):
        self._rows = rows
        self._lottery = lottery
        self._is_lottery_query = False

    def filter(self, *_):
        return self

    def group_by(self, *_):
        return self

    def first(self):
        return self._lottery

    def all(self):
        return self._rows


class FakeSession:
    def __init__(self, rows, lottery):
        self._rows = rows
        self._lottery = lottery

    def query(self, *args):
        # The round is fetched as a whole model, the sums as columns.
        if len(args) == 1 and getattr(args[0], "__name__", "") == "LotteryModel":
            return FakeQuery([], self._lottery)
        return FakeQuery(self._rows, self._lottery)


@pytest.fixture
def offline(monkeypatch):
    """No network in a unit test: the handler already treats it as unreachable."""

    class DeadClient:
        def __init__(self, *_, **__):
            raise OSError("no network in tests")

    monkeypatch.setattr(router, "Client", DeadClient)


class FakeEventRow:
    def __init__(self, data):
        self.data = data


class EventQuery:
    """The chain of filters the events fallback uses."""

    def __init__(self, rows):
        self._rows = rows
        self._name = None

    def filter(self, *conditions):
        # The event name is on the right of the comparison, as a bound value.
        # Rendering the expression to a string hides it behind a placeholder,
        # so the value is read off the node instead.
        for condition in conditions:
            value = getattr(getattr(condition, "right", None), "value", None)
            if value in ("Phase2Started", "LotteryInitialized"):
                self._name = value
        return self

    def order_by(self, *_):
        return self

    def first(self):
        data = self._rows.get(self._name)
        return FakeEventRow(data) if data else None


class ClosedRoundSession(FakeSession):
    """A round whose account is gone: only the events it emitted are left."""

    def __init__(self, rows, events):
        super().__init__(rows, FakeLottery())
        self._events = events

    def query(self, *args):
        name = getattr(args[0], "__name__", "") if args else ""
        if name == "SmartContractEventModel":
            return EventQuery(self._events)
        return super().query(*args)


@pytest.fixture
def closed(offline, monkeypatch):
    """No account on chain, and an address to look the events up by."""
    monkeypatch.setattr(
        router, "_derive_lottery_account_summary",
        lambda *_a, **_k: ("pda", "vault", "admin"),
    )


class TestARoundThatHasClosed:
    """`close_lottery` returns the account's rent, so the account is deleted.

    Everything the verification page reads off it goes at the same moment. It
    used to answer "the commitment did not match" for every finished round,
    which reads as our own check failing rather than as the account being gone.
    """

    WEIGHTS = [1] * 32
    ALGORITHM = [2] * 32
    FORCE = [3] * 32

    def _events(self, weights=None):
        return {
            "Phase2Started": {
                "lottery": "pda",
                "weights_hash": weights if weights is not None else self.WEIGHTS,
                "randomness_account": "6JViNMPPhucr1AYsqFx6rqGqKFpd6iMxEEHoXPztrugJ",
                "force": self.FORCE,
                "seed_slot": 501465892,
            },
            "LotteryInitialized": {"lottery": "pda", "vrf_algorithm_hash": self.ALGORITHM},
        }

    def test_the_proof_comes_back_from_the_events(self, closed):
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5"))]
        session = ClosedRoundSession(rows, self._events())

        answer = router.get_lottery_verification(LOTTERY_ID, db=session)

        assert answer.weights_hash_onchain == bytes([1] * 32).hex()
        assert answer.vrf_algorithm_hash == bytes([2] * 32).hex()
        assert answer.randomness_account == "6JViNMPPhucr1AYsqFx6rqGqKFpd6iMxEEHoXPztrugJ"

    def test_a_commitment_that_disagrees_is_still_reported(self, closed):
        # The fallback must not paper over a real mismatch.
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5"))]
        session = ClosedRoundSession(rows, self._events(weights=[9] * 32))

        answer = router.get_lottery_verification(LOTTERY_ID, db=session)

        assert answer.weights_match is False

    def test_nothing_to_compare_is_unknown_not_a_failure(self, closed):
        # No account and no event: the honest answer is that we cannot say,
        # not that the round failed its own check.
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5"))]
        session = ClosedRoundSession(rows, {})

        answer = router.get_lottery_verification(LOTTERY_ID, db=session)

        assert answer.weights_match is None
        assert answer.weights_hash_recomputed


class TestVerificationAnswers:
    def test_a_pool_with_commits_verifies(self, offline):
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5")),
                ("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", Decimal("0.5"))]
        session = FakeSession(rows, FakeLottery())

        answer = router.get_lottery_verification(LOTTERY_ID, db=session)

        assert answer.lottery_id == LOTTERY_ID
        # The preimage is the point: it is what anyone hashes themselves.
        assert answer.weights_payload
        assert answer.weights_hash_recomputed
        # No randomness yet while the pool is still being bought into.
        assert answer.randomness_source == "pending"

    def test_an_empty_pool_verifies_too(self, offline):
        # A round nobody entered still has to answer: the page is public and it
        # is linked from the pool before the first commit arrives.
        session = FakeSession([], FakeLottery())

        answer = router.get_lottery_verification(LOTTERY_ID, db=session)

        assert answer.lottery_id == LOTTERY_ID
        assert answer.randomness_source == "pending"

    def test_a_round_that_does_not_exist_is_a_404(self, offline):
        from fastapi import HTTPException

        session = FakeSession([], None)

        with pytest.raises(HTTPException) as caught:
            router.get_lottery_verification(LOTTERY_ID, db=session)

        assert caught.value.status_code == 404
