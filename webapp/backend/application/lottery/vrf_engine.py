import hashlib
import bisect
from math import isqrt
from typing import Dict, List, Tuple

Mint = str
LAMPORTS_PER_SOL = 1_000_000_000
# The number of draws: k = min(K_MAX, max(n_mints, floor(6.7 * sqrt(pool in SOL)))).
#
# The constants were renormalised for the 111 SOL pool cap: the old coefficient
# of 5.4 with K_MAX = 80 was chosen so the cap was reached at exactly 222 SOL.
# Now k = 70 is reached at 109.2 SOL, a little before the maximum pool, which is
# what we want.
#
# k does not control how wide the distribution is, it controls how random it is.
# On average every coin gets the share of the buying that matches the share of
# the SOL behind it, and k sets how far the outcome strays from that share. With
# 15 coins in a round, k = 56 gives a deviation of ~18.5% and k = 70 gives
# ~16.4%. More draws mean a more predictable result.
K_MAX = 70
K_SQRT_NUMERATOR = 67
K_SQRT_DENOMINATOR = 10


class VrfEngine:
    @staticmethod
    def compute_k(weights: Dict[Mint, int]) -> int:
        n_mints = sum(1 for w in weights.values() if w > 0)
        if n_mints == 0:
            return 0

        pool_lamports = sum(weights.values())
        scaled_pool = (
            pool_lamports * K_SQRT_NUMERATOR * K_SQRT_NUMERATOR
        ) // (
            K_SQRT_DENOMINATOR * K_SQRT_DENOMINATOR * LAMPORTS_PER_SOL
        )
        k_from_pool = isqrt(scaled_pool)
        return min(K_MAX, max(n_mints, k_from_pool))

    @staticmethod
    def keccak_u64(seed_bytes: bytes) -> int:
        h = hashlib.sha3_256(seed_bytes).digest()
        return int.from_bytes(h[-8:], "big", signed=False)

    @classmethod
    def weighted_sampler_u(cls, seed_bytes: bytes, total_weight: int) -> Tuple[int, bytes]:
        assert total_weight > 0
        x = cls.keccak_u64(seed_bytes)
        M = (1 << 64) // total_weight * total_weight
        salt = 0
        while x >= M:
            salt += 1
            x = cls.keccak_u64(seed_bytes + salt.to_bytes(4, "big"))
        u = x % total_weight
        next_seed = hashlib.sha3_256(seed_bytes + b"|next").digest()
        return u, next_seed

    @staticmethod
    def build_prefix(weights: Dict[Mint, int]) -> Tuple[List[Mint], List[int], int]:
        items = [(m, w) for m, w in weights.items() if w > 0]
        items.sort(key=lambda x: x[0])
        mints: List[Mint] = []
        prefix: List[int] = []
        acc = 0
        for m, w in items:
            acc += w
            mints.append(m)
            prefix.append(acc)
        return mints, prefix, acc

    @staticmethod
    def pick_mint(u: int, prefix: List[int], mints: List[Mint]) -> Mint:
        j = bisect.bisect_left(prefix, u + 1)
        return mints[j]

    @classmethod
    def draw_mint_wins(cls, vrf_seed: bytes, weights: Dict[Mint, int], k: int) -> Dict[Mint, int]:
        mints, prefix, total = cls.build_prefix(weights)
        assert total > 0, "Total weight must be > 0"
        wins: Dict[Mint, int] = {m: 0 for m in mints}
        seed = vrf_seed
        for _ in range(k):
            u, seed = cls.weighted_sampler_u(seed, total)
            mint = cls.pick_mint(u, prefix, mints)
            wins[mint] += 1
        return wins

    @staticmethod
    def compute_targets(wins: Dict[Mint, int], budget_lamports: int, k: int) -> Dict[Mint, int]:
        assert k > 0
        per_winner = budget_lamports // k
        return {m: per_winner * w for m, w in wins.items()}

    @classmethod
    def run_with_seed(cls, weights: Dict[Mint, int], vrf_seed: bytes, fee_bps: int = 300) -> Dict[str, object]:
        if len(vrf_seed) != 32:
            raise ValueError("vrf_seed must be exactly 32 bytes")

        pool = sum(weights.values())
        if pool <= 0:
            return {
                "weights": weights,
                "seed_hex": vrf_seed.hex(),
                "k": 0,
                "wins": {},
                "fee_bps": fee_bps,
                "pool": 0,
                "budget_lamports": 0,
                "targets": {},
            }

        k = cls.compute_k(weights)
        wins = cls.draw_mint_wins(vrf_seed, weights, k)

        budget = pool - (pool * fee_bps // 10_000)
        targets = cls.compute_targets(wins, budget, k)

        return {
            "weights": weights,
            "seed_hex": vrf_seed.hex(),
            "k": k,
            "wins": wins,
            "fee_bps": fee_bps,
            "pool": pool,
            "budget_lamports": budget,
            "targets": targets,
        }

    @classmethod
    def run(cls, weights: Dict[Mint, int], fee_bps: int = 300, seed_phrase: bytes = b"Hash_random_qwerty") -> Dict[str, object]:
        return cls.run_with_seed(
            weights,
            hashlib.sha3_256(seed_phrase).digest(),
            fee_bps=fee_bps,
        )

    @classmethod
    def run_default(cls) -> Dict[str, object]:
        weights = {
            "MINT_A": 3_000_000_000,
            "MINT_B": 6_000_000_000,
            "MINT_C": 10_000_000_000,
            "MINT_D": 1_000_000_000,
        }
        return cls.run(weights)
