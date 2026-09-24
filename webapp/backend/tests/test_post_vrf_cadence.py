"""How often a round that is already buying gets looked at.

A round in the buying phase is waiting for its window to run out, and on
mainnet that window is fifty-five minutes. Nothing on chain changes in it more
than twice. Asking every second meant three thousand identical questions per
round, two rounds at a time, around the clock, and every one of them is a call
somebody bills for.

The draw is a different matter and keeps the fast loop: there a second of delay
is a second a round sits closed with its buy not yet announced. So the two have
separate cadences, and this is the test that they stay separate.
"""
from __future__ import annotations

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


@pytest.fixture(autouse=True)
def clean_state():
    worker._POST_VRF_LAST_POLL.clear()
    yield
    worker._POST_VRF_LAST_POLL.clear()


class TestTheGate:
    def test_the_first_look_always_goes_through(self):
        assert worker._post_vrf_poll_due(1, now=1000.0) is True

    def test_the_next_one_waits(self):
        worker._post_vrf_poll_due(1, now=1000.0)
        assert worker._post_vrf_poll_due(1, now=1001.0) is False
        assert worker._post_vrf_poll_due(1, now=1014.9) is False

    def test_and_goes_through_once_the_interval_has_passed(self):
        worker._post_vrf_poll_due(1, now=1000.0)
        assert worker._post_vrf_poll_due(1, now=1015.0) is True

    def test_two_rounds_do_not_take_each_other_s_turn(self):
        # They run side by side. One arriving must not push the other back,
        # which a single global timestamp would have done.
        assert worker._post_vrf_poll_due(1, now=1000.0) is True
        assert worker._post_vrf_poll_due(2, now=1000.1) is True
        assert worker._post_vrf_poll_due(1, now=1001.0) is False
        assert worker._post_vrf_poll_due(2, now=1001.0) is False

    def test_the_clock_is_the_only_thing_that_opens_it(self):
        worker._post_vrf_poll_due(7, now=500.0)
        blocked = sum(1 for t in range(501, 515) if worker._post_vrf_poll_due(7, now=float(t)))
        assert blocked == 0


class TestWhatItSavesAndWhatItDoesNotTouch:
    def test_the_draw_keeps_its_own_fast_cadence(self):
        # If these ever became the same number, the draw would slow to a
        # crawl and the saving would have been paid for in the wrong place.
        assert worker.POST_VRF_POLL_INTERVAL_SECONDS >= 10
        assert worker.EMERGENCY_FULFILL_DELAY_SECONDS == 120

    def test_the_interval_can_be_turned_down_without_a_deploy(self, monkeypatch):
        monkeypatch.setenv("POST_VRF_POLL_INTERVAL_SECONDS", "30")
        assert worker._env_seconds("POST_VRF_POLL_INTERVAL_SECONDS", 15.0) == 30.0

    @pytest.mark.parametrize("bad", ["", "   ", "nonsense", "0", "-5"])
    def test_nonsense_falls_back_rather_than_stopping_the_worker(self, monkeypatch, bad):
        # A zero or a minus here would either poll in a tight loop or never
        # poll at all, and a round would sit in the buying phase forever.
        monkeypatch.setenv("POST_VRF_POLL_INTERVAL_SECONDS", bad)
        assert worker._env_seconds("POST_VRF_POLL_INTERVAL_SECONDS", 15.0) == 15.0

    def test_the_saving_is_the_point(self):
        # Mainnet: a 55-minute buying window, two rounds side by side.
        window = 55 * 60
        before = window / 1.0 * 2 * 2
        after = window / worker.POST_VRF_POLL_INTERVAL_SECONDS * 2 * 2
        assert after * 10 <= before, f"{before:.0f} -> {after:.0f} calls per cycle is not worth the code"


class TestWhatTheSlowCadenceMustNotTouch:
    """The gate covers the waiting, not the moment the waiting starts.

    `_list_post_vrf_candidates` returns two states. `PROCEEDING_PURCHASES` is a
    round watching its window run out and there is nothing to do in it.
    `VRF_FULFILLED` is the gap between the draw landing and
    `start_purchases_phase`, the transaction that releases the pool and starts
    the buying. Slowing that one down delays the thing the round exists to do,
    while a countdown is running on the pool page saying it is about to happen.

    The first version of this gate covered both. It read as a saving and was a
    fifteen-second pause in front of the buy.
    """

    def test_the_loop_only_gates_the_buying_state(self):
        import re

        source = open(os.path.join(_WORKERS, "lottery_phase_worker.py")).read()
        loop = re.search(
            r"for candidate in post_vrf_candidates:(.*?)\n    await _process_lottery_autostart",
            source,
            re.S,
        )
        assert loop, "the post-VRF loop moved"
        guard = re.search(r"if candidate\.status == ([^\s]+) and not _post_vrf_poll_due", loop.group(1))
        assert guard, "the gate no longer checks the state; VRF_FULFILLED would be slowed too"
        assert guard.group(1).endswith("PROCEEDING_PURCHASES")

    def test_the_two_states_are_still_both_collected(self):
        # Narrowing the gate must not turn into narrowing what the worker looks
        # at: a round stuck in VRF_FULFILLED with nobody collecting it never
        # starts buying at all.
        import re

        source = open(os.path.join(_WORKERS, "lottery_phase_worker.py")).read()
        listing = re.search(r"def _list_post_vrf_candidates.*?\n\n\n", source, re.S).group(0)
        assert "VRF_FULFILLED" in listing
        assert "PROCEEDING_PURCHASES" in listing
