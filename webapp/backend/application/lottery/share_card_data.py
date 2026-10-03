"""What a share card says, read from the database.

Only the keys come from the link: a pool number, a mint, a commit signature.
Every number on the card is looked up. A link that names a coin the pool does
not have gets the pool's card, as on the site; a signature we do not know gets
nothing, and the page falls back to the site's own preview.

The phase is worked out exactly as the pool page does it
(`webapp/ui/src/app/pool/pool-state.ts`, `buildPoolSnapshot`), so the footer on
the card and the page it links to agree.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from domain.lottery.entities.lottery import LotteryStatus
from infrastructure.database.models.bet_participation_model import BetParticipationModel
from infrastructure.database.models.lottery_model import LotteryModel
from shared.bet_confirmation import active_bet_condition
from shared.share_card import ShareCard

# The same numbers the page falls back to.
DEFAULT_CAP_SOL = 77.0
MIN_COMMIT_SOL = 0.05

MINT_PATTERN = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
SIGNATURE_PATTERN = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,90}$")

_DRAW = {LotteryStatus.PHASE2STARTED, LotteryStatus.VRF_BINDED}
_BUYING = {LotteryStatus.VRF_FULFILLED, LotteryStatus.PROCEEDING_PURCHASES}
_FINISHED = {LotteryStatus.CLOSED, LotteryStatus.COMPLETED}

CoinMetadata = Callable[[Session, str], tuple[str, str, str]]


@dataclass(frozen=True)
class CardSource:
    card: ShareCard
    logo_url: Optional[str]
    #: Where a person who opens the link lands, a path on the site.
    target: str


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _status(lottery: LotteryModel) -> Optional[LotteryStatus]:
    status = lottery.status
    if isinstance(status, LotteryStatus):
        return status
    try:
        return LotteryStatus(str(status))
    except ValueError:
        return None


def pool_phase(lottery: LotteryModel, total_sol: float, cap_sol: float, now: datetime, buy_window_seconds: int) -> str:
    status = _status(lottery)
    if status == LotteryStatus.ID_GENERATED:
        return "opening"
    if status == LotteryStatus.CREATED:
        closes = _utc(lottery.end_date)
        time_up = closes is not None and now >= closes
        cap_reached = total_sol > cap_sol - MIN_COMMIT_SOL
        return "locked" if time_up or cap_reached else "open"
    if status in _DRAW:
        return "locked"
    if status in _BUYING:
        return "buying"
    if status in _FINISHED:
        started = _utc(lottery.proceeding_purchases_started_at)
        if started is not None and now < started + timedelta(seconds=buy_window_seconds):
            return "buying"
        return "done"
    return "waiting"


def clean_ticker(raw: object, mint: str) -> str:
    """The page's `cleanTicker`."""
    ticker = str(raw or "").strip()
    if ticker.startswith("$"):
        ticker = ticker[1:]
    if ticker and ticker != mint and len(ticker) <= 16:
        return ticker.upper()
    return mint[:4].upper()


def _clean_url(value: object) -> Optional[str]:
    text = str(value or "").strip()
    return text if re.match(r"^https?://", text, re.IGNORECASE) else None


class ShareCards:
    def __init__(self, db: Session, coin_metadata: CoinMetadata, buy_window_seconds: int, now: Optional[datetime] = None):
        self.db = db
        self.coin_metadata = coin_metadata
        self.buy_window_seconds = buy_window_seconds
        self.now = now or datetime.now(timezone.utc)

    def _lottery(self, pool_id: int) -> Optional[LotteryModel]:
        lottery = self.db.query(LotteryModel).filter(LotteryModel.id == pool_id).first()
        if lottery is None or _status(lottery) in (None, LotteryStatus.INITIALIZE_ABANDONED):
            return None
        return lottery

    def _coin_totals(self, pool_id: int) -> dict[str, float]:
        rows = (
            self.db.query(BetParticipationModel.meme_coin_address, func.sum(BetParticipationModel.sol_amount))
            .filter(BetParticipationModel.lottery_id == pool_id, active_bet_condition(BetParticipationModel))
            .group_by(BetParticipationModel.meme_coin_address)
            .all()
        )
        return {str(mint): float(total or 0) for mint, total in rows}

    def _base(self, lottery: LotteryModel, totals: dict[str, float]) -> dict:
        total = sum(totals.values())
        cap = float(lottery.max_total) if lottery.max_total and float(lottery.max_total) > 0 else DEFAULT_CAP_SOL
        return {
            "pool_id": int(lottery.id),
            "phase": pool_phase(lottery, total, cap, self.now, self.buy_window_seconds),
            "pool_sol": total,
            "cap_sol": cap,
            "coins": len(totals),
            "closes_at": _utc(lottery.end_date),
        }

    def pool(self, pool_id: int) -> Optional[CardSource]:
        lottery = self._lottery(pool_id)
        if lottery is None:
            return None
        card = ShareCard(kind="pool", **self._base(lottery, self._coin_totals(pool_id)))
        return CardSource(card=card, logo_url=None, target="/pool")

    def coin(self, pool_id: int, mint: str, kind: str = "coin", commit_sol: float = 0.0) -> Optional[CardSource]:
        if not MINT_PATTERN.match(mint):
            return None
        lottery = self._lottery(pool_id)
        if lottery is None:
            return None
        totals = self._coin_totals(pool_id)
        base = self._base(lottery, totals)
        if mint not in totals:
            # Not in this pool: the page draws the pool's card then, and so do we.
            return CardSource(card=ShareCard(kind="pool", **base), logo_url=None, target="/pool")
        name, symbol, logo = self.coin_metadata(self.db, mint)
        coin_sol = totals[mint]
        card = ShareCard(
            kind=kind,
            ticker=clean_ticker(symbol, mint),
            name=str(name or ""),
            mint=mint,
            commit_sol=commit_sol,
            coin_sol=coin_sol,
            coin_share=coin_sol / base["pool_sol"] if base["pool_sol"] > 0 else 0.0,
            **base,
        )
        return CardSource(card=card, logo_url=_clean_url(logo), target=f"/pool?coin={mint}")

    def commit(self, signature: str) -> Optional[CardSource]:
        if not SIGNATURE_PATTERN.match(signature):
            return None
        bet = (
            self.db.query(BetParticipationModel)
            .filter(BetParticipationModel.tx_signature == signature, active_bet_condition(BetParticipationModel))
            .first()
        )
        if bet is None:
            return None
        return self.coin(int(bet.lottery_id), str(bet.meme_coin_address), kind="commit", commit_sol=float(bet.sol_amount or 0))
