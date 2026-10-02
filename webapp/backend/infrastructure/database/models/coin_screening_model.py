from sqlalchemy import JSON, BigInteger, Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.sql import func

from infrastructure.database.database import Base


class CoinScreeningModel(Base):
    """A coin's red-flag check in one pool (`shared/coin_screening.py`).

    One row per coin per pool, made by the first commit to it and checked once.
    `status` is pending until the check ends: `clean`, `flagged`, or
    `unavailable` when there was nothing to go on, which the site shows as
    nothing at all.
    """

    __tablename__ = "coin_screenings"

    lottery_id = Column(BigInteger, ForeignKey("lotteries.id", ondelete="CASCADE"), primary_key=True)
    mint = Column(String(64), primary_key=True)
    status = Column(String(16), nullable=False, default="pending", server_default="pending")
    reasons = Column(JSON, nullable=False, default=list)
    #: Holder rules the provider had no data for.
    missing = Column(JSON, nullable=False, default=list)
    source = Column(String(32), nullable=True)
    #: The provider's levels at the check, rule by rule (`dev`, `bundle`, `bundled_launch`, `top10`, `insiders`).
    levels = Column(JSON, nullable=True)
    #: Whether the coin traded on a live pump.fun curve at the check; null if unread.
    on_curve = Column(Boolean, nullable=True)
    first_commit_at = Column(DateTime(timezone=True), nullable=False)
    checked_at = Column(DateTime(timezone=True), nullable=True)
    attempts = Column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
