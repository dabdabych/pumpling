import asyncio
import logging
import os
import signal
from contextlib import suppress
from datetime import datetime, timezone
from typing import Optional

from solana.rpc.async_api import AsyncClient
from solders.signature import Signature

from database.database import SessionLocal
from database.models.bet_participation_model import BetParticipationModel
from database.models.lottery_model import LotteryModel, LotteryStatus
from database.models.user_model import UserModel  # noqa: F401 - registers users table for bet_participations FK
from shared.bet_confirmation import (
    BET_STATUS_CONFIRMED,
    BET_STATUS_FINALIZED,
    BET_STATUS_ORPHANED,
)


LOG_LEVEL = os.getenv("BET_FINALIZER_LOG_LEVEL", "INFO").upper()
SOLANA_HTTP_ENDPOINT = os.getenv("SOLANA_HTTP_ENDPOINT", "https://api.mainnet-beta.solana.com/")
POLL_INTERVAL_SECONDS = float(os.getenv("BET_FINALIZER_POLL_INTERVAL_SECONDS", "5.0"))
BATCH_SIZE = int(os.getenv("BET_FINALIZER_BATCH_SIZE", "100"))
ORPHAN_AFTER_SECONDS = int(os.getenv("BET_FINALIZER_ORPHAN_AFTER_SECONDS", "300"))


def setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )


def _install_signal_handlers(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)


def _to_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _confirmation_status_text(value: object) -> str:
    raw = getattr(value, "value", value)
    return str(raw or "").strip().lower()


def _is_finalized(value: object) -> bool:
    return "finalized" in _confirmation_status_text(value)


def _mark_finalized(session, bet: BetParticipationModel, now_utc: datetime) -> None:
    bet.confirmation_status = BET_STATUS_FINALIZED
    bet.finalized_at = now_utc
    bet.last_confirmation_check_at = now_utc
    bet.orphaned_at = None
    bet.orphan_reason = None


def _is_phase1_lottery(session, bet: BetParticipationModel) -> bool:
    lottery = session.query(LotteryModel.status).filter(LotteryModel.id == bet.lottery_id).first()
    if lottery is None:
        return False
    return lottery.status in {LotteryStatus.ID_GENERATED, LotteryStatus.CREATED}


def _mark_orphaned(session, bet: BetParticipationModel, now_utc: datetime, reason: str) -> None:
    bet.confirmation_status = BET_STATUS_ORPHANED
    bet.orphaned_at = now_utc
    bet.orphan_reason = reason[:1000]
    bet.last_confirmation_check_at = now_utc


def _bet_age_seconds(bet: BetParticipationModel, now_utc: datetime) -> float:
    anchor = _to_utc(getattr(bet, "confirmed_at", None)) or _to_utc(getattr(bet, "created_at", None)) or now_utc
    return max(0.0, (now_utc - anchor).total_seconds())


def _list_confirmed_bets(session) -> list[BetParticipationModel]:
    return (
        session.query(BetParticipationModel)
        .filter(
            BetParticipationModel.confirmation_status == BET_STATUS_CONFIRMED,
            BetParticipationModel.tx_signature.isnot(None),
        )
        .order_by(BetParticipationModel.last_confirmation_check_at.asc().nullsfirst(), BetParticipationModel.created_at.asc())
        .limit(BATCH_SIZE)
        .all()
    )


async def _process_bet(client: AsyncClient, bet: BetParticipationModel, now_utc: datetime) -> tuple[str, str | None]:
    signature_raw = str(bet.tx_signature or "").strip()
    if not signature_raw:
        return BET_STATUS_ORPHANED, "missing_signature"

    try:
        signature = Signature.from_string(signature_raw)
    except Exception:
        return BET_STATUS_ORPHANED, "invalid_signature"

    response = await client.get_signature_statuses([signature], search_transaction_history=True)
    status = response.value[0] if response.value else None
    if status is None:
        if _bet_age_seconds(bet, now_utc) >= ORPHAN_AFTER_SECONDS:
            return BET_STATUS_ORPHANED, "signature_not_found_before_timeout"
        return BET_STATUS_CONFIRMED, None

    err = getattr(status, "err", None)
    if err is not None:
        return BET_STATUS_ORPHANED, f"transaction_error:{err}"

    if _is_finalized(getattr(status, "confirmation_status", None)):
        return BET_STATUS_FINALIZED, None

    if _bet_age_seconds(bet, now_utc) >= ORPHAN_AFTER_SECONDS:
        return BET_STATUS_ORPHANED, "not_finalized_before_timeout"

    return BET_STATUS_CONFIRMED, None


async def _run_once(client: AsyncClient) -> None:
    session = SessionLocal()
    now_utc = datetime.now(timezone.utc)
    try:
        bets = _list_confirmed_bets(session)
        if not bets:
            return

        finalized_count = 0
        orphaned_count = 0
        for bet in bets:
            status, reason = await _process_bet(client, bet, now_utc)
            if status == BET_STATUS_FINALIZED:
                _mark_finalized(session, bet, now_utc)
                finalized_count += 1
            elif status == BET_STATUS_ORPHANED:
                if _is_phase1_lottery(session, bet):
                    _mark_orphaned(session, bet, now_utc, reason or "unknown")
                    orphaned_count += 1
                else:
                    # Once weights_hash may already have been committed on-chain,
                    # removing a bet would desync payouts from the draw input.
                    bet.last_confirmation_check_at = now_utc
                    logging.warning(
                        "Bet finalizer kept non-finalized bet active after prediction phase "
                        "(bet_id=%s, lottery_id=%s, reason=%s)",
                        bet.id,
                        bet.lottery_id,
                        reason,
                    )
            else:
                bet.last_confirmation_check_at = now_utc

        session.commit()
        if finalized_count or orphaned_count:
            logging.info(
                "Bet finalizer updated bets (finalized=%s, orphaned=%s, checked=%s)",
                finalized_count,
                orphaned_count,
                len(bets),
            )
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


async def main() -> None:
    setup_logging()
    stop_event = asyncio.Event()
    _install_signal_handlers(stop_event)

    logging.info(
        "Starting bet finalizer worker (rpc=%s, interval=%ss, orphan_after=%ss, batch=%s)",
        SOLANA_HTTP_ENDPOINT,
        POLL_INTERVAL_SECONDS,
        ORPHAN_AFTER_SECONDS,
        BATCH_SIZE,
    )

    async with AsyncClient(SOLANA_HTTP_ENDPOINT) as client:
        while not stop_event.is_set():
            try:
                await _run_once(client)
            except Exception as exc:  # noqa: BLE001
                logging.exception("Bet finalizer iteration failed: %s", exc)
            await asyncio.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
