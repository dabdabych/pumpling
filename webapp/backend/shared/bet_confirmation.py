from __future__ import annotations

from sqlalchemy import or_


BET_STATUS_CONFIRMED = "confirmed"
BET_STATUS_FINALIZED = "finalized"
BET_STATUS_ORPHANED = "orphaned"
ACTIVE_BET_STATUSES = (BET_STATUS_CONFIRMED, BET_STATUS_FINALIZED)


def active_bet_condition(model):
    status_column = model.confirmation_status
    return or_(status_column.is_(None), status_column.in_(ACTIVE_BET_STATUSES))


def is_orphaned_bet(value: object) -> bool:
    return str(value or "").strip().lower() == BET_STATUS_ORPHANED
