"""The launch countdown: when it reaches zero, the round cycle switches itself on.

Production launches on 2026-10-04 at 19:00 UTC this way: `hype_launch_at` in
`lottery_cycle_controls`, the cycle off, and `reconcile_hype_countdown`, which
the phase worker calls every second, turns it on when the moment comes. Then
the worker opens the first pool. Nothing else has to happen by hand, and
nothing may happen early: a pool opened before the moment would take real SOL
before the announced launch.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import lottery_cycle_control as cycle  # noqa: E402

LAUNCH = datetime(2026, 10, 4, 19, 0, tzinfo=timezone.utc)
PROD_COUNTDOWN_SECONDS = 777200  # LOTTERY_HYPE_COUNTDOWN_SECONDS on production


@pytest.fixture
def session(monkeypatch):
    from infrastructure.database.database import Base
    from infrastructure.database.models.lottery_cycle_control_model import LotteryCycleControlModel

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryCycleControlModel.__table__])
    # The module creates the table with Postgres-only SQL; here the model made it.
    monkeypatch.setattr(cycle, "_TABLE_READY", True)
    db = sessionmaker(bind=engine)()
    db.add(LotteryCycleControlModel(lottery_type="dex", enabled=False, hype_launch_at=LAUNCH, updated_at=LAUNCH - timedelta(days=4)))
    db.commit()
    yield db
    db.close()


def state(session):
    from infrastructure.database.models.lottery_cycle_control_model import LotteryCycleControlModel

    session.expire_all()
    row = session.query(LotteryCycleControlModel).filter_by(lottery_type="dex").one()
    launch = row.hype_launch_at.replace(tzinfo=timezone.utc) if row.hype_launch_at and row.hype_launch_at.tzinfo is None else row.hype_launch_at
    return row.enabled, launch


def test_a_second_before_the_launch_nothing_opens(session):
    control = cycle.reconcile_hype_countdown(session, "dex", PROD_COUNTDOWN_SECONDS, False, now=LAUNCH - timedelta(seconds=1))
    assert control.enabled is False
    assert state(session) == (False, LAUNCH), "the moment stays where it was set"


def test_at_the_launch_the_cycle_switches_on(session):
    control = cycle.reconcile_hype_countdown(session, "dex", PROD_COUNTDOWN_SECONDS, False, now=LAUNCH)
    assert control.enabled is True
    assert state(session) == (True, None), "on, and the countdown is spent"


def test_a_worker_that_was_down_at_the_moment_launches_when_it_is_back(session):
    control = cycle.reconcile_hype_countdown(session, "dex", PROD_COUNTDOWN_SECONDS, False, now=LAUNCH + timedelta(minutes=7))
    assert control.enabled is True


def test_a_round_still_running_holds_the_launch(session):
    # A pool of the old kind not yet closed: the new cycle waits for it.
    control = cycle.reconcile_hype_countdown(session, "dex", PROD_COUNTDOWN_SECONDS, True, now=LAUNCH + timedelta(minutes=1))
    assert control.enabled is False
    assert state(session) == (False, LAUNCH)


def test_polling_every_second_before_the_moment_changes_nothing(session):
    for seconds in range(-5, 0):
        cycle.reconcile_hype_countdown(session, "dex", PROD_COUNTDOWN_SECONDS, False, now=LAUNCH + timedelta(seconds=seconds))
    assert state(session) == (False, LAUNCH)
    cycle.reconcile_hype_countdown(session, "dex", PROD_COUNTDOWN_SECONDS, False, now=LAUNCH)
    assert state(session)[0] is True


def test_a_countdown_turned_off_in_the_settings_clears_the_moment_and_opens_nothing(session):
    control = cycle.reconcile_hype_countdown(session, "dex", 0, False, now=LAUNCH + timedelta(hours=1))
    assert control.enabled is False and state(session) == (False, None)
