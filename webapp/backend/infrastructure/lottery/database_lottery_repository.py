from typing import Optional, List
from datetime import datetime, timezone
import time
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from domain.lottery.entities.lottery import Lottery, LotteryStatus, LotteryType
from domain.lottery.entities.lottery_entry import LotteryEntry
from domain.lottery.repositories.lottery_repository import LotteryRepository
from infrastructure.database.models.lottery_model import LotteryModel


class DatabaseLotteryRepository(LotteryRepository):
    def __init__(self, db: Session):
        self.db = db

    async def create_lottery(self, lottery: Lottery) -> Lottery:
        open_lottery_exists = self.db.query(LotteryModel).filter(
            LotteryModel.status.in_([LotteryStatus.ID_GENERATED, LotteryStatus.CREATED]),
            LotteryModel.lottery_type == lottery.lottery_type.value,
        ).first()
        if open_lottery_exists:
            raise ValueError(f"Open lottery already exists for type {lottery.lottery_type.value}.")

        lottery_id = lottery.id if lottery.id is not None else self._generate_lottery_id()
        lottery_model = LotteryModel(
            id=lottery_id,
            name=lottery.name,
            created_by_user_id=lottery.created_by_user_id,
            created_at=lottery.created_at,
            end_date=lottery.end_date,
            max_total=lottery.max_total,
            vrf_seed=lottery.vrf_seed,
            randomness_account=lottery.randomness_account,
            proceeding_purchases_started_at=lottery.proceeding_purchases_started_at,
            is_offchain_vrf=lottery.is_offchain_vrf,
            lottery_type=lottery.lottery_type.value,
            status=lottery.status
        )
        self.db.add(lottery_model)
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise ValueError(f"Open lottery already exists for type {lottery.lottery_type.value}.") from exc
        self.db.refresh(lottery_model)
        lottery.id = lottery_model.id
        return lottery

    def _generate_lottery_id(self) -> int:
        # Milliseconds Unix timestamp. Stable for UI/JS number and valid u64 seed for PDA.
        candidate = int(time.time() * 1000)
        while self.db.query(LotteryModel).filter(LotteryModel.id == candidate).first():
            candidate += 1
        return candidate

    async def get_lottery_by_id(self, lottery_id: int) -> Optional[Lottery]:
        lottery_model = self.db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
        if lottery_model:
            return self._model_to_entity(lottery_model)
        return None

    async def get_active_lotteries(self) -> List[Lottery]:
        lottery_models = self.db.query(LotteryModel).filter(
            LotteryModel.status == LotteryStatus.CREATED
        ).order_by(LotteryModel.created_at.desc()).all()

        # Fallback: handle legacy rows where status may be stored as string value
        if not lottery_models:
            lottery_models = [
                lm for lm in self.db.query(LotteryModel).order_by(LotteryModel.created_at.desc()).all()
                if getattr(lm, "status", None) in {
                    LotteryStatus.CREATED,
                    LotteryStatus.CREATED.value,
                    LotteryStatus.CREATED.name,
                    "created",
                    "CREATED",
                    "active",
                    "ACTIVE",
                }
            ]

        lotteries = [self._model_to_entity(model) for model in lottery_models]
        return [lottery for lottery in lotteries if self._is_deposit_window_open(lottery)]

    async def get_open_lotteries(self, lottery_type: Optional[LotteryType] = None) -> List[Lottery]:
        query = self.db.query(LotteryModel).filter(
            LotteryModel.status.in_([LotteryStatus.ID_GENERATED, LotteryStatus.CREATED])
        )
        if lottery_type is not None:
            query = query.filter(LotteryModel.lottery_type == lottery_type.value)
        lottery_models = query.all()
        return [self._model_to_entity(model) for model in lottery_models]

    async def has_active_lottery(self) -> bool:
        lotteries = await self.get_active_lotteries()
        return len(lotteries) > 0

    async def get_all_lotteries(self, skip: int = 0, limit: int = 10) -> tuple[List[Lottery], int]:
        total_count = self.db.query(LotteryModel).count()
        lottery_models = self.db.query(LotteryModel).order_by(
            LotteryModel.created_at.desc()
        ).offset(skip).limit(limit).all()
        lotteries = [self._model_to_entity(model) for model in lottery_models]
        return lotteries, total_count

    async def get_current_lottery_entries(self, lottery_id: int) -> List[LotteryEntry]:
        # This method will be implemented by the service layer
        # as it needs to aggregate data from bets and coins
        return []

    async def update_lottery_status(self, lottery_id: int, status: LotteryStatus) -> Optional[Lottery]:
        lottery_model = self.db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
        if not lottery_model:
            return None

        lottery_model.status = status
        if status == LotteryStatus.PHASE2STARTED:
            lottery_model.second_phase_started_at = datetime.now(timezone.utc)
        if status == LotteryStatus.PROCEEDING_PURCHASES and lottery_model.proceeding_purchases_started_at is None:
            lottery_model.proceeding_purchases_started_at = datetime.now(timezone.utc)
        self.db.commit()
        self.db.refresh(lottery_model)
        return self._model_to_entity(lottery_model)

    async def update_lottery_randomness_account(self, lottery_id: int, randomness_account: Optional[str]) -> Optional[Lottery]:
        lottery_model = self.db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
        if not lottery_model:
            return None

        lottery_model.randomness_account = randomness_account
        lottery_model.vrf_seed = None
        self.db.commit()
        self.db.refresh(lottery_model)
        return self._model_to_entity(lottery_model)

    async def update_lottery_offchain_vrf(self, lottery_id: int, is_offchain_vrf: bool) -> Optional[Lottery]:
        lottery_model = self.db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
        if not lottery_model:
            return None

        lottery_model.is_offchain_vrf = is_offchain_vrf
        self.db.commit()
        self.db.refresh(lottery_model)
        return self._model_to_entity(lottery_model)

    async def update_lottery_vrf_seed(self, lottery_id: int, vrf_seed: Optional[str]) -> Optional[Lottery]:
        lottery_model = self.db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
        if not lottery_model:
            return None

        lottery_model.vrf_seed = vrf_seed
        self.db.commit()
        self.db.refresh(lottery_model)
        return self._model_to_entity(lottery_model)

    def _model_to_entity(self, lottery_model: LotteryModel) -> Lottery:
        status = lottery_model.status
        # Normalize status to LotteryStatus enum if stored as string
        if isinstance(status, str):
            try:
                status = LotteryStatus(status)
            except ValueError:
                legacy_status = status.lower()
                if legacy_status == "active":
                    status = LotteryStatus.CREATED
                elif legacy_status == "finished":
                    status = LotteryStatus.COMPLETED
                elif legacy_status in {"cancelled", "canceled", "closed"}:
                    status = LotteryStatus.CLOSED
                else:
                    status = LotteryStatus.ID_GENERATED

        raw_lottery_type = str(getattr(lottery_model, "lottery_type", "pumpfun")).lower()
        try:
            lottery_type = LotteryType(raw_lottery_type)
        except ValueError:
            lottery_type = LotteryType.PUMPFUN

        return Lottery(
            id=lottery_model.id,
            name=lottery_model.name,
            created_by_user_id=lottery_model.created_by_user_id,
            created_at=lottery_model.created_at,
            end_date=lottery_model.end_date,
            max_total=float(lottery_model.max_total) if lottery_model.max_total is not None else None,
            vrf_seed=lottery_model.vrf_seed,
            randomness_account=lottery_model.randomness_account,
            second_phase_started_at=lottery_model.second_phase_started_at,
            proceeding_purchases_started_at=lottery_model.proceeding_purchases_started_at,
            close_reason=getattr(lottery_model, "close_reason", None),
            initialize_abandoned_at=getattr(lottery_model, "initialize_abandoned_at", None),
            initialize_abandoned_error=getattr(lottery_model, "initialize_abandoned_error", None),
            is_offchain_vrf=bool(getattr(lottery_model, "is_offchain_vrf", False)),
            lottery_type=lottery_type,
            status=status
        )

    @staticmethod
    def _is_deposit_window_open(lottery: Lottery) -> bool:
        if lottery.status != LotteryStatus.CREATED:
            return False
        if lottery.end_date is None:
            return True

        now_utc = datetime.now(timezone.utc)
        end_date = lottery.end_date
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)
        return end_date >= now_utc
