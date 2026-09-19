import pytest

from domain.auth.services.auth_service import AuthService, EmailNotVerifiedError
from tests.fakes.memory_user_repository import MemoryUserRepository


class _RecordingEmailSender:
    def __init__(self):
        self.sent_to = []
        self.confirmation_urls = []
        self.password_reset_urls = []

    async def send_registration_email(self, user, confirmation_url):
        self.sent_to.append(user.email)
        self.confirmation_urls.append(confirmation_url)

    async def send_password_reset_email(self, user, reset_url):
        self.password_reset_urls.append(reset_url)


class _FailingEmailSender:
    async def send_registration_email(self, user, confirmation_url):
        raise RuntimeError("smtp unavailable")

    async def send_password_reset_email(self, user, reset_url):
        raise RuntimeError("smtp unavailable")


@pytest.mark.asyncio
async def test_register_sends_registration_email() -> None:
    sender = _RecordingEmailSender()
    service = AuthService(MemoryUserRepository(), sender)

    user = await service.register("user@example.com", "user@example.com", "Passw0rd!", "TestUser")

    assert user.id == 1
    assert user.nickname == "TestUser"
    assert user.is_active is False
    assert user.is_email_verified is False
    assert user.email_verification_token_hash
    assert user.email_verification_expires_at
    assert sender.sent_to == ["user@example.com"]
    assert sender.confirmation_urls[0].startswith("http://localhost:3200/confirm-email?token=")


@pytest.mark.asyncio
async def test_registration_email_failure_blocks_registration_response() -> None:
    service = AuthService(MemoryUserRepository(), _FailingEmailSender())

    with pytest.raises(RuntimeError, match="smtp unavailable"):
        await service.register("user@example.com", "user@example.com", "Passw0rd!", "TestUser")


@pytest.mark.asyncio
async def test_register_rejects_duplicate_nickname_regardless_of_case() -> None:
    service = AuthService(MemoryUserRepository(), _RecordingEmailSender())
    await service.register("first@example.com", "first@example.com", "Passw0rd!", "TestUser")

    with pytest.raises(ValueError, match="Nickname already exists"):
        await service.register("second@example.com", "second@example.com", "Passw0rd!", "testuser")


@pytest.mark.asyncio
async def test_unconfirmed_user_cannot_authenticate() -> None:
    service = AuthService(MemoryUserRepository(), _RecordingEmailSender())
    await service.register("user@example.com", "user@example.com", "Passw0rd!", "TestUser")

    with pytest.raises(EmailNotVerifiedError):
        await service.authenticate("user@example.com", "Passw0rd!")


@pytest.mark.asyncio
async def test_confirm_email_activates_user_and_allows_login() -> None:
    sender = _RecordingEmailSender()
    service = AuthService(MemoryUserRepository(), sender)
    user = await service.register("user@example.com", "user@example.com", "Passw0rd!", "TestUser")
    token = sender.confirmation_urls[0].split("token=", 1)[1]

    confirmed_user = await service.confirm_email(token)
    authenticated_user = await service.authenticate("user@example.com", "Passw0rd!")

    assert confirmed_user.id == user.id
    assert confirmed_user.is_active is True
    assert confirmed_user.is_email_verified is True
    assert confirmed_user.email_verified_at
    assert confirmed_user.email_verification_token_hash is None
    assert confirmed_user.email_verification_expires_at is None
    assert authenticated_user.id == user.id


@pytest.mark.asyncio
async def test_request_password_reset_sends_reset_link_for_active_user() -> None:
    sender = _RecordingEmailSender()
    service = AuthService(MemoryUserRepository(), sender)
    await service.register("user@example.com", "user@example.com", "Passw0rd!", "TestUser")
    await service.confirm_email(sender.confirmation_urls[0].split("token=", 1)[1])

    user = await service.request_password_reset("user@example.com")

    assert user.password_reset_token_hash
    assert user.password_reset_expires_at
    assert sender.password_reset_urls[0].startswith("http://localhost:3200/reset-password?token=")


@pytest.mark.asyncio
async def test_reset_password_updates_password_and_consumes_token() -> None:
    sender = _RecordingEmailSender()
    service = AuthService(MemoryUserRepository(), sender)
    await service.register("user@example.com", "user@example.com", "Passw0rd!", "TestUser")
    await service.confirm_email(sender.confirmation_urls[0].split("token=", 1)[1])
    await service.request_password_reset("user@example.com")
    token = sender.password_reset_urls[0].split("token=", 1)[1]

    user = await service.reset_password(token, "NewPassw0rd!")
    old_password_user = await service.authenticate("user@example.com", "Passw0rd!")
    new_password_user = await service.authenticate("user@example.com", "NewPassw0rd!")

    assert user.password_reset_token_hash is None
    assert user.password_reset_expires_at is None
    assert old_password_user is None
    assert new_password_user.id == user.id
    with pytest.raises(ValueError, match="Invalid password reset link"):
        await service.reset_password(token, "AnotherPassw0rd!")
