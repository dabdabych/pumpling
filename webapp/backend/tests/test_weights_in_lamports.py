"""The commitment pins the numbers the draw actually weighs by.

Before 2026-09-24 the preimage carried SOL rounded to eight decimals while the
draw weighed by raw lamports. Eight decimals of SOL is ten lamports, so the two
could disagree — and not only in theory: a commit is checked against the chain
in lamports, so anyone could deposit 50_000_001 and make the published figure
differ from the one used.

It never changed an outcome anybody could notice. A few lamports move the
sampler's boundaries by a few parts in ten billion. But the product's claim is
that the published numbers are the numbers, so it is fixed rather than
explained.

The half of this that matters most is backwards: every round pinned under the
old rule has to keep verifying. The verification page rebuilds the preimage from
the database, so a rule change with no memory would tell every past round that
our own check had failed.
"""
from __future__ import annotations

import os
import sys
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.weights_commitment import (  # noqa: E402
    build_lamports_commitment,
    build_lamports_payload,
    build_weights_commitment,
    sol_to_lamports,
    weights_hash_hex,
)

A = "8ndxUgYbArkgcvK36wJmui535tN6aYqvunen74KZpump"
B = "1gWWhs7qrd9sBHwppQdMU2h2fTnnyoCYCSuVjFBpump"
C = "5pSEZw1iytqYznD7crsGyKNek7q5JkjBqj2KmfqxUVZd"


def draw_lamports(value) -> int:
    """The conversion the draw has always used, kept here as the reference."""
    return int(round(float(value) * 1_000_000_000))


class TestTheConversionMatchesTheDraw:
    """`sol_to_lamports` must agree with what the draw weighs by, always."""

    @pytest.mark.parametrize("sol", [
        0.05, 0.1, 1.5, 10.0, 35.0, 111.0,
        0.15000000000000002,   # 0.05 + 0.1 as a double
        0.30000000000000004,   # 0.1 + 0.2
        0.050000001,           # a commit deliberately off the ten-lamport grid
        0.123456789,
        34.99999999,
    ])
    def test_they_agree(self, sol):
        assert sol_to_lamports(sol) == draw_lamports(sol)

    def test_they_agree_across_the_whole_range(self):
        import random

        random.seed(11)
        for _ in range(2000):
            sol = random.randint(50_000_000, 111_000_000_000) / 1e9
            assert sol_to_lamports(sol) == draw_lamports(sol)

    def test_nothing_is_none(self):
        assert sol_to_lamports(None) == 0


class TestWhatTheOldRuleLostAndTheNewOneKeeps:
    def test_a_commit_off_the_ten_lamport_grid_used_to_be_rounded_away(self):
        # 50_000_001 lamports. The old rule pinned 0.05 SOL, which is 50_000_000.
        sol = 0.050000001
        old_payload, _ = build_weights_commitment([(A, Decimal(str(sol)))])
        new_payload, _ = build_lamports_commitment([(A, sol_to_lamports(sol))])

        assert "0.05" in old_payload and "50000001" not in old_payload
        assert "50000001" in new_payload

    def test_the_new_payload_is_what_the_draw_weighs_by(self):
        sol = 0.050000001
        payload, _ = build_lamports_commitment([(A, sol_to_lamports(sol))])

        assert str(draw_lamports(sol)) in payload


class TestTheNewRule:
    def test_it_is_whole_lamports_with_no_decimal_point(self):
        payload = build_lamports_payload([(A, 100_000_000)])
        assert payload == f'[["{A}",100000000]]'

    def test_the_order_is_by_amount_then_by_address(self):
        payload = build_lamports_payload([(C, 50_000_000), (A, 100_000_000), (B, 50_000_000)])
        # 100000000 first, then the two equal ones by address.
        assert payload.index("100000000") < payload.index(B)
        assert payload.index(B) < payload.index(C)

    def test_zero_and_negative_are_dropped(self):
        payload = build_lamports_payload([(A, 100_000_000), (B, 0), (C, -5)])
        assert B not in payload and C not in payload

    def test_nothing_to_pin_is_none(self):
        assert build_lamports_payload([]) is None
        assert build_lamports_payload([(A, 0)]) is None

    def test_the_hash_is_of_that_exact_string(self):
        payload, digest = build_lamports_commitment([(A, 100_000_000)])
        assert digest == weights_hash_hex(payload)


class TestTheOldRuleIsUntouched:
    """Every round pinned under it has to keep verifying, so it cannot move."""

    def test_a_known_payload_is_byte_for_byte_what_it_was(self):
        payload, _ = build_weights_commitment([
            (A, Decimal("0.05")),
            (B, Decimal("0.1")),
        ])
        assert payload == f'[["{B}",0.1],["{A}",0.05]]'

    def test_the_real_mainnet_round_still_rebuilds(self):
        """Round 1790275692313, 2026-09-24: the last one pinned under rule 1.

        Its commits were 0.1 behind one coin and 0.05 behind each of two others.
        This is the exact preimage its on-chain hash was taken over.
        """
        payload, digest = build_weights_commitment([
            (B, Decimal("0.1")),
            (C, Decimal("0.05")),
            (A, Decimal("0.05")),
        ])

        # Equal amounts sort by address, and 5pSE… comes before 8ndx….
        assert payload == f'[["{B}",0.1],["{C}",0.05],["{A}",0.05]]'
        assert digest == weights_hash_hex(payload)

    def test_the_two_rules_give_different_hashes(self):
        # Which is the point: a round has to be checked against its own rule.
        old = build_weights_commitment([(A, Decimal("0.05"))])[1]
        new = build_lamports_commitment([(A, 50_000_000)])[1]
        assert old != new


class TestAPastRoundStillVerifies:
    """The half that matters: a rule change with no memory would tell every
    round pinned before it that our own check had failed.

    Round 1790275692313 on mainnet, 2026-09-24. Its on-chain weights_hash is
    c17fffe4d5c2f391781eb6cb2eceb34ea4426a968e30c0d0542e0ef893f217dc, read from
    the Phase2Started event. Rule 1 reproduces it; rule 2, correctly, does not.
    """

    ONCHAIN = "c17fffe4d5c2f391781eb6cb2eceb34ea4426a968e30c0d0542e0ef893f217dc"
    ROWS = [(B, 0.1), (C, 0.05), (A, 0.05)]

    def test_rule_one_reproduces_what_is_on_chain(self):
        _payload, digest = build_weights_commitment(
            [(m, Decimal(str(t))) for m, t in self.ROWS]
        )
        assert digest == self.ONCHAIN

    def test_rule_two_does_not_and_should_not(self):
        _payload, digest = build_lamports_commitment(
            [(m, sol_to_lamports(t)) for m, t in self.ROWS]
        )
        assert digest != self.ONCHAIN

    def test_the_page_publishes_the_preimage_that_matches(self):
        """The choice the verification endpoint makes, as it makes it."""
        lamports = build_lamports_commitment(
            [(m, sol_to_lamports(t)) for m, t in self.ROWS]
        )
        legacy = build_weights_commitment(
            [(m, Decimal(str(t))) for m, t in self.ROWS]
        )
        payload, recomputed = lamports

        if (
            self.ONCHAIN
            and legacy
            and recomputed != self.ONCHAIN
            and legacy[1] == self.ONCHAIN
        ):
            payload, recomputed = legacy

        assert recomputed == self.ONCHAIN
        assert payload == legacy[0]
        # And anyone hashing the published preimage gets the on-chain figure.
        assert weights_hash_hex(payload) == self.ONCHAIN

    def test_a_new_round_publishes_the_lamports_preimage(self):
        # Pinned under rule 2, so rule 2 matches first and nothing falls back.
        lamports = build_lamports_commitment(
            [(m, sol_to_lamports(t)) for m, t in self.ROWS]
        )
        onchain = lamports[1]
        legacy = build_weights_commitment(
            [(m, Decimal(str(t))) for m, t in self.ROWS]
        )
        payload, recomputed = lamports

        if onchain and legacy and recomputed != onchain and legacy[1] == onchain:
            payload, recomputed = legacy

        assert recomputed == onchain
        assert payload == lamports[0]
        assert "50000000" in payload
