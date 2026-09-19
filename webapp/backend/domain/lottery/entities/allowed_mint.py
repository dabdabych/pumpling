from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional


class NetworkType(Enum):
    MAINNET = "mainnet"
    DEVNET = "devnet"


@dataclass
class AllowedMint:
    id: Optional[int]
    mint: str
    network_type: NetworkType
    created_at: datetime

    def __post_init__(self):
        if not self.mint or len(self.mint.strip()) == 0:
            raise ValueError("Mint cannot be empty")
