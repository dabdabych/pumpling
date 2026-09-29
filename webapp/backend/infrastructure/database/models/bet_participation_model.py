from sqlalchemy import CheckConstraint, Column, Integer, BigInteger, SmallInteger, String, Float, DateTime, ForeignKey, Text
from sqlalchemy.sql import func
from infrastructure.database.database import Base


class BetParticipationModel(Base):
    __tablename__ = "bet_participations"
    __table_args__ = (
        CheckConstraint("burn_bps BETWEEN 0 AND 10000", name="bet_participations_burn_bps_range"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    lottery_id = Column(BigInteger, ForeignKey("lotteries.id"), nullable=False)
    meme_coin_address = Column(String(255), nullable=False)
    sol_amount = Column(Float, nullable=False)
    wallet_address = Column(String(255), nullable=False)
    tx_signature = Column(String(128), unique=True, nullable=True)
    confirmation_status = Column(String(16), nullable=False, default="confirmed", server_default="confirmed")
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    finalized_at = Column(DateTime(timezone=True), nullable=True)
    last_confirmation_check_at = Column(DateTime(timezone=True), nullable=True)
    orphaned_at = Column(DateTime(timezone=True), nullable=True)
    orphan_reason = Column(Text, nullable=True)
    #: Basis points of the tokens bought for this commit that its wallet asked
    #: to have burned. Read from the commit transaction's memo, never from a
    #: request; see `shared/burn_memo.py` and migration 041.
    burn_bps = Column(SmallInteger, nullable=False, default=0, server_default="0")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
