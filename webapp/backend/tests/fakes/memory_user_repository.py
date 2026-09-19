from typing import Dict, List, Optional

from domain.auth.entities.user import User
from domain.auth.repositories.user_repository import UserRepository


class MemoryUserRepository(UserRepository):
    def __init__(self):
        self._users: Dict[int, User] = {}
        self._next_id = 1

    async def find_by_username(self, username: str) -> Optional[User]:
        for user in self._users.values():
            if user.username == username:
                return user
        return None

    async def find_by_email(self, email: str) -> Optional[User]:
        for user in self._users.values():
            if user.email == email:
                return user
        return None

    async def find_by_nickname(self, nickname: str) -> Optional[User]:
        for user in self._users.values():
            if user.nickname.lower() == nickname.lower():
                return user
        return None

    async def find_by_email_verification_token_hash(self, token_hash: str) -> Optional[User]:
        for user in self._users.values():
            if user.email_verification_token_hash == token_hash:
                return user
        return None

    async def find_by_password_reset_token_hash(self, token_hash: str) -> Optional[User]:
        for user in self._users.values():
            if user.password_reset_token_hash == token_hash:
                return user
        return None

    async def save(self, user: User) -> User:
        if user.id is None:
            user.id = self._next_id
            self._next_id += 1

        self._users[user.id] = user
        return user

    async def find_by_id(self, user_id: int) -> Optional[User]:
        return self._users.get(user_id)

    async def find_all(self, skip: int = 0, limit: int = 10) -> tuple[List[User], int]:
        all_users = list(self._users.values())
        total_count = len(all_users)
        paginated_users = all_users[skip:skip + limit]
        return paginated_users, total_count
