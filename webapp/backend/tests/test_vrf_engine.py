"""
How many coins get bought — `VrfEngine.compute_k`.

This function splits the pool: with k winners, budget/k goes to each coin. An
error here changes both the size of the purchase per coin and the number of
winners, so the numbers are pinned by tests rather than only by a comment in the
source.

It also checks consistency with `vrf_algorithm_hash`: the sha256 of
`vrf_engine.py` is a public commitment passed to `initialize`.
"""
import hashlib
import re
from pathlib import Path

import pytest

from application.lottery.vrf_engine import (
    K_MAX,
    K_SQRT_DENOMINATOR,
    K_SQRT_NUMERATOR,
    LAMPORTS_PER_SOL,
    VrfEngine,
)

REPO = Path(__file__).resolve().parents[3]
VRF_ENGINE = REPO / "webapp/backend/application/lottery/vrf_engine.py"


def k_for(pool_sol: float, n_mints: int = 5) -> int:
    """k for a pool made of n_mints equal commits."""
    per = int(pool_sol * LAMPORTS_PER_SOL) // n_mints
    weights = {f"mint{i}": per for i in range(n_mints)}
    return VrfEngine.compute_k(weights)


class TestRenormalizationTo111:
    """A pool cap of 111 SOL. The old 80 and 5.4 were normalised for 222 SOL."""

    def test_cap_is_reached_at_109_2_sol(self):
        # The point the renormalisation was for: k reaches its maximum a little
        # before the pool cap rather than exactly at the boundary.
        assert k_for(109.2) == 70

    def test_full_pool_gives_70_winners(self):
        assert k_for(111) == 70

    def test_old_constants_would_give_fewer(self):
        # A regression. At K_MAX=80 and C=5.4 a full pool gave 56 winners, so the
        # purchase per coin would have been 1.25 times larger than intended.
        assert k_for(111) != 56
        assert K_MAX == 70
        assert (K_SQRT_NUMERATOR, K_SQRT_DENOMINATOR) == (67, 10)

    @pytest.mark.parametrize(
        "pool_sol,expected",
        [(10, 21), (30, 36), (50, 47), (80, 59), (111, 70)],
    )
    def test_growth_curve(self, pool_sol, expected):
        assert k_for(pool_sol) == expected


class TestBoundaries:
    def test_empty_pool_gives_zero(self):
        assert VrfEngine.compute_k({}) == 0
        assert VrfEngine.compute_k({"a": 0}) == 0

    def test_never_below_the_number_of_coins(self):
        # With a tiny pool k still never drops below the number of coins with
        # commits: otherwise some coins would get no purchase at all.
        assert k_for(0.5, n_mints=12) == 12

    def test_never_above_the_cap(self):
        # A pool twice the limit does not push k above K_MAX.
        assert k_for(222) == K_MAX

    def test_zero_commits_do_not_count_as_coins(self):
        # We take a pool where the number of coins decides rather than its size:
        # with a large pool the difference would drown in the sqrt term.
        tiny = LAMPORTS_PER_SOL // 1000
        with_bets = {f"mint{i}": tiny for i in range(12)}
        assert VrfEngine.compute_k(with_bets) == 12

        half_empty = {f"mint{i}": (tiny if i < 2 else 0) for i in range(12)}
        assert VrfEngine.compute_k(half_empty) == 2


class TestCommitment:
    def test_algorithm_hash_matches_the_configs(self):
        """
        `vrf_algorithm_hash` declares on chain which algorithm a round is
        computed with. The scheme is the sha256 of the whole file (checked
        against the historical value from 25d9393). Editing the file, comments
        included, has to come with updating the value everywhere, or the
        commitment becomes false.
        """
        expected = hashlib.sha256(VRF_ENGINE.read_bytes()).hexdigest()
        targets = [
            REPO / "docker-compose.yml",
            REPO / "run_dev.sh",
            REPO / "webapp/backend/shared/settings.py",
            REPO / "webapp/ui/src/environments/environment.ts",
            REPO / "webapp/ui/src/environments/environment.prod.ts",
        ]
        for path in targets:
            assert path.exists(), f"a declaration site disappeared: {path}"
            found = {m.group(0)[2:].lower() for m in re.finditer(r"0x[0-9a-fA-F]{64}", path.read_text())}
            assert found, f"{path.name} has no hash value"
            assert expected in found, (
                f"{path.name} declares the wrong algorithm: it has {found}, "
                f"while the sha256 of the engine is {expected}. "
                f"Fix it: python3 scripts/vrf_algorithm_hash.py --write"
            )
