"""The browser's copy of the password rule against the server's.

There are two copies on purpose: the browser needs to answer while somebody is
typing, and the server is the one that decides. Two copies drift, and the last
time they did the result was a form that demanded four kinds of character and a
server that accepted a one-character password through the reset link.

So the numbers and the sentence are compared here. If this fails, one side was
changed and the other was not.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from domain.auth.services.password_rules import (  # noqa: E402
    MAX_BYTES,
    MIN_LENGTH,
    describe_rules,
    validate_password,
    PasswordRejected,
)

_UI_RULES = (
    Path(__file__).resolve().parents[3]
    / "webapp" / "ui" / "src" / "app" / "shared" / "password-rules.ts"
)


@pytest.fixture(scope="module")
def browser_copy() -> str:
    if not _UI_RULES.exists():
        pytest.skip(f"the browser copy is not here: {_UI_RULES}")
    return _UI_RULES.read_text(encoding="utf-8")


def _number(source: str, name: str) -> int:
    match = re.search(rf"export const {name} = (\d+);", source)
    assert match, f"{name} is not exported from {_UI_RULES.name}"
    return int(match.group(1))


class TestTheTwoCopiesAgree:
    def test_the_minimum_length(self, browser_copy):
        assert _number(browser_copy, "PASSWORD_MIN_LENGTH") == MIN_LENGTH

    def test_the_maximum_bytes(self, browser_copy):
        assert _number(browser_copy, "PASSWORD_MAX_BYTES") == MAX_BYTES

    def test_the_sentence_under_the_field(self, browser_copy):
        # The browser builds it from the same number, so compare the shape.
        match = re.search(r"PASSWORD_RULES_TEXT = `([^`]+)`", browser_copy)
        assert match, "PASSWORD_RULES_TEXT is not exported"
        rendered = match.group(1).replace("${PASSWORD_MIN_LENGTH}", str(MIN_LENGTH))
        assert rendered == describe_rules()


class TestTheBrowserDoesNotAskForMoreThanTheServer:
    """A rule only the browser has is a rule nobody can see the reason for."""

    def test_no_uppercase_requirement_is_left(self, browser_copy):
        assert "A-Z" not in browser_copy
        validate_password("all lower case 1")

    def test_no_symbol_requirement_is_left(self, browser_copy):
        assert "special" not in browser_copy.lower()
        validate_password("justletters1")

    def test_the_digit_is_asked_for_on_both_sides(self, browser_copy):
        assert r"/\d/" in browser_copy
        with pytest.raises(PasswordRejected):
            validate_password("no digits here")
