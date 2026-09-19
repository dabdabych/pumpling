from abc import ABC, abstractmethod
from typing import Optional, List
from ..entities.user import User


class UserRepository(ABC):
    @abstractmethod
    async def find_by_username(self, username: str) -> Optional[User]:
        pass

    @abstractmethod
    async def find_by_email(self, email: str) -> Optional[User]:
        pass

    @abstractmethod
    async def find_by_nickname(self, nickname: str) -> Optional[User]:
        pass

    @abstractmethod
    async def find_by_email_verification_token_hash(self, token_hash: str) -> Optional[User]:
        pass

    @abstractmethod
    async def find_by_password_reset_token_hash(self, token_hash: str) -> Optional[User]:
        pass

    @abstractmethod
    async def save(self, user: User) -> User:
        pass

    @abstractmethod
    async def find_by_id(self, user_id: int) -> Optional[User]:
        pass

    @abstractmethod
    async def find_all(self, skip: int = 0, limit: int = 10) -> tuple[List[User], int]:
        pass
