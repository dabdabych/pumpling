from dataclasses import dataclass
from typing import Optional
from datetime import datetime
from decimal import Decimal


@dataclass
class Bet:
    id: Optional[int]
    lottery_id: int
    user_id: int
    coin_name: str
    solana_amount: Decimal
    created_at: datetime

    def __post_init__(self):
        if self.lottery_id <= 0:
            raise ValueError("Lottery ID must be positive")
        if self.user_id <= 0:
            raise ValueError("User ID must be positive")
        if not self.coin_name or len(self.coin_name.strip()) == 0:
            raise ValueError("Coin name cannot be empty")
        if self.solana_amount <= 0:
            raise ValueError("Solana amount must be positive")