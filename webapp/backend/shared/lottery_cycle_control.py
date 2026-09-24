from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from infrastructure.database.models.lottery_cycle_control_model import LotteryCycleControlModel


# One cycle. The `pumpfun` one was retired; a deployment that ran it keeps its
# row in `lottery_cycle_controls`, which nothing reads any more.
SUPPORTED_LOTTERY_TYPES = ("dex",)
_TABLE_READY = False


@dataclass(frozen=True)
class LotteryCycleControl:
    lottery_type: str
    enabled: bool
    stop_requested_at: datetime | None
    hype_launch_at: datetime | None
    updated_at: datetime | None


def normalize_lottery_type(raw_value: str) -> str:
    value = (raw_value or "").strip().lower()
    if value not in SUPPORTED_LOTTERY_TYPES:
        raise ValueError("lottery_type must be 'dex'")
    return value


def _to_control(row: LotteryCycleControlModel) -> LotteryCycleControl:
    return LotteryCycleControl(
        lottery_type=str(row.lottery_type),
        enabled=bool(row.enabled),
        stop_requested_at=row.stop_requested_at,
        hype_launch_at=row.hype_launch_at,
        updated_at=row.updated_at,
    )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def ensure_cycle_control_table(session: Session) -> None:
    global _TABLE_READY
    if _TABLE_READY:
        return

    session.execute(text("""
        CREATE TABLE IF NOT EXISTS lottery_cycle_controls (
            lottery_type VARCHAR(32) PRIMARY KEY,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            stop_requested_at TIMESTAMPTZ NULL,
            hype_launch_at TIMESTAMPTZ NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """))
    session.execute(text("""
        ALTER TABLE lottery_cycle_controls
        ADD COLUMN IF NOT EXISTS hype_launch_at TIMESTAMPTZ NULL
    """))
    session.execute(text("""
        INSERT INTO lottery_cycle_controls (lottery_type, enabled)
        VALUES ('dex', TRUE)
        ON CONFLICT (lottery_type) DO NOTHING
    """))
    session.commit()
    _TABLE_READY = True


def ensure_cycle_control(session: Session, lottery_type: str) -> LotteryCycleControlModel:
    ensure_cycle_control_table(session)
    normalized = normalize_lottery_type(lottery_type)
    row = session.query(LotteryCycleControlModel).filter(
        LotteryCycleControlModel.lottery_type == normalized
    ).first()
    if row is not None:
        return row

    row = LotteryCycleControlModel(lottery_type=normalized, enabled=True)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def list_cycle_controls(session: Session) -> list[LotteryCycleControl]:
    ensure_cycle_control_table(session)
    rows = []
    for lottery_type in SUPPORTED_LOTTERY_TYPES:
        rows.append(_to_control(ensure_cycle_control(session, lottery_type)))
    return rows


def set_cycle_enabled(session: Session, lottery_type: str, enabled: bool) -> LotteryCycleControl:
    row = ensure_cycle_control(session, lottery_type)
    now = _utc_now()
    row.enabled = bool(enabled)
    row.stop_requested_at = None if enabled else now
    row.hype_launch_at = None
    row.updated_at = now
    session.commit()
    session.refresh(row)
    return _to_control(row)


def is_cycle_enabled(session: Session, lottery_type: str) -> bool:
    return bool(ensure_cycle_control(session, lottery_type).enabled)


def reconcile_hype_countdown(
    session: Session,
    lottery_type: str,
    countdown_seconds: int,
    has_blocking_lottery: bool,
    now: datetime | None = None,
) -> LotteryCycleControl:
    row = ensure_cycle_control(session, lottery_type)
    now_utc = _as_utc(now) or _utc_now()
    countdown_seconds = max(0, int(countdown_seconds or 0))

    if row.enabled:
        if row.hype_launch_at is not None:
            row.hype_launch_at = None
            row.updated_at = now_utc
            session.commit()
            session.refresh(row)
        return _to_control(row)

    if countdown_seconds <= 0:
        if row.hype_launch_at is not None:
            row.hype_launch_at = None
            row.updated_at = now_utc
            session.commit()
            session.refresh(row)
        return _to_control(row)

    if has_blocking_lottery:
        return _to_control(row)

    launch_at = _as_utc(row.hype_launch_at)
    if launch_at is None:
        row.hype_launch_at = now_utc + timedelta(seconds=countdown_seconds)
        row.updated_at = now_utc
        session.commit()
        session.refresh(row)
        return _to_control(row)

    if launch_at > now_utc:
        return _to_control(row)

    row.enabled = True
    row.stop_requested_at = None
    row.hype_launch_at = None
    row.updated_at = now_utc
    session.commit()
    session.refresh(row)
    return _to_control(row)
