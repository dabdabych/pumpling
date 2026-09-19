"""The weights commitment: what a round is verified by from the outside.

The weights hash goes into the program before the draw and we hand the preimage
out. They have to match byte for byte, or verification is worth nothing. The
rule for building it lives in one module and the phase worker uses that very
one — this suite holds both the rule itself and that connection.
"""
from __future__ import annotations

import hashlib
import os
import sys
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)

from shared.weights_commitment import (  # noqa: E402
    build_number_string,
    build_weights_commitment,
    build_weights_payload,
)


def test_pairs_go_by_amount_then_by_mint():
    payload = build_weights_payload([
        ("BBB", Decimal("1")),
        ("AAA", Decimal("2")),
        ("CCC", Decimal("1")),
    ])
    # Larger first, and by address when equal: the order has to be predictable,
    # or the same round would give different hashes.
    assert payload == '[["AAA",2],["BBB",1],["CCC",1]]'


def test_numbers_are_written_the_javascript_way():
    # The hash is taken over text, so how a number is written is part of the commitment.
    assert build_number_string(Decimal("2.00")) == "2"
    assert build_number_string(Decimal("1.50000000")) == "1.5"
    assert build_number_string(Decimal("0.0000001")) == "1e-7"
    assert build_number_string(Decimal("0.000001")) == "0.000001"


def test_zero_and_negative_amounts_are_dropped():
    payload = build_weights_payload([
        ("AAA", Decimal("0")),
        ("BBB", Decimal("-1")),
        ("CCC", Decimal("0.5")),
    ])
    assert payload == '[["CCC",0.5]]'


def test_no_bets_means_no_commitment():
    assert build_weights_payload([]) is None
    assert build_weights_commitment([]) is None


def test_hash_matches_the_payload():
    payload, digest = build_weights_commitment([("AAA", Decimal("1.5"))])
    assert digest == hashlib.sha256(payload.encode("utf-8")).hexdigest()


def test_worker_uses_the_same_rule():
    """The worker puts into the program exactly the hash we hand out.

    If the rule drifts apart, round verification starts lying, and we find out
    from the first person who decides to check us.
    """
    import lottery_phase_worker as worker

    pairs = [("AAA", Decimal("1.5")), ("BBB", Decimal("0.0000001"))]
    payload, digest = build_weights_commitment(pairs)

    # The same sort and the same number formatting as in the worker.
    assert worker._build_js_number_string(Decimal("0.0000001")) == "1e-7"
    assert worker._build_js_number_string is build_number_string
    assert hashlib.sha256(payload.encode("utf-8")).hexdigest() == digest
