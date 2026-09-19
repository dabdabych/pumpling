from dataclasses import dataclass
from typing import Optional, List
from decimal import Decimal


@dataclass
class PricePoint:
    timestamp: int  # Unix timestamp
    price: Decimal


@dataclass
class Coin:
    name: str
    symbol: str
    market_cap: Decimal
    current_price: Decimal
    price_history: List[PricePoint]
    volume_24h: Decimal
    logo_url: Optional[str] = None

    def __post_init__(self):
        if not self.name or len(self.name.strip()) == 0:
            raise ValueError("Coin name cannot be empty")
        if not self.symbol or len(self.symbol.strip()) == 0:
            raise ValueError("Coin symbol cannot be empty")
        if self.market_cap < 0:
            raise ValueError("Market cap cannot be negative")
        if self.current_price < 0:
            raise ValueError("Current price cannot be negative")
        if self.volume_24h < 0:
            raise ValueError("Volume 24h cannot be negative")