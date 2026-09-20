"""Telling a broken connection apart from a round that says no.

The worker sorts a failed transaction into "transport" or "state", and the only
thing that changes is the log level: a connection that blinked goes out as a
warning, everything else at error level, which is what reaches the alert
channel. So a draw error the classifier does not know is not a silent failure,
it is a noisy one.

The list drifted anyway. The ORAO migration renamed the errors, and the
classifier kept matching the Switchboard names: `RandomnessAccountAlreadyResolved`
was still in the list while the program had started returning
`RandomnessAlreadyResolved`, which the old string does not match. Six of the
names it carried could no longer be produced at all.

The IDL is generated from the program, so it is what the list is measured
against here rather than a copy of the names written out a second time.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

import lottery_phase_worker as worker  # noqa: E402

# The errors the draw can raise. The rest of the program's errors are about
# deposits and limits, and they never reach the phase worker.
DRAW_ERROR_WORDS = ("vrf", "random", "seed", "slot", "weights")
# Set once at initialize, so the phase worker cannot meet it.
NOT_REACHABLE_FROM_PHASE_TWO = {"InvalidVrfAlgorithmHash"}


def draw_errors() -> list[str]:
    with open(os.path.join(_WORKERS, "idl", "lottery.json")) as handle:
        idl = json.load(handle)
    names = [e["name"] for e in idl.get("errors", [])]
    assert names, "the IDL carries no errors; it is probably the wrong file"
    return [
        name for name in names
        if any(word in name.lower() for word in DRAW_ERROR_WORDS)
        and name not in NOT_REACHABLE_FROM_PHASE_TWO
    ]


class AnchorLikeError(Exception):
    """What an Anchor error looks like by the time the worker sees it."""

    def __init__(self, name: str):
        super().__init__(f"AnchorError caused by account: lottery. Error Code: {name}. "
                         f"Error Number: 6021. Error Message: something went wrong.")


class TestEveryDrawErrorIsRecognised:
    @pytest.mark.parametrize("name", draw_errors())
    def test_it_is_read_as_state_not_as_a_broken_connection(self, name):
        assert worker._phase2_error_kind(AnchorLikeError(name)) == "state", (
            f"{name} is not in state_markers, so it would be logged as an unknown failure"
        )


class TestItStillTellsThemApart:
    def test_a_dropped_connection_is_transport(self):
        assert worker._phase2_error_kind(ConnectionError("connection reset by peer")) == "transport"

    def test_a_timeout_is_transport(self):
        assert worker._phase2_error_kind(TimeoutError("request timed out")) == "transport"

    def test_something_else_is_neither(self):
        # An unknown failure must not be quietly filed as a blinking connection:
        # transport is the only class that gets logged below alert level.
        assert worker._phase2_error_kind(ValueError("the buyer returned nonsense")) == "unknown"

    def test_no_marker_has_crept_back_in_that_the_program_cannot_raise(self):
        # The other half of the drift: markers left over from a program that no
        # longer exists. Each one is matched as a substring, so a name that the
        # IDL does not contain is dead weight.
        idl_names = {name.lower() for name in draw_errors()}
        # WrongPhase is a real error of the program, it just does not carry any
        # of the words that pick the draw ones out of the list.
        OURS = {"wrongphase"}
        stale = [
            marker for marker in worker._STATE_MARKERS
            if marker not in idl_names and marker not in OURS
        ]
        assert stale == [], f"markers no program error can produce: {stale}"
