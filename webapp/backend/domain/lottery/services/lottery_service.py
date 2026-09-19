from typing import List, Optional
from datetime import datetime, timezone
from decimal import Decimal
from collections import defaultdict
import logging
from ..entities.lottery import Lottery, LotteryStatus
from ..entities.bet import Bet
from ..entities.lottery_entry import LotteryEntry
from ..repositories.lottery_repository import LotteryRepository, BetRepository, CoinRepository
from domain.auth.entities.user import UserRole

logger = logging.getLogger(__name__)


class LotteryService:
    def __init__(self, lottery_repository: LotteryRepository, bet_repository: Optional[BetRepository] = None, coin_repository: Optional[CoinRepository] = None):
        self._lottery_repository = lottery_repository
        self._bet_repository = bet_repository
        self._coin_repository = coin_repository

    async def create_lottery(self, name: str, created_by_user_id: int, user_role: UserRole, end_date: Optional[datetime] = None, max_total: Optional[float] = None) -> Lottery:
        """Create a new lottery (only admins can create)"""
        if user_role != UserRole.ADMIN:
            raise ValueError("Only administrators can create lotteries")

        lottery = Lottery(
            id=None,
            name=name,
            created_by_user_id=created_by_user_id,
            created_at=datetime.now(timezone.utc),
            end_date=end_date,
            max_total=max_total,
            status=LotteryStatus.ID_GENERATED
        )

        return await self._lottery_repository.create_lottery(lottery)

    async def get_active_lotteries(self) -> List[Lottery]:
        """Get all created lotteries"""
        return await self._lottery_repository.get_active_lotteries()

    async def close_lottery(self, lottery_id: int) -> Lottery:
        """Close lottery"""
        lottery = await self._lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            raise ValueError("Lottery not found")

        if lottery.status == LotteryStatus.CLOSED:
            return lottery

        updated_lottery = await self._lottery_repository.update_lottery_status(
            lottery_id,
            LotteryStatus.CLOSED
        )

        if not updated_lottery:
            raise ValueError("Failed to close lottery")

        return updated_lottery

    async def mark_phase2_started(self, lottery_id: int) -> Lottery:
        """Mark lottery as Phase II started"""
        lottery = await self._lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            raise ValueError("Lottery not found")

        if lottery.status != LotteryStatus.CREATED:
            raise ValueError("Only created lotteries can start Phase II")

        updated_lottery = await self._lottery_repository.update_lottery_status(
            lottery_id,
            LotteryStatus.PHASE2STARTED
        )

        if not updated_lottery:
            raise ValueError("Failed to update lottery status")

        return updated_lottery

    async def mark_proceeding_purchases(self, lottery_id: int) -> Lottery:
        """Mark lottery as proceeding purchases"""
        lottery = await self._lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            raise ValueError("Lottery not found")

        if lottery.status not in {LotteryStatus.PHASE2STARTED, LotteryStatus.VRF_FULFILLED}:
            raise ValueError("Lottery is not ready to proceed with purchases")

        updated_lottery = await self._lottery_repository.update_lottery_status(
            lottery_id,
            LotteryStatus.PROCEEDING_PURCHASES
        )

        if not updated_lottery:
            raise ValueError("Failed to update lottery status")

        return updated_lottery

    async def mark_vrf_binded(self, lottery_id: int) -> Lottery:
        """Mark lottery as VRF request binded"""
        logger.info("service.mark_vrf_binded started (lottery_id=%s)", lottery_id)
        lottery = await self._lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            logger.warning("service.mark_vrf_binded lottery not found (lottery_id=%s)", lottery_id)
            raise ValueError("Lottery not found")

        if lottery.status == LotteryStatus.VRF_BINDED:
            logger.info(
                "service.mark_vrf_binded skipped: already binded (lottery_id=%s, status=%s)",
                lottery_id,
                lottery.status.value,
            )
            return lottery

        if lottery.status != LotteryStatus.PHASE2STARTED:
            logger.warning(
                "service.mark_vrf_binded invalid status (lottery_id=%s, status=%s)",
                lottery_id,
                lottery.status.value,
            )
            raise ValueError("Only phase2started lotteries can be marked as vrf_binded")

        updated_lottery = await self._lottery_repository.update_lottery_status(
            lottery_id,
            LotteryStatus.VRF_BINDED
        )

        if not updated_lottery:
            logger.error(
                "service.mark_vrf_binded repository update failed (lottery_id=%s, new_status=%s)",
                lottery_id,
                LotteryStatus.VRF_BINDED.value,
            )
            raise ValueError("Failed to update lottery status")

        logger.info(
            "service.mark_vrf_binded succeeded (lottery_id=%s, old_status=%s, new_status=%s)",
            lottery_id,
            lottery.status.value,
            updated_lottery.status.value,
        )
        return updated_lottery

    async def mark_vrf_fulfilled(self, lottery_id: int) -> Lottery:
        """Mark lottery as VRF fulfilled"""
        logger.info("service.mark_vrf_fulfilled started (lottery_id=%s)", lottery_id)
        lottery = await self._lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            logger.warning("service.mark_vrf_fulfilled lottery not found (lottery_id=%s)", lottery_id)
            raise ValueError("Lottery not found")

        if lottery.status == LotteryStatus.VRF_FULFILLED:
            logger.info(
                "service.mark_vrf_fulfilled skipped: already fulfilled (lottery_id=%s, status=%s)",
                lottery_id,
                lottery.status.value,
            )
            return lottery

        if lottery.status != LotteryStatus.VRF_BINDED:
            logger.warning(
                "service.mark_vrf_fulfilled invalid status (lottery_id=%s, status=%s)",
                lottery_id,
                lottery.status.value,
            )
            raise ValueError("Only vrf_binded lotteries can be marked as vrf_fulfilled")

        updated_lottery = await self._lottery_repository.update_lottery_status(
            lottery_id,
            LotteryStatus.VRF_FULFILLED
        )

        if not updated_lottery:
            logger.error(
                "service.mark_vrf_fulfilled repository update failed (lottery_id=%s, new_status=%s)",
                lottery_id,
                LotteryStatus.VRF_FULFILLED.value,
            )
            raise ValueError("Failed to update lottery status")

        logger.info(
            "service.mark_vrf_fulfilled succeeded (lottery_id=%s, old_status=%s, new_status=%s)",
            lottery_id,
            lottery.status.value,
            updated_lottery.status.value,
        )
        return updated_lottery

    async def place_bet(self, lottery_id: int, user_id: int, coin_name: str, solana_amount: Decimal) -> Bet:
        """Place a bet on a coin in a lottery"""
        if not self._bet_repository or not self._coin_repository:
            raise ValueError("Bet and coin repositories are not configured")
        # Check if lottery exists and is active
        lottery = await self._lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            raise ValueError("Lottery not found")
        if not lottery.is_active():
            raise ValueError("Lottery is not active")

        # Check if coin exists
        coin = await self._coin_repository.get_coin_by_name(coin_name)
        if not coin:
            raise ValueError(f"Coin '{coin_name}' not found")

        # Create bet
        bet = Bet(
            id=None,
            lottery_id=lottery_id,
            user_id=user_id,
            coin_name=coin_name,
            solana_amount=solana_amount,
            created_at=datetime.now(timezone.utc)
        )

        return await self._bet_repository.create_bet(bet)

    async def get_current_lottery_entries(self, lottery_id: int) -> List[LotteryEntry]:
        """Get current lottery entries for a specific lottery sorted by total solana bet (descending)"""
        if not self._bet_repository or not self._coin_repository:
            raise ValueError("Bet and coin repositories are not configured")
        # Get all bets for this lottery
        bets = await self._bet_repository.get_bets_by_lottery(lottery_id)

        # Aggregate bets by coin
        coin_aggregates = defaultdict(lambda: {"total_bet": Decimal("0"), "bet_count": 0})

        for bet in bets:
            coin_aggregates[bet.coin_name]["total_bet"] += bet.solana_amount
            coin_aggregates[bet.coin_name]["bet_count"] += 1

        # Create lottery entries
        entries = []
        for coin_name, aggregate in coin_aggregates.items():
            coin = await self._coin_repository.get_coin_by_name(coin_name)
            if coin:
                entry = LotteryEntry(
                    rank=0,  # Will be set later
                    lottery_id=lottery_id,
                    coin=coin,
                    total_solana_bet=aggregate["total_bet"],
                    bet_count=aggregate["bet_count"]
                )
                entries.append(entry)

        # Sort by total_solana_bet descending and assign ranks
        sorted_entries = sorted(entries, key=lambda x: x.total_solana_bet, reverse=True)

        # Update ranks based on sorted order
        for i, entry in enumerate(sorted_entries, 1):
            entry.rank = i

        return sorted_entries

    async def get_user_bets(self, user_id: int) -> List[Bet]:
        """Get all bets by a specific user"""
        return await self._bet_repository.get_bets_by_user(user_id)
