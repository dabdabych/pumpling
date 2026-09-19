from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Enum as SQLEnum, ForeignKey, Index, Numeric, Boolean
from sqlalchemy.sql import func
from infrastructure.database.database import Base
from domain.lottery.entities.lottery import LotteryStatus


class LotteryModel(Base):
    __tablename__ = "lotteries"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=False)
    name = Column(String(255), nullable=False)
    created_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    end_date = Column(DateTime(timezone=True), nullable=True)
    max_total = Column(Numeric(20, 8), nullable=True)
    lottery_pda = Column(String(64), nullable=True)
    vrf_seed = Column(String(64), nullable=True)
    randomness_account = Column(String(64), nullable=True)
    second_phase_started_at = Column(DateTime(timezone=True), nullable=True)
    proceeding_purchases_started_at = Column(DateTime(timezone=True), nullable=True)
    close_reason = Column(String(64), nullable=True)
    initialize_abandoned_at = Column(DateTime(timezone=True), nullable=True)
    initialize_abandoned_error = Column(String(1000), nullable=True)
    is_offchain_vrf = Column(Boolean, nullable=False, server_default="false", default=False)
    lottery_type = Column(String(32), nullable=False, server_default="pumpfun", default="pumpfun")
    status = Column(
        SQLEnum(
            LotteryStatus,
            values_callable=lambda enum: [member.value for member in enum],
            name="lotterystatus",
        ),
        default=LotteryStatus.ID_GENERATED,
        nullable=False,
    )

    __table_args__ = (
        Index(
            "uq_lotteries_open_by_type",
            "lottery_type",
            unique=True,
            postgresql_where=status.in_([LotteryStatus.ID_GENERATED, LotteryStatus.CREATED]),
        ),
    )
