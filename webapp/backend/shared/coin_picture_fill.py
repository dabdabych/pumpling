"""Finding a coin's picture after a commit to it, and coming back for it.

A coin search asks only the free sources (pump.fun and DexScreener), for two
seconds at most, and a coin whose picture is not there yet is committed to
without one. Once a commit to it is confirmed, this thread looks again on a
schedule: one minute after, then 2, 5, 10 and 30 minutes, then one, two and six
hours. Nine tries over about ten hours, then it stops: a coin that never had a
picture must not cost a lookup forever.

It used to be an in-memory queue in the API, fed by the pool page's polls: a
try every half hour, only while the coin's pool was on screen, forgotten on
every restart. On the stand's short pools that was a single try. TOILETDOG
(2026-10-02) got no picture at its commit, DexScreener had one an hour later,
and nothing ever asked again. The schedule now lives in `token_metadata`
(`logo_attempts`, `logo_next_attempt_at`, migration 044) and runs whether or
not anyone is looking at the pool.

The paid Helius DAS lookup is made on two of the nine tries at most, the first
and the fourth, and inside the API's own DAS ceilings (a minute and a day);
the other tries ask only the free sources. A search never pays for DAS.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from infrastructure.database.models.bet_participation_model import BetParticipationModel
from infrastructure.database.models.token_metadata_model import TokenMetadataModel
from shared.bet_confirmation import active_bet_condition

logger = logging.getLogger(__name__)

#: The wait after each failed try before the next.
PAUSES = (
    timedelta(minutes=1),
    timedelta(minutes=2),
    timedelta(minutes=5),
    timedelta(minutes=10),
    timedelta(minutes=30),
    timedelta(hours=1),
    timedelta(hours=2),
    timedelta(hours=6),
)
MAX_ATTEMPTS = len(PAUSES) + 1
#: The tries that may use the paid DAS lookup.
PAID_ATTEMPTS = frozenset({1, 4})
#: Coins with a confirmed commit this recent are looked after.
LOOKBACK = timedelta(days=1)
POLL_SECONDS = 20.0
BATCH = 10

#: (mint, may_pay) -> {"token_name", "token_symbol", "token_image_url"}
Fetch = Callable[[str, bool], dict]


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def due(session: Session, now: datetime, limit: int = BATCH) -> list[str]:
    """Coins with a confirmed commit in the last day and no picture, whose next try is due."""
    committed = (
        session.query(BetParticipationModel.meme_coin_address.label("mint"))
        .filter(active_bet_condition(BetParticipationModel), BetParticipationModel.created_at >= now - LOOKBACK)
        .distinct()
        .subquery()
    )
    rows = (
        session.query(committed.c.mint)
        .outerjoin(TokenMetadataModel, TokenMetadataModel.mint == committed.c.mint)
        .filter(or_(
            TokenMetadataModel.mint.is_(None),
            and_(
                TokenMetadataModel.logo_url.is_(None),
                TokenMetadataModel.logo_attempts < MAX_ATTEMPTS,
                or_(TokenMetadataModel.logo_next_attempt_at.is_(None), TokenMetadataModel.logo_next_attempt_at <= now),
            ),
        ))
        .order_by(TokenMetadataModel.logo_next_attempt_at.asc().nullsfirst())
        .limit(limit)
        .all()
    )
    return [str(mint) for (mint,) in rows if mint]


def attempt(session: Session, mint: str, now: datetime, fetch: Fetch) -> bool:
    """One try at the coin's picture. Whether it was found."""
    row = session.get(TokenMetadataModel, mint)
    tries = (row.logo_attempts or 0) + 1 if row is not None else 1
    found = fetch(mint, tries in PAID_ATTEMPTS) or {}
    for _ in range(2):
        try:
            if row is None:
                row = TokenMetadataModel(mint=mint, logo_attempts=0)
                session.add(row)
            if found.get("token_name") and not row.name:
                row.name = str(found["token_name"])[:255]
            if found.get("token_symbol") and not row.symbol:
                row.symbol = str(found["token_symbol"])[:64]
            picture = found.get("token_image_url")
            if picture:
                row.logo_url = str(picture)[:1024]
                row.logo_next_attempt_at = None
            else:
                row.logo_next_attempt_at = now + PAUSES[tries - 1] if tries < MAX_ATTEMPTS else None
            row.logo_attempts = tries
            row.updated_at = now
            session.commit()
            return bool(picture)
        except IntegrityError:
            # A search stored the coin between our read and our write: take its row.
            session.rollback()
            row = session.get(TokenMetadataModel, mint)
    return False


def run_once(session: Session, now: datetime, fetch: Fetch) -> int:
    """The tries that are due now; how many found a picture."""
    found = 0
    for mint in due(session, now):
        try:
            found += attempt(session, mint, now, fetch)
        except Exception:
            session.rollback()
            logger.warning("coin picture lookup failed (mint=%s)", mint, exc_info=True)
    return found


_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def start(session_factory: Callable[[], Session], fetch: Fetch) -> None:
    """Start the background thread once per process."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()

    def loop() -> None:
        while not _stop.wait(POLL_SECONDS):
            session = session_factory()
            try:
                run_once(session, datetime.now(timezone.utc), fetch)
            except Exception:
                session.rollback()
                logger.warning("coin picture pass failed", exc_info=True)
            finally:
                session.close()

    _thread = threading.Thread(target=loop, name="coin-picture-fill", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()
