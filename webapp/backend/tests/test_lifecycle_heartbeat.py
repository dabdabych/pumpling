"""The phase worker's heartbeat and the stuck-round detector.

A round lives in the database, not in the logs, so only the worker itself can
notice that it is stuck in a phase. It writes a heartbeat line once a minute and
an error when a phase hangs longer than it should; the Grafana alerts sit on
those lines.

The test checks the thresholds per phase and that the complaint does not become
a stream: the worker goes round its loop every few seconds, and without a limit
one stuck round would flood the chat.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

import lottery_phase_worker as worker  # noqa: E402
from domain.lottery.entities.lottery import LotteryStatus  # noqa: E402


class FakeLottery:
    """Exactly the fields the heartbeat reads."""

    def __init__(self, lottery_id, status, created_at, end_date=None, second_phase_started_at=None, proceeding_purchases_started_at=None):
        self.id = lottery_id
        self.status = status
        self.created_at = created_at
        self.end_date = end_date
        self.second_phase_started_at = second_phase_started_at
        self.proceeding_purchases_started_at = proceeding_purchases_started_at


def _age(lottery, now) -> tuple[int, int]:
    started, limit = worker._phase_reference(lottery, now)
    started = started if started.tzinfo else started.replace(tzinfo=timezone.utc)
    return int((now - started).total_seconds()), limit


NOW = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)
#: The buying window comes from the settings: in production it is longer than
#: the default, and the threshold has to be computed from the real window.
BUY_WINDOW_SECONDS = int(worker._settings().execution_countdown_seconds)


@pytest.mark.parametrize(
    "status,field,minutes,stuck",
    [
        # An open pool is measured from its own closing time.
        (LotteryStatus.CREATED, "end_date", 5, False),
        (LotteryStatus.CREATED, "end_date", 45, True),
        # The draw: a minute of drama plus headroom for VRF retries.
        (LotteryStatus.PHASE2STARTED, "second_phase_started_at", 10, False),
        (LotteryStatus.PHASE2STARTED, "second_phase_started_at", 40, True),
        (LotteryStatus.VRF_BINDED, "second_phase_started_at", 40, True),
        (LotteryStatus.VRF_FULFILLED, "second_phase_started_at", 10, False),
        # The buying: the window plus half an hour of headroom. Measured from
        # the configured window, not from a round number of minutes.
        (LotteryStatus.PROCEEDING_PURCHASES, "proceeding_purchases_started_at", BUY_WINDOW_SECONDS // 60 + 10, False),
        (LotteryStatus.PROCEEDING_PURCHASES, "proceeding_purchases_started_at", BUY_WINDOW_SECONDS // 60 + 45, True),
        # Creating a round: if it never reached created, that is an incident.
        (LotteryStatus.ID_GENERATED, "created_at", 3, False),
        (LotteryStatus.ID_GENERATED, "created_at", 30, True),
    ],
)
def test_phase_limits(status, field, minutes, stuck):
    moment = NOW - timedelta(minutes=minutes)
    lottery = FakeLottery(1, status, created_at=moment, **({field: moment} if field != "created_at" else {}))
    age, limit = _age(lottery, NOW)
    assert (age > limit) is stuck, f"{status.value}: age {age // 60} min against a threshold of {limit // 60} min"


def test_missing_timestamps_fall_back_to_creation():
    # The data can be incomplete; the heartbeat must not fail on None.
    lottery = FakeLottery(2, LotteryStatus.PROCEEDING_PURCHASES, created_at=NOW - timedelta(hours=24))
    age, limit = _age(lottery, NOW)
    assert age > limit


def test_a_stuck_round_is_reported_once_per_hour(monkeypatch, caplog):
    real_now = datetime.now(timezone.utc)
    stuck = FakeLottery(
        7,
        LotteryStatus.PROCEEDING_PURCHASES,
        created_at=real_now - timedelta(hours=4),
        proceeding_purchases_started_at=real_now - timedelta(hours=3),
    )

    class FakeQuery:
        def filter(self, *_):
            return self

        def all(self):
            return [stuck]

    class FakeSession:
        def query(self, *_):
            return FakeQuery()

    worker._stuck_reported_at.clear()
    worker._heartbeat_logged_at = None
    clock = {"value": 1000.0}
    monkeypatch.setattr(worker.time, "monotonic", lambda: clock["value"])

    with caplog.at_level("INFO"):
        worker._log_lifecycle_heartbeat(FakeSession())
        first = [record for record in caplog.records if "lifecycle-stuck" in record.getMessage()]
        assert len(first) == 1, "the first complaint has to go out"
        assert "lottery_id=7" in first[0].getMessage()

        caplog.clear()
        clock["value"] += 61
        worker._log_lifecycle_heartbeat(FakeSession())
        assert not [r for r in caplog.records if "lifecycle-stuck" in r.getMessage()], "no repeat a minute later"
        # The heartbeat still runs: it shows the worker is alive.
        assert [r for r in caplog.records if "lifecycle-heartbeat" in r.getMessage()]

        caplog.clear()
        clock["value"] += 3600 + 1
        worker._log_lifecycle_heartbeat(FakeSession())
        assert [r for r in caplog.records if "lifecycle-stuck" in r.getMessage()], "an hour later it has to remind us"

    worker._stuck_reported_at.clear()
    worker._heartbeat_logged_at = None


def test_heartbeat_does_not_flood_the_log(monkeypatch, caplog):
    """A loop pass takes seconds, and a line per pass drowns the logs."""

    class EmptyQuery:
        def filter(self, *_):
            return self

        def all(self):
            return []

    class EmptySession:
        def query(self, *_):
            return EmptyQuery()

    worker._heartbeat_logged_at = None
    clock = {"value": 500.0}
    monkeypatch.setattr(worker.time, "monotonic", lambda: clock["value"])

    with caplog.at_level("INFO"):
        for _ in range(40):
            worker._log_lifecycle_heartbeat(EmptySession())
            clock["value"] += 3.0

    beats = [r for r in caplog.records if "lifecycle-heartbeat" in r.getMessage()]
    # Forty passes of three seconds is two minutes, so exactly two heartbeats.
    assert len(beats) == 2, f"expected a heartbeat a minute, got {len(beats)}"

    worker._heartbeat_logged_at = None


def test_heartbeat_reports_the_quiet_case(caplog):
    class EmptyQuery:
        def filter(self, *_):
            return self

        def all(self):
            return []

    class EmptySession:
        def query(self, *_):
            return EmptyQuery()

    worker._heartbeat_logged_at = None
    with caplog.at_level("INFO"):
        worker._log_lifecycle_heartbeat(EmptySession())

    beats = [record.getMessage() for record in caplog.records if "lifecycle-heartbeat" in record.getMessage()]
    assert beats, "there has to be a heartbeat even with no rounds"
    assert "active=0" in beats[0] and "stuck=0" in beats[0]


# =============================================================================
# THE BUYER IS UNREACHABLE
# =============================================================================


def test_unreachable_buyer_does_not_flood_the_alert_channel(caplog):
    """The buyer is silent — we complain the first few times and then hourly.

    Retries back off to a minute, and without this caveat a night would put
    several hundred identical messages into the alert channel: a real incident
    would drown among them.
    """
    lottery_id = 4242
    worker._BUYER_START_STATE.pop(lottery_id, None)
    worker._BUYER_START_FIRST_FAIL_AT.pop(lottery_id, None)
    worker._BUYER_START_LAST_LOUD_AT.pop(lottery_id, None)

    moment = datetime(2026, 9, 18, 3, 0, tzinfo=timezone.utc)
    loud = 0
    quiet = 0

    with caplog.at_level("WARNING"):
        # An hour of silence from the buyer: a retry every minute.
        for minute in range(60):
            now = moment + timedelta(minutes=minute)
            worker._record_buyer_start_failure(lottery_id, now)
            caplog.clear()
            worker._log_buyer_start_failure(lottery_id, now, "Buyer start failed")
            levels = [record.levelname for record in caplog.records]
            loud += levels.count("ERROR")
            quiet += levels.count("WARNING")

    assert loud == worker._BUYER_START_LOUD_ATTEMPTS, f"{loud} messages went out at full volume"
    assert quiet == 60 - worker._BUYER_START_LOUD_ATTEMPTS

    # An hour later we remind: the problem has not gone away.
    later = moment + timedelta(minutes=61)
    worker._record_buyer_start_failure(lottery_id, later)
    with caplog.at_level("WARNING"):
        caplog.clear()
        worker._log_buyer_start_failure(lottery_id, later, "Buyer start failed")
        assert [record.levelname for record in caplog.records] == ["ERROR"]
        assert "minutes=61" in caplog.records[0].getMessage()

    # The buyer came back — forget about it.
    worker._mark_buyer_started(lottery_id)
    assert lottery_id not in worker._BUYER_START_FIRST_FAIL_AT
    assert lottery_id not in worker._BUYER_START_LAST_LOUD_AT
