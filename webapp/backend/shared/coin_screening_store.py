"""The coin-screening queue in the database, and the one check it runs.

The worker (`workers/coin_screening_worker.py`) calls these in a loop: queue the
coins that got a first confirmed commit, run the checks that are due, record how
each ended. Kept here rather than in the worker so the tests can run them on
SQLite without a worker process.

A check ends `clean`, `flagged` or `unavailable`. Until then it is `pending` and
tried again with growing pauses: a provider that does not answer is the usual
reason. It gives up at `GIVE_UP_AFTER`, by when the pool has been bought, and
ends `unavailable`, which the site shows as nothing.

The trigger is a confirmed commit, not a coin typed into the dialog: a commit
costs real SOL, so nobody can burn through the providers' daily quota by
scripting the coin box.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from infrastructure.database.models.bet_participation_model import BetParticipationModel
from infrastructure.database.models.coin_screening_model import CoinScreeningModel
from shared.bet_confirmation import active_bet_condition
from shared.coin_screening import MIN_AGE_MINUTES, SOURCE_CHAIN, ChainRead, Decision, HolderView, ProviderAnswer, decide

logger = logging.getLogger(__name__)

#: Commits older than this are not queued: their pool has been bought.
LOOKBACK = timedelta(hours=3)
#: A check still pending this long after the first commit gives up.
GIVE_UP_AFTER = timedelta(hours=3)
#: Pauses between tries, by the number of tries so far; the last one repeats.
RETRY_PAUSES = (timedelta(seconds=30), timedelta(minutes=1), timedelta(minutes=2), timedelta(minutes=5), timedelta(minutes=10))

FINAL = ("clean", "flagged", "unavailable")


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def enqueue_new(session: Session, now: datetime) -> int:
    """A pending check for every coin with a confirmed commit in a pool and no check yet."""
    since = now - LOOKBACK
    firsts = (
        session.query(
            BetParticipationModel.lottery_id,
            BetParticipationModel.meme_coin_address,
            func.min(BetParticipationModel.created_at),
        )
        .filter(active_bet_condition(BetParticipationModel), BetParticipationModel.created_at >= since)
        .group_by(BetParticipationModel.lottery_id, BetParticipationModel.meme_coin_address)
        .all()
    )
    if not firsts:
        return 0
    lottery_ids = {row[0] for row in firsts}
    known = {
        (lottery_id, mint)
        for lottery_id, mint in session.query(CoinScreeningModel.lottery_id, CoinScreeningModel.mint)
        .filter(CoinScreeningModel.lottery_id.in_(lottery_ids))
        .all()
    }
    added = 0
    for lottery_id, mint, first_at in firsts:
        mint = str(mint or "").strip()
        if not mint or (lottery_id, mint) in known:
            continue
        session.add(CoinScreeningModel(
            lottery_id=lottery_id,
            mint=mint,
            status="pending",
            reasons=[],
            missing=[],
            first_commit_at=_utc(first_at) or now,
            attempts=0,
            next_attempt_at=now,
        ))
        added += 1
    session.commit()
    return added


def due(session: Session, now: datetime, limit: int) -> list[CoinScreeningModel]:
    return (
        session.query(CoinScreeningModel)
        .filter(CoinScreeningModel.status == "pending", CoinScreeningModel.next_attempt_at <= now)
        .order_by(CoinScreeningModel.next_attempt_at)
        .limit(limit)
        .all()
    )


@dataclass(frozen=True)
class Outcome:
    """How one try ended: a final status, or `retry` at a time."""

    status: str
    reasons: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    source: Optional[str] = None
    retry_at: Optional[datetime] = None
    error: Optional[str] = None
    #: What the provider read, rule by rule, for the site to show as it was.
    levels: dict[str, str] = field(default_factory=dict)
    on_curve: Optional[bool] = None


def judge(chain: ChainRead, answer: ProviderAnswer, now: datetime, on_curve: Optional[bool] = None) -> Outcome:
    """One try's result from what the chain and the providers said. Pure.

    - No such mint on the chain ends it `unavailable`: there is no coin to judge.
    - A flag from either half ends it at once: one is enough. The holdings of a
      coin younger than `MIN_AGE_MINUTES` are not read yet: it waits until it is
      that old, unless the mint itself has already flagged it.
    - Clean needs the mint read and the creator's share known.
    - A source with no data on the coin ends it `unavailable`; no source
      answering, or the mint not read, means try again.
    """
    if chain.state == "missing":
        return Outcome("unavailable", source=SOURCE_CHAIN, error="no such mint on this network")
    chain_flags = chain.flags if chain.state == "read" else None
    holders: Optional[HolderView] = answer.holders if answer.kind == "answer" else None
    # The mint's own powers do not change with age, the holdings of a coin a
    # minute old do: they are only read once it is old enough.
    young = holders is not None and holders.age_minutes is not None and holders.age_minutes < MIN_AGE_MINUTES
    decision: Decision = decide(chain_flags, None if young else holders, on_curve)
    if decision.status == "flagged":
        settled_by = None if young else holders
        return Outcome("flagged", decision.reasons, settled_by.missing() if settled_by else [], decision.source,
                       levels=settled_by.levels() if settled_by else {}, on_curve=on_curve)
    if young:
        wait = timedelta(minutes=MIN_AGE_MINUTES - holders.age_minutes) + timedelta(seconds=5)
        return Outcome("retry", retry_at=now + wait, error="coin younger than the minimum age")
    if decision.status == "clean":
        return Outcome("clean", [], holders.missing() if holders else [], decision.source,
                       levels=holders.levels() if holders else {}, on_curve=on_curve)

    if chain_flags is not None:
        if answer.kind == "no_data" or (holders is not None and holders.dev == "unknown"):
            return Outcome("unavailable", source=SOURCE_CHAIN, error="no holder data on this coin")
    error = "mint not read" if chain_flags is None else f"holder data unavailable ({answer.kind}, {answer.status_code})"
    return Outcome("retry", error=error)


def record(row: CoinScreeningModel, outcome: Outcome, now: datetime) -> None:
    """Write a try's outcome onto the row; a retry is scheduled, or given up."""
    row.attempts = (row.attempts or 0) + 1
    row.last_error = outcome.error
    if outcome.status in FINAL:
        row.status = outcome.status
        row.reasons = list(outcome.reasons)
        row.missing = list(outcome.missing)
        row.source = outcome.source
        row.levels = dict(outcome.levels)
        row.on_curve = outcome.on_curve
        row.checked_at = now
        return
    first = _utc(row.first_commit_at) or now
    if now - first >= GIVE_UP_AFTER:
        row.status = "unavailable"
        row.checked_at = now
        return
    pause = RETRY_PAUSES[min(row.attempts - 1, len(RETRY_PAUSES) - 1)]
    row.next_attempt_at = outcome.retry_at or (now + pause)


#: `check(mint)` returns what the chain said about the mint, the providers' answer,
#: and whether the coin is on a live pump.fun curve (None if unknown).
CheckFn = Callable[[str], Awaitable[tuple[ChainRead, ProviderAnswer, Optional[bool]]]]


async def run_due(session: Session, now: datetime, check: CheckFn, limit: int = 20) -> int:
    """Run every due check once. `check(mint)` returns what the chain and the providers said."""
    rows = due(session, now, limit)
    for row in rows:
        try:
            chain, answer, on_curve = await check(row.mint)
            outcome = judge(chain, answer, now, on_curve)
        except Exception as exc:  # noqa: BLE001 - one coin's failure must not stop the queue
            logger.exception("coin screening failed (lottery_id=%s, mint=%s)", row.lottery_id, row.mint)
            outcome = Outcome("retry", error=type(exc).__name__)
        record(row, outcome, now)
        if outcome.status in FINAL:
            logger.info(
                "coin screened (lottery_id=%s, mint=%s): %s %s via %s",
                row.lottery_id, row.mint, outcome.status, ",".join(outcome.reasons) or "-", outcome.source,
            )
        session.commit()
    return len(rows)
