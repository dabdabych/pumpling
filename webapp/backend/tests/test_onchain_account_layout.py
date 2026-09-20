"""The worker's reading of the `Lottery` account, byte for byte.

The worker parses the account by hand rather than through the IDL, so nothing
tells it when the struct moves underneath. The ORAO migration moved it: the
account went from 358 bytes to 349, and four of the VRF fields changed meaning
at offsets the old ones used to occupy.

An account of the old shape still deserializes under the new offsets. Every
field up to `vrf_request` lands in the right place, and only `vrf_force` and
`vrf_seed_slot` come back as fragments of the fields that used to be there. So
the failure is not a parse error, it is a round that reads fine and carries a
request seed that was never asked for.

The length check is what should catch that, and it is the reason these tests
build whole accounts rather than checking fields: a guard that lets the wrong
size through is invisible from any single field.
"""
from __future__ import annotations

import os
import sys

import pytest
from solders.pubkey import Pubkey

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

import lottery_phase_worker as worker  # noqa: E402

# Lottery::SPACE in the program, field by field.
CURRENT_SIZE = 349
# What the same account measured before the ORAO migration. The nine extra
# bytes are vrf_phase2_slot, vrf_retry_count and the two seed fields, minus the
# two the new layout adds.
PRE_ORAO_SIZE = 358

ADMIN = Pubkey.from_string("4TJdM678kP4hS6KMEoh79T3tANUNctHs7bE62MQSz72F")
WALLET_FEE = Pubkey.from_string("3TZPkct2tXkwCoCe7BdYMyK6ziHD4u2NAMQSAWSyusBJ")
WALLET_KEEPER = Pubkey.from_string("4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH")
REQUEST = Pubkey.from_string("6JViNMPPhucr1AYsqFx6rqGqKFpd6iMxEEHoXPztrugJ")


def build_account(
    *,
    status: int = 1,
    deposits_count: int = 7,
    total_deposited: int = 1_500_000_000,
    vrf_requested_ts: int = 1_789_928_956,
    vrf_seed: bytes = b"",
    vrf_called: bool = False,
    vrf_force: bytes = bytes(range(32)),
    vrf_seed_slot: int = 501_511_399,
    trailing: bytes = b"",
) -> bytes:
    """A `Lottery` account exactly as the program lays it out."""
    parts = [
        bytes(8),                                           # discriminator
        bytes(ADMIN),
        (1_789_900_000).to_bytes(8, "little", signed=True),  # start_ts
        (1_789_930_000).to_bytes(8, "little", signed=True),  # end_ts
        (300).to_bytes(2, "little"),                         # fee_bps
        bytes(WALLET_FEE),
        bytes(WALLET_KEEPER),
        (50_000_000).to_bytes(8, "little"),                  # min_amount
        (5_000_000_000).to_bytes(8, "little"),               # max_amount
        (20_000_000_000).to_bytes(8, "little"),              # max_total
        bytes([status]),
        bytes([0]),                                          # paused
        deposits_count.to_bytes(8, "little"),
        total_deposited.to_bytes(16, "little"),
        bytes([9]) * 32,                                     # weights_hash
        vrf_requested_ts.to_bytes(8, "little", signed=True),
        (vrf_seed or bytes(32)).ljust(32, b"\0"),
        bytes([1 if vrf_called else 0]),
        bytes(REQUEST),
        vrf_force,
        vrf_seed_slot.to_bytes(8, "little"),
        bytes([4]) * 32,                                     # vrf_algorithm_hash
    ]
    return b"".join(parts) + trailing


class TestTheLayoutItExpects:
    def test_the_fixture_is_the_size_the_program_writes(self):
        # If this fails the fixture drifted, and every other test here is
        # measuring the wrong thing.
        assert len(build_account()) == CURRENT_SIZE

    def test_it_reads_a_current_account(self):
        state = worker._parse_onchain_lottery_account(build_account())

        assert state.status == "PendingVrf"
        assert state.fee_bps == 300
        assert state.deposits_count == 7
        assert state.total_deposited_lamports == 1_500_000_000
        assert state.vrf_requested_ts == 1_789_928_956
        assert state.vrf_called is False
        assert state.randomness_account == str(REQUEST)
        assert state.vrf_force == bytes(range(32))
        assert state.vrf_seed_slot == 501_511_399
        assert state.wallet_fee == str(WALLET_FEE)
        assert state.wallet_keeper == str(WALLET_KEEPER)

    def test_an_unset_seed_reads_as_absent_rather_than_zeroes(self):
        assert worker._parse_onchain_lottery_account(build_account()).vrf_seed_hex is None

        drawn = build_account(vrf_seed=bytes([7]) * 32, vrf_called=True)
        state = worker._parse_onchain_lottery_account(drawn)
        assert state.vrf_seed_hex == "07" * 32
        assert state.vrf_called is True


class TestItStaysInStepWithTheProgram:
    """The size is written down in three places and derived in none of them.

    The program has `Lottery::SPACE`, the worker has a constant, and the IDL
    has the field list the program generated. The IDL is the one that updates
    itself, so it is what the other two are measured against here.
    """

    WIDTH = {"pubkey": 32, "i64": 8, "u64": 8, "u128": 16, "u16": 2, "u8": 1, "bool": 1}

    def _field_width(self, kind) -> int:
        if isinstance(kind, str):
            return self.WIDTH[kind]
        if "array" in kind:
            inner, count = kind["array"]
            return self._field_width(inner) * count
        if "defined" in kind:
            # LotteryStatus, a plain C-like enum: one byte for the variant.
            return 1
        raise AssertionError(f"unhandled IDL type {kind}")

    def test_the_constant_matches_the_idl(self):
        import json

        idl_path = os.path.join(_WORKERS, "idl", "lottery.json")
        with open(idl_path) as handle:
            idl = json.load(handle)

        lottery = next(t for t in idl["types"] if t["name"] == "Lottery")
        body = sum(self._field_width(f["type"]) for f in lottery["type"]["fields"])

        assert 8 + body == worker.LOTTERY_ACCOUNT_SIZE
        assert 8 + body == CURRENT_SIZE


class TestAnAccountOfTheWrongShape:
    """The size is the only thing that tells the two layouts apart.

    Both carry the same Anchor discriminator, because it is a hash of the type
    name and the name did not change.
    """

    def test_a_pre_orao_account_is_refused(self):
        # Nine bytes longer and different from `vrf_force` onwards. Reading it
        # under the new offsets yields a force the round never asked for, and
        # the worker would take that to ORAO as a seed mismatch on a request it
        # had built itself.
        old = build_account(trailing=bytes(PRE_ORAO_SIZE - CURRENT_SIZE))
        assert len(old) == PRE_ORAO_SIZE

        with pytest.raises(RuntimeError):
            worker._parse_onchain_lottery_account(old)

    def test_a_truncated_account_is_refused(self):
        with pytest.raises(RuntimeError):
            worker._parse_onchain_lottery_account(build_account()[:-1])

    def test_an_empty_account_is_refused(self):
        with pytest.raises(RuntimeError):
            worker._parse_onchain_lottery_account(b"")
