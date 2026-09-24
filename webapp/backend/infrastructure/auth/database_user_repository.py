from typing import Optional, List
from sqlalchemy import func
from sqlalchemy.orm import Session
from domain.auth.entities.user import User, UserRole
from domain.auth.repositories.user_repository import UserRepository
from infrastructure.database.models.user_model import UserModel


class DatabaseUserRepository(UserRepository):
    def __init__(self, db: Session):
        self.db = db

    async def find_by_username(self, username: str) -> Optional[User]:
        # Since our User entity uses email for authentication, we'll search by email
        return await self.find_by_email(username)

    async def find_by_email(self, email: str) -> Optional[User]:
        # Case-insensitive, like `find_by_nickname` below and like every mail
        # provider. An exact match here meant that registering as Ivan@… and
        # signing in as ivan@… found nobody, which the sign-in form reports as
        # a wrong password.
        user_model = (
            self.db.query(UserModel)
            .filter(func.lower(UserModel.email) == (email or "").strip().lower())
            .first()
        )
        if user_model:
            return self._model_to_entity(user_model)
        return None

    async def find_by_nickname(self, nickname: str) -> Optional[User]:
        user_model = self.db.query(UserModel).filter(func.lower(UserModel.nickname) == nickname.lower()).first()
        if user_model:
            return self._model_to_entity(user_model)
        return None

    async def find_by_email_verification_token_hash(self, token_hash: str) -> Optional[User]:
        user_model = (
            self.db.query(UserModel)
            .filter(UserModel.email_verification_token_hash == token_hash)
            .first()
        )
        if user_model:
            return self._model_to_entity(user_model)
        return None

    async def find_by_password_reset_token_hash(self, token_hash: str) -> Optional[User]:
        user_model = (
            self.db.query(UserModel)
            .filter(UserModel.password_reset_token_hash == token_hash)
            .first()
        )
        if user_model:
            return self._model_to_entity(user_model)
        return None

    async def save(self, user: User) -> User:
        if user.id is None:
            # Create new user
            user_model = UserModel(
                email=user.email,
                nickname=user.nickname,
                hashed_password=user.hashed_password,
                is_active=user.is_active,
                role=user.role,
                is_email_verified=user.is_email_verified,
                email_verification_token_hash=user.email_verification_token_hash,
                email_verification_expires_at=user.email_verification_expires_at,
                email_verified_at=user.email_verified_at,
                password_reset_token_hash=user.password_reset_token_hash,
                password_reset_expires_at=user.password_reset_expires_at,
            )
            self.db.add(user_model)
            self.db.commit()
            self.db.refresh(user_model)
            user.id = user_model.id
        else:
            # Update existing user
            user_model = self.db.query(UserModel).filter(UserModel.id == user.id).first()
            if user_model:
                user_model.email = user.email
                user_model.nickname = user.nickname
                user_model.hashed_password = user.hashed_password
                user_model.is_active = user.is_active
                user_model.role = user.role
                user_model.is_email_verified = user.is_email_verified
                user_model.email_verification_token_hash = user.email_verification_token_hash
                user_model.email_verification_expires_at = user.email_verification_expires_at
                user_model.email_verified_at = user.email_verified_at
                user_model.password_reset_token_hash = user.password_reset_token_hash
                user_model.password_reset_expires_at = user.password_reset_expires_at
                self.db.commit()
                self.db.refresh(user_model)

        return user

    async def find_by_id(self, user_id: int) -> Optional[User]:
        user_model = self.db.query(UserModel).filter(UserModel.id == user_id).first()
        if user_model:
            return self._model_to_entity(user_model)
        return None

    async def find_all(self, skip: int = 0, limit: int = 10) -> tuple[List[User], int]:
        total_count = self.db.query(UserModel).count()
        user_models = self.db.query(UserModel).offset(skip).limit(limit).all()
        users = [self._model_to_entity(model) for model in user_models]
        return users, total_count

    def _model_to_entity(self, user_model: UserModel) -> User:
        return User(
            id=user_model.id,
            username=user_model.email,  # Using email as username
            email=user_model.email,
            hashed_password=user_model.hashed_password,
            is_active=user_model.is_active,
            role=user_model.role,
            is_email_verified=user_model.is_email_verified,
            email_verification_token_hash=user_model.email_verification_token_hash,
            email_verification_expires_at=user_model.email_verification_expires_at,
            email_verified_at=user_model.email_verified_at,
            password_reset_token_hash=user_model.password_reset_token_hash,
            password_reset_expires_at=user_model.password_reset_expires_at,
            nickname=user_model.nickname,
        )
