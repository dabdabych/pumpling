import secrets
import re
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from typing import Optional
from urllib.parse import urlencode

import bcrypt
from ..entities.user import User, UserRole
from ..repositories.user_repository import UserRepository
from .registration_email_sender import NoopRegistrationEmailSender, RegistrationEmailSender


EMAIL_VERIFICATION_TOKEN_TTL = timedelta(hours=24)
PASSWORD_RESET_TOKEN_TTL = timedelta(hours=24)


class EmailNotVerifiedError(ValueError):
    pass


class AuthService:
    def __init__(
        self,
        user_repository: UserRepository,
        registration_email_sender: RegistrationEmailSender | None = None,
        public_app_base_url: str = "http://localhost:3200",
    ):
        self._user_repository = user_repository
        self._registration_email_sender = registration_email_sender or NoopRegistrationEmailSender()
        self._public_app_base_url = public_app_base_url.rstrip("/")

    async def register(self, username: str, email: str, password: str, nickname: str) -> User:
        nickname = nickname.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]{3,32}", nickname):
            raise ValueError("Nickname must contain 3-32 letters, digits, or underscores")
        existing_user = await self._user_repository.find_by_username(username)
        if existing_user and existing_user.is_email_verified:
            raise ValueError("Username already exists")

        existing_email = await self._user_repository.find_by_email(email)
        if existing_email and existing_email.is_email_verified:
            raise ValueError("Email already exists")

        existing_nickname = await self._user_repository.find_by_nickname(nickname)
        if existing_nickname and existing_nickname.email != email:
            raise ValueError("Nickname already exists")

        token = self._create_email_verification_token()
        expires_at = self._utc_now() + EMAIL_VERIFICATION_TOKEN_TTL
        hashed_password = self.hash_password(password)
        user = existing_email or existing_user
        if user:
            user.username = username
            user.email = email
            user.nickname = nickname
            user.hashed_password = hashed_password
            user.is_active = False
            user.is_email_verified = False
            user.email_verified_at = None
            user.email_verification_token_hash = self.hash_email_verification_token(token)
            user.email_verification_expires_at = expires_at
            user.password_reset_token_hash = None
            user.password_reset_expires_at = None
        else:
            user = User(
                None,
                username,
                email,
                hashed_password,
                False,
                UserRole.CUSTOMER,
                False,
                self.hash_email_verification_token(token),
                expires_at,
                None,
            )
            user.nickname = nickname

        saved_user = await self._user_repository.save(user)
        confirmation_url = self._build_email_confirmation_url(token)
        await self._registration_email_sender.send_registration_email(saved_user, confirmation_url)
        return saved_user

    async def confirm_email(self, token: str) -> User:
        token_hash = self.hash_email_verification_token(token)
        user = await self._user_repository.find_by_email_verification_token_hash(token_hash)
        if not user:
            raise ValueError("Invalid confirmation link")

        expires_at = user.email_verification_expires_at
        if not expires_at or self._ensure_utc(expires_at) <= self._utc_now():
            raise ValueError("Confirmation link has expired")

        user.is_active = True
        user.is_email_verified = True
        user.email_verified_at = self._utc_now()
        user.email_verification_token_hash = None
        user.email_verification_expires_at = None
        return await self._user_repository.save(user)

    async def request_password_reset(self, email: str) -> Optional[User]:
        user = await self._user_repository.find_by_email(email)
        if not user or not user.is_active or not user.is_email_verified:
            return None

        token = self._create_token()
        user.password_reset_token_hash = self.hash_token(token)
        user.password_reset_expires_at = self._utc_now() + PASSWORD_RESET_TOKEN_TTL
        saved_user = await self._user_repository.save(user)
        reset_url = self._build_password_reset_url(token)
        await self._registration_email_sender.send_password_reset_email(saved_user, reset_url)
        return saved_user

    async def reset_password(self, token: str, password: str) -> User:
        token_hash = self.hash_token(token)
        user = await self._user_repository.find_by_password_reset_token_hash(token_hash)
        if not user:
            raise ValueError("Invalid password reset link")

        expires_at = user.password_reset_expires_at
        if not expires_at or self._ensure_utc(expires_at) <= self._utc_now():
            raise ValueError("Password reset link has expired")

        user.hashed_password = self.hash_password(password)
        user.password_reset_token_hash = None
        user.password_reset_expires_at = None
        return await self._user_repository.save(user)

    async def authenticate(self, username: str, password: str) -> Optional[User]:
        user = await self._user_repository.find_by_username(username)
        if not user:
            return None

        if bcrypt.checkpw(password.encode('utf-8'), user.hashed_password.encode('utf-8')):
            if not user.is_active or not user.is_email_verified:
                raise EmailNotVerifiedError("Email is not verified")
            return user
        return None

    @staticmethod
    def hash_password(password: str) -> str:
        return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    @staticmethod
    def hash_email_verification_token(token: str) -> str:
        return AuthService.hash_token(token)

    @staticmethod
    def hash_token(token: str) -> str:
        return sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _create_email_verification_token() -> str:
        return AuthService._create_token()

    @staticmethod
    def _create_token() -> str:
        return secrets.token_urlsafe(32)

    @staticmethod
    def _utc_now() -> datetime:
        return datetime.now(timezone.utc)

    @staticmethod
    def _ensure_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _build_email_confirmation_url(self, token: str) -> str:
        return f"{self._public_app_base_url}/confirm-email?{urlencode({'token': token})}"

    def _build_password_reset_url(self, token: str) -> str:
        return f"{self._public_app_base_url}/reset-password?{urlencode({'token': token})}"
