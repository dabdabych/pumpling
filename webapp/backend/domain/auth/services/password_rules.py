"""What counts as an acceptable password, in one place.

Until now there were two sets of rules and neither was in a good place. The
browser demanded a lowercase letter, an uppercase letter, a digit, a special
character and eight characters, all at once, and said only "Still needed: ..."
until you satisfied every one. The server demanded nothing at all: not even a
length. So the form fought people who were trying to sign up, and a password set
through the reset link went in unchecked.

NIST SP 800-63B is explicit about the first half of that:

    Verifiers SHOULD NOT impose other composition rules (e.g., requiring
    mixtures of different character types) for memorized secrets.

and asks instead for a length floor, support for long passphrases, and a check
against passwords already known to be common or breached. Composition rules
push people towards `Password1!`, which satisfies every rule and is on every
list.

So the rules here are: at least eight characters, a digit, not something out of
the blocklist, and short enough for bcrypt to actually hash. The digit is a
product decision rather than a recommendation; the uppercase and special
character requirements are gone.

It lives in the domain layer because it is a rule about accounts, not about
HTTP: registration and the reset link both go through it, so neither can be
the lenient one. The browser mirrors it in
`webapp/ui/src/app/shared/password-rules.ts`, and
`tests/test_password_rules.py` checks the two have not drifted apart.
"""
from __future__ import annotations

import re

MIN_LENGTH = 8

#: bcrypt hashes the first 72 bytes and silently ignores the rest, so two
#: passwords sharing a 72-byte prefix would share a hash. Rather than pre-hash,
#: which would invalidate every password already stored, anything longer is
#: refused and said so plainly. 72 bytes is comfortably past the 64 characters
#: NIST asks to support, unless the passphrase is mostly non-Latin.
MAX_BYTES = 72

_DIGIT = re.compile(r"\d")

#: Passwords common enough that a blocklist is worth more than any composition
#: rule. Short on purpose: this catches the lazy end, it is not a breach
#: corpus. The proper version of this check is the Have I Been Pwned range API,
#: which needs a network call on the sign-up path and is not wired up.
_BLOCKLIST = frozenset({
    "password", "password1", "password12", "password123", "password1234",
    "passw0rd", "p@ssword", "p@ssw0rd", "passsword", "mypassword",
    "12345678", "123456789", "1234567890", "123123123", "111111111",
    "qwerty123", "qwertyui", "qwerty1234", "1qaz2wsx", "qazwsxedc",
    "iloveyou", "princess", "sunshine", "football", "baseball",
    "superman", "batman123", "trustno1", "letmein1", "welcome1",
    "admin123", "administrator", "root1234", "master123", "changeme",
    "abc12345", "a1234567", "asdf1234", "zxcvbnm1", "monkey123",
    "solana123", "pumpling", "pumpling1", "pumpling123", "pumpfun123",
    "crypto123", "bitcoin1", "memecoin", "moonmoon", "tothemoon",
})


class PasswordRejected(ValueError):
    """Why this password cannot be used, in words meant for the person."""


def validate_password(password: str) -> None:
    """Raise `PasswordRejected` when the password may not be used.

    The messages name the one thing that is wrong, in the order a person would
    fix it. Listing every unmet rule at once is what made the old form feel
    like a fight.
    """
    if password is None or password == "":
        raise PasswordRejected("Enter a password.")

    if len(password) < MIN_LENGTH:
        raise PasswordRejected(f"Use at least {MIN_LENGTH} characters.")

    if len(password.encode("utf-8")) > MAX_BYTES:
        raise PasswordRejected(f"That is too long. Keep it under {MAX_BYTES} characters.")

    if not _DIGIT.search(password):
        raise PasswordRejected("Add at least one digit.")

    if password.strip().lower() in _BLOCKLIST:
        raise PasswordRejected("That password is too common. Pick another one.")


def describe_rules() -> str:
    """The one line the sign-up form shows before anything is typed.

    Telling people the rule up front is what stops the guessing. The browser
    carries the same sentence, and a test keeps the two identical.
    """
    return f"At least {MIN_LENGTH} characters, including a digit."
