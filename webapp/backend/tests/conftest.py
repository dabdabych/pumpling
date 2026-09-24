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
