from dataclasses import dataclass
from typing import Optional
from datetime import datetime
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


class LotteryType(Enum):
    """The kinds of round the platform runs. There is one.

    A second kind, `pumpfun`, took only coins still on the pump.fun curve and
    ran as its own parallel cycle. It was retired: the ordinary round already
    accepts those coins, and the buyer routes a coin on the curve to the curve
    either way, so the split bought nothing and cost a whole second cycle.

    Rounds created before it was retired still carry `"pumpfun"` in the
    database. Nothing renders them — the pool page and the archive both ask for
    `dex` and always have — but the column is a plain string, so reading one
    must not raise. `database_lottery_repository` is where that is handled.
    """

    DEX = "dex"


@dataclass
class Lottery:
    id: Optional[int]
    name: str
    created_by_user_id: int  # Admin who created the lottery
    created_at: datetime
    end_date: Optional[datetime] = None
    max_total: Optional[float] = None
    vrf_seed: Optional[str] = None
    randomness_account: Optional[str] = None
    second_phase_started_at: Optional[datetime] = None
    proceeding_purchases_started_at: Optional[datetime] = None
    close_reason: Optional[str] = None
    initialize_abandoned_at: Optional[datetime] = None
    initialize_abandoned_error: Optional[str] = None
    is_offchain_vrf: bool = False
    lottery_type: LotteryType = LotteryType.DEX
    status: LotteryStatus = LotteryStatus.ID_GENERATED

    def __post_init__(self):
        if not self.name or len(self.name.strip()) == 0:
            raise ValueError("Lottery name cannot be empty")
        if self.created_by_user_id <= 0:
            raise ValueError("Created by user ID must be positive")

    def is_active(self) -> bool:
        """Check if lottery is currently active"""
        if self.status != LotteryStatus.CREATED:
            return False
        if self.end_date and datetime.now() > self.end_date:
            return False
        return True
