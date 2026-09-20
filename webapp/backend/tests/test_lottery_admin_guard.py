"""Who can drive a round.

The endpoints that move a round sign transactions with the admin key and tell
the buyer to spend the keeper wallet. They used to sit behind "anyone signed
in", which meant an outsider could register by email and start the buying.

The test checks the list: every control endpoint requires an admin, while a
participant can still do exactly two things — commit SOL and check a coin. The
list is explicit, so a new control endpoint without an admin fails the run
rather than reaching production.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from presentation.lottery.lottery_router import router  # noqa: E402

#: Driving a round: create, close, run the draw, start the buying.
ADMIN_ROUTES = {
    ("POST", "/lottery/create"),
    ("GET", "/lottery/all"),
    ("GET", "/lottery/{lottery_id}"),
    ("POST", "/lottery/{lottery_id}/close"),
    ("POST", "/lottery/{lottery_id}/phase2started"),
    ("POST", "/lottery/{lottery_id}/vrf-fulfilled"),
    ("POST", "/lottery/{lottery_id}/offchain-vrf"),
    ("GET", "/lottery/{lottery_id}/phase2-accounts"),
    ("POST", "/lottery/{lottery_id}/proceeding-purchases"),
    ("GET", "/lottery/{lottery_id}/vrf-preview"),
    ("GET", "/lottery/{lottery_id}/run-purchases-payload"),
    ("POST", "/lottery/{lottery_id}/run-purchases"),
    ("GET", "/lottery/{lottery_id}/bets"),
    ("GET", "/lottery/cycles"),
    ("POST", "/lottery/cycles/{lottery_type}/stop"),
    ("POST", "/lottery/cycles/{lottery_type}/resume"),
}

#: What a participant does: commits SOL, checks a coin before committing and
#: looks at their own history. Other people's commits are not visible here.
USER_ROUTES = {
    ("POST", "/lottery/bet"),
    ("POST", "/lottery/check-mint"),
    ("GET", "/lottery/my/commits"),
}


def _dependency_names(route) -> set[str]:
    return {dependency.call.__name__ for dependency in route.dependant.dependencies}


def _routes() -> list[tuple[str, str, set[str]]]:
    found = []
    for route in router.routes:
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            found.append((method, route.path, _dependency_names(route)))
    return found


@pytest.mark.parametrize("method,path", sorted(ADMIN_ROUTES))
def test_round_control_requires_admin(method: str, path: str):
    matches = [deps for m, p, deps in _routes() if (m, p) == (method, path)]
    assert matches, f"the endpoint {method} {path} disappeared — check the list"
    assert "require_admin_user" in matches[0], f"{method} {path} is open to more than admins"


@pytest.mark.parametrize("method,path", sorted(USER_ROUTES))
def test_participant_routes_need_a_signed_in_user(method: str, path: str):
    matches = [deps for m, p, deps in _routes() if (m, p) == (method, path)]
    assert matches, f"the endpoint {method} {path} disappeared — check the list"
    assert "get_current_user" in matches[0], f"{method} {path} is open without signing in"


def test_no_new_route_slips_in_without_a_guard():
    """A new endpoint has to land in one of the lists deliberately."""
    public = {
        ("GET", "/lottery/current"),
        ("GET", "/lottery/archive"),
        ("GET", "/lottery/coin/{coin_name}"),
        ("GET", "/lottery/coin/{mint}/chart"),
        ("GET", "/lottery/{lottery_id}/purchases"),
        # Round verification is deliberately open: it is pointless if it
        # requires an account with the very people being verified. There is no
        # personal data there, only the commitment, the randomness and the result.
        ("GET", "/lottery/{lottery_id}/verification"),
    }
    known = ADMIN_ROUTES | USER_ROUTES | public
    actual = {(method, path) for method, path, _ in _routes()}
    unknown = actual - known
    assert not unknown, f"new endpoints with no access decision: {sorted(unknown)}"
