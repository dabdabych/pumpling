"""What happens to the round cycle when the RPC provider says no.

On 2026-09-19 the devnet stand stopped opening rounds and stayed that way for
hours. Nothing was broken on chain and nothing was broken in the code that opens
a round. Helius answered 429, solana-py wrapped it in an exception whose `str()`
is empty, the worker's classifier read that empty string, called the failure
unknown, and left the draft in `id_generated`. That status is not terminal, so
every following cycle saw a round in progress and did nothing. The only symptom
was silence.

Two things are checked here, and both fail on the code before the fix:

* a 429 arriving inside an empty wrapper is a transport failure;
* a draft nobody finished stops blocking the cycle by itself.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from solana.exceptions import SolanaRpcException

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

import lottery_phase_worker as worker  # noqa: E402
from domain.lottery.entities.lottery import LotteryStatus  # noqa: E402

NOW = datetime(2026, 9, 19, 15, 36, tzinfo=timezone.utc)


class GetAccountInfo:
    """Stands in for the request body; solana-py names the method after its class."""


def _wrap(inner: Exception) -> SolanaRpcException:
    """Wraps a failure the way solana-py's own decorator does.

    It is built from the provider, the request body and the original error, and
    its `str()` comes out empty — which is the whole point of this file.
    """
    try:
        raise SolanaRpcException(inner, "argument_decorator", object(), GetAccountInfo()) from inner
    except SolanaRpcException as exc:
        return exc


def _rpc_exception(status: int) -> SolanaRpcException:
    """The shape the provider's refusal actually arrives in."""
    request = httpx.Request("POST", "https://devnet.helius-rpc.com/")
    response = httpx.Response(status, request=request)
    return _wrap(httpx.HTTPStatusError(f"Client error '{status}'", request=request, response=response))


class TestTheProviderSaysNo:
    def test_a_429_in_an_empty_wrapper_is_a_transport_failure(self):
        exc = _rpc_exception(429)
        # The message really is empty: reading it is how the bug happened.
        assert str(exc) == ""
        assert worker._phase2_error_kind(exc) == "transport"

    @pytest.mark.parametrize("status", [500, 502, 503, 504])
    def test_server_errors_too(self, status):
        assert worker._phase2_error_kind(_rpc_exception(status)) == "transport"

    def test_a_timeout_with_nothing_to_read_is_transport(self):
        request = httpx.Request("POST", "https://devnet.helius-rpc.com/")
        assert worker._phase2_error_kind(_wrap(httpx.ReadTimeout("timed out", request=request))) == "transport"

    def test_a_refusal_from_the_program_is_not_transport(self):
        # A 400 is the program or our arguments, not the connection: that one
        # does deserve a human.
        assert worker._phase2_error_kind(_rpc_exception(400)) != "transport"

    def test_a_round_level_error_is_still_read_from_the_message(self):
        assert worker._phase2_error_kind(Exception("VrfNotReady")) == "state"
        assert worker._phase2_error_kind(Exception("something new")) == "unknown"


class FakeDraft:
    def __init__(self, lottery_id, status, created_at):
        self.id = lottery_id
        self.lottery_type = "dex"
        self.status = status
        self.created_at = created_at
        self.close_reason = None
        self.initialize_abandoned_at = None
        self.initialize_abandoned_error = None


class FakeQuery:
    """Just enough of the query chain the release pass uses."""

    def __init__(self, rows):
        self._rows = rows

    def filter(self, *conditions):
        # The conditions are SQLAlchemy expressions; the fake applies the rule
        # they express: unfinished drafts older than the cutoff.
        return self

    def all(self):
        return self._rows


class FakeSession:
    def __init__(self, rows):
        self._rows = rows
        self.commits = 0

    def query(self, *args):
        cutoff = NOW - timedelta(seconds=worker._STUCK_DRAFT_GRACE_SECONDS)
        return FakeQuery([
            row for row in self._rows
            if row.status == LotteryStatus.ID_GENERATED and row.created_at < cutoff
        ])

    def commit(self):
        self.commits += 1


class TestADraftNobodyFinished:
    def test_an_old_draft_stops_blocking_the_cycle(self):
        draft = FakeDraft(1789832202135, LotteryStatus.ID_GENERATED, NOW - timedelta(minutes=20))
        session = FakeSession([draft])

        released = worker._release_stuck_drafts(session, "dex", NOW)

        assert released == 1
        assert draft.status == LotteryStatus.INITIALIZE_ABANDONED
        # The status it moves to is terminal, which is what unblocks the cycle,
        # and it is the one the cleanup pass reconciles against the chain.
        assert LotteryStatus.INITIALIZE_ABANDONED in worker._TERMINAL_STATUSES
        assert draft.close_reason == "initialize_stuck"
        assert draft.initialize_abandoned_at == NOW
        assert session.commits == 1

    def test_a_draft_still_being_written_is_left_alone(self):
        fresh = FakeDraft(1789832202136, LotteryStatus.ID_GENERATED, NOW - timedelta(seconds=5))
        session = FakeSession([fresh])

        assert worker._release_stuck_drafts(session, "dex", NOW) == 0
        assert fresh.status == LotteryStatus.ID_GENERATED
        assert session.commits == 0

    def test_the_grace_is_longer_than_an_initialize_and_shorter_than_a_round(self):
        # Long enough that a round being opened right now is never touched,
        # short enough that nobody has to notice the silence.
        assert 60 <= worker._STUCK_DRAFT_GRACE_SECONDS <= 600
