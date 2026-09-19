from sqlalchemy import Column, Integer, BigInteger, String, DateTime, Enum as SQLEnum, ForeignKey, Numeric, Boolean
from sqlalchemy.sql import func
from database.database import Base
from enum import Enum


class LotteryStatus(Enum):
    ID_GENERATED = "id_generated"
    INITIALIZE_ABANDONED = "initialize_abandoned"
    CREATED = "created"
    PHASE2STARTED = "phase2started"
    VRF_BINDED = "vrf_binded"
    VRF_FULFILLED = "vrf_fulfilled"
    PROCEEDING_PURCHASES = "proceeding_purchases"
    COMPLETED = "completed"
    CLOSED = "closed"


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
    close_reason = Column(String(64), nullable=True)
    initialize_abandoned_at = Column(DateTime(timezone=True), nullable=True)
    initialize_abandoned_error = Column(String(1000), nullable=True)
    is_offchain_vrf = Column(Boolean, nullable=False, default=False, server_default="false")
    status = Column(
        SQLEnum(
            LotteryStatus,
            values_callable=lambda enum: [member.value for member in enum],
            name="lotterystatus",
        ),
        default=LotteryStatus.ID_GENERATED,
        nullable=False,
    )
