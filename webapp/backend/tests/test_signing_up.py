"""Getting an account, from the outside.

Written after this report from somebody trying it for the first time:

    while I was signing in it refused five times: wrong password, then it would
    not let me onto the platform until I confirmed the email. I wanted to quit
    within thirty seconds.

Three separate things were behind that, and each has a class here.

The password: the browser demanded a lowercase letter, an uppercase letter, a
digit, a special character and eight characters at once, and the server
demanded nothing at all, not even a length. Now there is one rule, in the
domain layer, and both the sign-up and the reset link go through it.

The address: `find_by_email` compared case-sensitively while `find_by_nickname`
right below it did not, so registering as Ivan@… and signing in as ivan@… found
nobody, and the answer to that is "wrong email or password".

The dead end: an account whose confirmation email never arrived had nowhere to
go. Signing in said "not confirmed", the password reset does nothing for an
unconfirmed account, and the only way through was to register again with the
same address, which happens to work and which nothing mentioned.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from domain.auth.entities.user import User, UserRole  # noqa: E402
from domain.auth.services.auth_service import AuthService  # noqa: E402
from domain.auth.services.password_rules import (  # noqa: E402
    MAX_BYTES,
    MIN_LENGTH,
    PasswordRejected,
    describe_rules,
    validate_password,
)

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


class FakeRepository:
    """Users in a dict, looked up the way the real repository looks them up."""

    def __init__(self):
        self.users: list[User] = []
        self._next_id = 1

    async def find_by_email(self, email):
        wanted = (email or "").strip().lower()
        for user in self.users:
            if user.email.lower() == wanted:
                return user
        return None

    async def find_by_username(self, username):
        return await self.find_by_email(username)

    async def find_by_nickname(self, nickname):
        for user in self.users:
            if (getattr(user, "nickname", "") or "").lower() == nickname.lower():
                return user
        return None

    async def find_by_email_verification_token_hash(self, token_hash):
        for user in self.users:
            if user.email_verification_token_hash == token_hash:
                return user
        return None

    async def find_by_password_reset_token_hash(self, token_hash):
        for user in self.users:
            if user.password_reset_token_hash == token_hash:
                return user
        return None

    async def save(self, user):
        if user.id is None:
            user.id = self._next_id
            self._next_id += 1
            self.users.append(user)
        return user


class Mailbox:
    """Every email that went out, in order."""

    def __init__(self):
        self.confirmations: list[tuple[str, str]] = []
        self.resets: list[tuple[str, str]] = []

    async def send_registration_email(self, user, url):
        self.confirmations.append((user.email, url))

    async def send_password_reset_email(self, user, url):
        self.resets.append((user.email, url))


@pytest.fixture
def service():
    repo = FakeRepository()
    mailbox = Mailbox()
    auth = AuthService(repo, mailbox, "https://pumpling.xyz")
    return auth, repo, mailbox


def sign_up(service, email="person@example.com", password="correct horse 9", nickname="person"):
    auth, _repo, _mail = service
    return run(auth.register(email, email, password, nickname))


class TestThePasswordRule:
    """One rule, and it is the server's.

    NIST SP 800-63B: "Verifiers SHOULD NOT impose other composition rules (e.g.,
    requiring mixtures of different character types) for memorized secrets."
    A digit is kept as a product decision; the uppercase and special character
    demands are gone.
    """

    @pytest.mark.parametrize("password", [
        "passw0rdish",
        "9 llamas in a trenchcoat",
        "aaaaaaa1",
        # Not Latin, and multibyte: the length floor counts characters while
        # the ceiling counts bytes, so the two must not be confused.
        "κωδικός1234",
    ])
    def test_a_reasonable_password_is_accepted(self, password):
        validate_password(password)

    def test_no_uppercase_is_needed(self):
        # The one the report actually complained about.
        validate_password("all lower case 1")

    def test_no_special_character_is_needed(self):
        validate_password("justletters1")

    def test_too_short_is_refused(self):
        with pytest.raises(PasswordRejected) as caught:
            validate_password("shor1")
        assert str(MIN_LENGTH) in str(caught.value)

    def test_without_a_digit_is_refused(self):
        with pytest.raises(PasswordRejected) as caught:
            validate_password("no digits here")
        assert "digit" in str(caught.value)

    def test_a_common_password_is_refused_however_well_it_is_shaped(self):
        # Satisfies every composition rule the old form had, and is on every list.
        with pytest.raises(PasswordRejected) as caught:
            validate_password("Password1")
        assert "common" in str(caught.value)

    def test_a_long_passphrase_still_fits(self):
        # NIST asks for at least 64 characters to be usable.
        validate_password("a" * 64 + "1")

    def test_past_what_bcrypt_hashes_is_refused_rather_than_truncated(self):
        # bcrypt reads the first 72 bytes and ignores the rest, so accepting
        # this quietly would mean two passwords sharing a hash.
        with pytest.raises(PasswordRejected):
            validate_password("a" * MAX_BYTES + "1")

    def test_one_message_at_a_time(self):
        # The old form listed every unmet rule at once, which is what made it
        # feel like a fight. Length is what is wrong here, not the digit.
        with pytest.raises(PasswordRejected) as caught:
            validate_password("ab1")
        assert "digit" not in str(caught.value)

    def test_the_rules_are_stated_up_front(self):
        assert str(MIN_LENGTH) in describe_rules()
        assert "digit" in describe_rules()


class TestTheResetLinkUsesTheSameRule:
    """It used to be the way around the rules: the server checked nothing."""

    def _reset_token(self, service):
        """Register, confirm, ask for a reset, and read the token out of the email."""
        auth, repo, mailbox = service
        sign_up(service)
        user = repo.users[0]
        user.is_active = True
        user.is_email_verified = True
        run(auth.request_password_reset(user.email))
        return auth, repo, mailbox.resets[0][1].split("token=")[1]

    def test_a_weak_new_password_is_refused(self, service):
        auth, _repo, token = self._reset_token(service)

        with pytest.raises(PasswordRejected):
            run(auth.reset_password(token, "short"))

    def test_a_good_new_password_goes_through(self, service):
        auth, repo, token = self._reset_token(service)

        run(auth.reset_password(token, "a whole new 1"))

        assert repo.users[0].password_reset_token_hash is None


class TestTheAddressIsNotCaseSensitive:
    def test_signing_in_with_a_different_case_finds_the_account(self, service):
        auth, _repo, _mail = service
        run(auth.register("Ivan@Example.com", "Ivan@Example.com", "correct horse 9", "ivan"))
        # The account is confirmed by hand: this is about the lookup, not the gate.
        _repo.users[0].is_active = True
        _repo.users[0].is_email_verified = True

        found = run(auth.authenticate("ivan@example.com", "correct horse 9"))

        assert found is not None

    def test_the_address_is_stored_lowercase(self, service):
        _auth, repo, _mail = service
        run(_auth.register("Ivan@Example.com", "Ivan@Example.com", "correct horse 9", "ivan"))

        assert repo.users[0].email == "ivan@example.com"

    def test_registering_again_in_another_case_is_the_same_account(self, service):
        auth, repo, _mail = service
        run(auth.register("Ivan@Example.com", "Ivan@Example.com", "correct horse 9", "ivan"))
        run(auth.register("IVAN@example.COM", "IVAN@example.COM", "correct horse 9", "ivan"))

        assert len(repo.users) == 1


class TestTheConfirmationEmailCanBeAskedForAgain:
    def test_a_new_link_goes_out(self, service):
        auth, _repo, mailbox = service
        sign_up(service)
        assert len(mailbox.confirmations) == 1

        run(auth.resend_confirmation("person@example.com"))

        assert len(mailbox.confirmations) == 2

    def test_the_new_link_is_not_the_old_one(self, service):
        auth, _repo, mailbox = service
        sign_up(service)

        run(auth.resend_confirmation("person@example.com"))

        assert mailbox.confirmations[0][1] != mailbox.confirmations[1][1]

    def test_the_new_link_works(self, service):
        auth, repo, mailbox = service
        sign_up(service)
        run(auth.resend_confirmation("person@example.com"))
        token = mailbox.confirmations[1][1].split("token=")[1]

        confirmed = run(auth.confirm_email(token))

        assert confirmed.is_email_verified is True

    def test_the_old_link_stops_working(self, service):
        auth, _repo, mailbox = service
        sign_up(service)
        old_token = mailbox.confirmations[0][1].split("token=")[1]
        run(auth.resend_confirmation("person@example.com"))

        with pytest.raises(ValueError):
            run(auth.confirm_email(old_token))

    def test_an_address_with_no_account_sends_nothing(self, service):
        auth, _repo, mailbox = service

        result = run(auth.resend_confirmation("nobody@example.com"))

        assert result is None
        assert mailbox.confirmations == []

    def test_an_account_already_confirmed_sends_nothing(self, service):
        auth, repo, mailbox = service
        sign_up(service)
        repo.users[0].is_email_verified = True

        result = run(auth.resend_confirmation("person@example.com"))

        assert result is None
        assert len(mailbox.confirmations) == 1

    def test_the_case_of_the_address_does_not_matter(self, service):
        auth, _repo, mailbox = service
        sign_up(service, email="person@example.com")

        run(auth.resend_confirmation("PERSON@Example.COM"))

        assert len(mailbox.confirmations) == 2
