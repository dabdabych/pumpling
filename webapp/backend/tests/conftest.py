"""Environment every test module can count on.

Two settings have no default in the application, deliberately: the database URL
and the token signing key. Production must fail loudly without them. A test run
is not production, so they are filled in here, once, before any test module is
imported.

`setdefault` rather than assignment: a run against a real database or with a
specific key set in the environment keeps what it was given.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")
# Not a secret, and not shaped like one on purpose: if this string ever appears
# in a running service, the environment was not configured and the test value
# leaked into it.
os.environ.setdefault("JWT_SECRET_KEY", "test-only-key-not-for-any-deployment-000")


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def no_outside_calls(monkeypatch):
    """No test reaches the internet by accident.

    Every outside call in the backend goes through `shared.fast_http.urlopen`
    (`tests/test_fast_http.py` holds it to that). A test that means to answer
    one patches it; any other call fails here instead of going out. Added when
    a new source (the chain) joined the coin lookups and the tests that stubbed
    only the old sources would have read mainnet quietly.
    """
    from shared import fast_http

    tried: list[str] = []

    def refuse(url, *args, **kwargs):
        target = str(getattr(url, "full_url", url))
        tried.append(target)
        raise AssertionError(f"a test tried to reach {target!r}: patch the source it calls")

    monkeypatch.setattr(fast_http, "urlopen", refuse)
    yield
    # Checked after the test too: sources catch their errors, so a refusal
    # raised inside one would otherwise pass unnoticed.
    assert tried == [], f"tried to reach the network: {tried}"
