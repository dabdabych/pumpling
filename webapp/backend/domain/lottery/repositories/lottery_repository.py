from abc import ABC, abstractmethod
from typing import List, Optional
from ..entities.lottery import Lottery, LotteryStatus, LotteryType
from ..entities.bet import Bet
from ..entities.coin import Coin
from ..entities.lottery_entry import LotteryEntry


class LotteryRepository(ABC):
    @abstractmethod
    async def create_lottery(self, lottery: Lottery) -> Lottery:
        """Create a new lottery"""
        pass

    @abstractmethod
    async def get_lottery_by_id(self, lottery_id: int) -> Optional[Lottery]:
        """Get lottery by ID"""
        pass

    @abstractmethod
    async def get_active_lotteries(self) -> List[Lottery]:
        """Get all created lotteries"""
        pass

    @abstractmethod
    async def get_open_lotteries(self, lottery_type: Optional[LotteryType] = None) -> List[Lottery]:
        """Get lotteries that are not yet completed or closed"""
        pass

    @abstractmethod
    async def has_active_lottery(self) -> bool:
        """Check if there is at least one created lottery"""
        pass

    @abstractmethod
    async def get_all_lotteries(self, skip: int = 0, limit: int = 10) -> tuple[List[Lottery], int]:
        """Get all lotteries with pagination"""
        pass

    @abstractmethod
    async def get_current_lottery_entries(self, lottery_id: int) -> List[LotteryEntry]:
        """Get current lottery entries for a specific lottery sorted by total bet (descending)"""
        pass

    @abstractmethod
    async def update_lottery_status(self, lottery_id: int, status: LotteryStatus) -> Optional[Lottery]:
        """Update lottery status (e.g., cancel or finish)"""
        pass

    @abstractmethod
    async def update_lottery_randomness_account(self, lottery_id: int, randomness_account: Optional[str]) -> Optional[Lottery]:
        """Persist randomness account associated with lottery"""
        pass

    @abstractmethod
    async def update_lottery_offchain_vrf(self, lottery_id: int, is_offchain_vrf: bool) -> Optional[Lottery]:
        """Persist offchain VRF mode flag for lottery"""
        pass

    @abstractmethod
    async def update_lottery_vrf_seed(self, lottery_id: int, vrf_seed: Optional[str]) -> Optional[Lottery]:
        """Persist VRF seed for lottery"""
        pass


class BetRepository(ABC):
    @abstractmethod
    async def create_bet(self, bet: Bet) -> Bet:
        """Create a new bet"""
        pass

    @abstractmethod
    async def get_bets_by_lottery(self, lottery_id: int) -> List[Bet]:
        """Get all bets for a specific lottery"""
        pass

    @abstractmethod
    async def get_bets_by_user(self, user_id: int) -> List[Bet]:
        """Get all bets by a specific user"""
        pass


class CoinRepository(ABC):
    @abstractmethod
    async def get_coin_by_name(self, coin_name: str) -> Optional[Coin]:
        """Get coin information by name"""
        pass

    @abstractmethod
    async def get_all_coins(self) -> List[Coin]:
        """Get all available coins"""
        pass
