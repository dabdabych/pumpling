"""The two guards around signing up: the resend cooldown and the signing key.

The cooldown exists because every confirmation email costs a send at the
provider and lands in somebody's real inbox. The thing worth getting right is
that it must not become a way to ask "is this address registered": the answer
is the same for an address with an account, an address without one, and an
address that has just used up its allowance.

The signing key exists because it used to be the literal `your-secret-key-here`
in two routers, which shipped in the source and then in a public repository.
The token says which user id a request belongs to and nothing else is checked,
so the key was the whole of the authentication, and three user ids are
administrators.
"""
from __future__ import annotations

import asyncio
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from presentation.auth import auth_router as auth  # noqa: E402
from shared.settings import AppSettings, _checked_secret  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class Request:
    def __init__(self, email):
        self.email = email


class ServiceThatRecords:
    def __init__(self):
        self.asked: list[str] = []

    async def resend_confirmation(self, email):
        self.asked.append(email)
        return None


@pytest.fixture(autouse=True)
def fresh_cooldown():
    auth.resend_cooldown.reset_for_tests()
    yield
    auth.resend_cooldown.reset_for_tests()


def resend(email, service=None):
    return run(auth.resend_confirmation(Request(email), auth_service=service or ServiceThatRecords()))


class TestTheResendAnswerGivesNothingAway:
    def test_an_address_with_no_account_gets_the_ordinary_answer(self):
        answer = resend("nobody@example.com")
        assert "sent the link again" in answer.message

    def test_an_address_with_an_account_gets_the_same_answer(self):
        answer = resend("somebody@example.com")
        assert "sent the link again" in answer.message

    def test_a_provider_failure_does_not_change_the_answer(self):
        class Broken:
            async def resend_confirmation(self, email):
                raise RuntimeError("smtp is down")

        answer = resend("somebody@example.com", Broken())

        assert "sent the link again" in answer.message


class TestTheCooldown:
    def test_a_second_try_straight_away_is_refused(self):
        resend("person@example.com")

        with pytest.raises(HTTPException) as caught:
            resend("person@example.com")

        assert caught.value.status_code == 429

    def test_it_says_how_long_to_wait(self):
        resend("person@example.com")

        with pytest.raises(HTTPException) as caught:
            resend("person@example.com")

        retry_after = int(caught.value.headers["Retry-After"])
        assert 1 <= retry_after <= auth.CONFIRMATION_RESEND_COOLDOWN_SECONDS + 1

    def test_the_second_email_is_not_sent(self):
        service = ServiceThatRecords()
        resend("person@example.com", service)
        with pytest.raises(HTTPException):
            resend("person@example.com", service)

        assert service.asked == ["person@example.com"]

    def test_another_address_is_not_held_back(self):
        resend("one@example.com")

        answer = resend("two@example.com")

        assert "sent the link again" in answer.message

    def test_the_case_of_the_address_does_not_get_around_it(self):
        resend("person@example.com")

        with pytest.raises(HTTPException):
            resend("PERSON@Example.COM")

    def test_an_address_with_no_account_is_held_back_too(self):
        # If only real accounts were counted, a 429 would answer the question
        # the neutral message exists to avoid.
        resend("nobody@example.com")

        with pytest.raises(HTTPException) as caught:
            resend("nobody@example.com")

        assert caught.value.status_code == 429

    def test_the_hourly_ceiling_holds(self, monkeypatch):
        # The cooldown is stepped over to get at the other limit.
        monkeypatch.setattr(auth, "CONFIRMATION_RESEND_COOLDOWN_SECONDS", 0)
        for _ in range(auth.CONFIRMATION_RESEND_MAX_PER_HOUR):
            resend("person@example.com")

        with pytest.raises(HTTPException) as caught:
            resend("person@example.com")

        assert caught.value.status_code == 429


class TestTheSigningKey:
    def test_a_missing_key_is_refused(self):
        with pytest.raises(ValueError) as caught:
            _checked_secret("JWT_SECRET_KEY", "")

        assert "openssl rand -hex 32" in str(caught.value)

    def test_a_short_key_is_refused(self):
        with pytest.raises(ValueError) as caught:
            _checked_secret("JWT_SECRET_KEY", "too-short")

        assert "at least" in str(caught.value)

    def test_the_old_literal_would_not_be_accepted_now(self):
        # 20 characters, which is what shipped.
        with pytest.raises(ValueError):
            _checked_secret("JWT_SECRET_KEY", "your-secret-key-here")

    def test_a_real_key_passes(self):
        assert _checked_secret("JWT_SECRET_KEY", "a" * 64) == "a" * 64

    def test_a_worker_can_build_settings_without_one(self):
        # The phase worker reads the same settings object and signs nothing, so
        # the key is checked when something asks for it rather than when the
        # settings are built. A missing key must stop the API, not the process
        # that drives rounds.
        built = AppSettings.__dataclass_fields__
        assert "jwt_secret_key_raw" in built
        assert "jwt_secret_key" not in built  # a property, checked on access
