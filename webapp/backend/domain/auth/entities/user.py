from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from enum import Enum


class UserRole(Enum):
    CUSTOMER = "customer"
    ADMIN = "admin"


@dataclass
class User:
    id: Optional[int]
    username: str
    email: str
    hashed_password: str
    is_active: bool = True
    role: UserRole = UserRole.CUSTOMER
    is_email_verified: bool = True
    email_verification_token_hash: Optional[str] = None
    email_verification_expires_at: Optional[datetime] = None
    email_verified_at: Optional[datetime] = None
    password_reset_token_hash: Optional[str] = None
    password_reset_expires_at: Optional[datetime] = None
    nickname: str = ""

    def __post_init__(self):
        if not self.username or len(self.username) < 3:
            raise ValueError("Username must be at least 3 characters")
        if not self.email or "@" not in self.email:
            raise ValueError("Invalid email format")
        if self.nickname and (len(self.nickname) < 3 or len(self.nickname) > 32 or not self.nickname.replace("_", "").isalnum()):
            raise ValueError("Nickname must contain only letters, digits, and underscores")
