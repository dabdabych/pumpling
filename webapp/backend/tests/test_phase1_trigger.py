"""
Closing the first phase: on time OR on the vault being full.

The closing threshold is the cap MINUS the minimum commit (0.05 SOL by the
program's default). As soon as the free capacity drops below a minimum commit,
nothing more can be placed: the program would reject both one that is too small
and one that exceeds the cap. At that point the pool is frozen and there is no
reason to wait for the window to end.

A regression. The threshold used to be a hardcoded number:
PHASE2_CAP_THRESHOLD_SOL = 221.95 with a cap of 222. That worked not by design
but because 221.95 = 222 - 0.05 happened to match the formula we needed. After
the cap came down to 111 the threshold became min(221.95, 111) = 111, and the
pool never rises above the cap — the condition became unreachable and a round
with a full vault would hang for all 111 minutes.
"""

import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "workers"))

from lottery_phase_worker import Phase1Candidate, _should_trigger_phase2  # noqa: E402

NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
STILL_OPEN = NOW + timedelta(minutes=170)


def _candidate(pool: str, max_total: str | None, end_date: datetime) -> Phase1Candidate:
    return Phase1Candidate(
        lottery_id=1,
        status="created",
        end_date=end_date,
        max_total=Decimal(max_total) if max_total is not None else None,
        total_pool_sol=Decimal(pool),
        randomness_account=None,
    )


def test_closes_when_vault_is_exactly_full() -> None:
    # Exactly the cap: the program takes no more, so there is nothing to wait for
    assert _should_trigger_phase2(_candidate("111", "111", STILL_OPEN), NOW)


def test_closes_when_the_remainder_is_below_the_minimum_bet() -> None:
    # The dead zone: less than 0.05 from the cap, so no commit can go through.
    # This is what a check for exact equality with the cap used to miss.
    for pool in ("110.96", "110.99", "110.99999999"):
        assert _should_trigger_phase2(_candidate(pool, "111", STILL_OPEN), NOW), pool


def test_stays_open_while_a_minimum_bet_still_fits() -> None:
    # 110.95 + 0.05 = 111 — a minimum commit still fits exactly
    for pool in ("0", "50", "110", "110.95"):
        assert not _should_trigger_phase2(_candidate(pool, "111", STILL_OPEN), NOW), pool


def test_closes_when_the_window_expired() -> None:
    assert _should_trigger_phase2(_candidate("50", "111", NOW), NOW)


def test_old_cap_behaviour_is_preserved() -> None:
    # With a cap of 222 the formula gives the same 221.95 that used to be hardcoded
    assert not _should_trigger_phase2(_candidate("221.9", "222", STILL_OPEN), NOW)
    assert not _should_trigger_phase2(_candidate("221.95", "222", STILL_OPEN), NOW)
    assert _should_trigger_phase2(_candidate("221.96", "222", STILL_OPEN), NOW)
    assert _should_trigger_phase2(_candidate("222", "222", STILL_OPEN), NOW)


def test_without_a_cap_the_configured_fallback_applies() -> None:
    # No cap, so nothing to compute from: PHASE2_CAP_THRESHOLD_SOL (110.95) applies
    assert not _should_trigger_phase2(_candidate("100", None, STILL_OPEN), NOW)
    assert not _should_trigger_phase2(_candidate("110.95", None, STILL_OPEN), NOW)
    assert _should_trigger_phase2(_candidate("110.96", None, STILL_OPEN), NOW)


def test_a_cap_above_the_fallback_does_not_close_early() -> None:
    """
    A round with a cap above the default must not close at the default.

    The opposite trap to the original bug. If the threshold were computed as
    min(setting, cap - 0.05), then with a default of 110.95 a round with a cap of
    200 would close at 110.95, almost twice as early as it filled. There is no
    upper limit on max_total in the admin form, so such a round can be created.
    """
    assert not _should_trigger_phase2(_candidate("150", "200", STILL_OPEN), NOW)
    assert not _should_trigger_phase2(_candidate("199.95", "200", STILL_OPEN), NOW)
    assert _should_trigger_phase2(_candidate("199.96", "200", STILL_OPEN), NOW)
