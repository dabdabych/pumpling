from dataclasses import dataclass
from decimal import Decimal
from .coin import Coin


@dataclass
class LotteryEntry:
    """
    Calculated entry showing aggregated betting data for a coin in a specific lottery
    """
    rank: int
    lottery_id: int
    coin: Coin
    total_solana_bet: Decimal
    bet_count: int  # Number of users who bet on this coin

    def __post_init__(self):
        if self.lottery_id <= 0:
            raise ValueError("Lottery ID must be positive")
        if self.total_solana_bet < 0:
            raise ValueError("Total solana bet cannot be negative")
        if self.bet_count < 0:
            raise ValueError("Bet count cannot be negative")
        # Note: rank validation removed because it gets set after creation