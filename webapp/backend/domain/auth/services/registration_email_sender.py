from typing import Protocol

from domain.auth.entities.user import User


class RegistrationEmailSender(Protocol):
    async def send_registration_email(self, user: User, confirmation_url: str) -> None:
        ...

    async def send_password_reset_email(self, user: User, reset_url: str) -> None:
        ...


class NoopRegistrationEmailSender:
    async def send_registration_email(self, user: User, confirmation_url: str) -> None:
        return None

    async def send_password_reset_email(self, user: User, reset_url: str) -> None:
        return None
