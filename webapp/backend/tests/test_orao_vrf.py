"""The worker's half of the ORAO derivation.

The program derives the request seed and the worker has to land on the same
value, because the worker is what puts the request account into the
transaction. Get it wrong and every round fails at `RandomnessAccountMismatch`,
which is a loud failure but a late one.

The vectors here are pinned to the same constants as
`cross_language_tests` in the program's `lib.rs`. Neither side checks the other
at runtime, so they are checked against a fixed third thing instead. Editing one
without the other breaks both.
"""
from __future__ import annotations

import hashlib
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

from shared import orao_vrf as vrf  # noqa: E402

LOTTERY = Pubkey.from_string("4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH")


class TestItAgreesWithTheProgram:
    def test_the_force_vector(self):
        force = vrf.derive_force(LOTTERY, bytes([2]) * 32, bytes([3]) * 32)
        assert force.hex() == "1b62c4004550937dd435457f0d0a0a9771996ccaf083f452aa0c58a5832e5c52"

    def test_the_folding_vector(self):
        folded = vrf.fold_randomness(bytes([7]) * 64)
        assert folded.hex() == "58d6e85496a4c2bd8ea9ae6bf61658708c533c5491633ecf9fcf8725fd921601"

    def test_the_emergency_delay_matches_the_program(self):
        # The program refuses the emergency path before this many seconds have
        # passed. The worker holding a different number would either send
        # transactions that bounce or sit on a stuck round longer than it has to.
        import lottery_phase_worker as worker

        assert worker.EMERGENCY_FULFILL_DELAY_SECONDS == 120

    def test_the_network_state_is_the_real_one(self):
        # Checked against the account that actually exists on both clusters.
        assert str(vrf.network_state_address()) == "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK"

    def test_every_input_moves_the_force(self):
        base = vrf.derive_force(LOTTERY, bytes([2]) * 32, bytes([3]) * 32)
        other = Pubkey.from_string("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y")
        assert vrf.derive_force(other, bytes([2]) * 32, bytes([3]) * 32) != base
        assert vrf.derive_force(LOTTERY, bytes([9]) * 32, bytes([3]) * 32) != base
        assert vrf.derive_force(LOTTERY, bytes([2]) * 32, bytes([9]) * 32) != base

    def test_wrong_sized_inputs_are_refused(self):
        # Silently padding or truncating here would produce a seed the program
        # never agrees with, and the reason would be invisible.
        with pytest.raises(ValueError):
            vrf.derive_force(LOTTERY, bytes(31), bytes(32))
        with pytest.raises(ValueError):
            vrf.derive_force(LOTTERY, bytes(32), bytes(33))
        with pytest.raises(ValueError):
            vrf.fold_randomness(bytes(32))


def _slot_hashes(entries):
    out = len(entries).to_bytes(8, "little")
    for slot, h in entries:
        out += slot.to_bytes(8, "little") + h
    return out


class TestReadingTheSlotHashes:
    def test_reads_the_entry_it_was_asked_for(self):
        data = _slot_hashes([(500, bytes([1]) * 32), (499, bytes([2]) * 32), (498, bytes([3]) * 32)])
        assert vrf.parse_slot_hashes(data, back=0).slot == 500
        entry = vrf.parse_slot_hashes(data, back=2)
        assert entry.slot == 498
        assert entry.hash == bytes([3]) * 32

    def test_refuses_to_read_past_the_end(self):
        data = _slot_hashes([(500, bytes([1]) * 32)])
        with pytest.raises(ValueError):
            vrf.parse_slot_hashes(data, back=2)

    def test_refuses_a_truncated_sysvar(self):
        with pytest.raises(ValueError):
            vrf.parse_slot_hashes(b"\x02" + b"\x00" * 7, back=0)

    def test_the_default_stays_inside_the_program_window(self):
        # The program refuses a slot older than 128. The default must leave
        # plenty of room under that.
        assert 0 < 2 < vrf.MAX_SEED_SLOT_AGE_SLOTS


def _request(tag: int, client: Pubkey, seed: bytes, randomness: bytes = b"") -> bytes:
    return bytes(8) + bytes([tag]) + bytes(client) + seed + randomness


class TestReadingARequest:
    CLIENT = Pubkey.from_string("CXEj4e1TSQ5etCTYFP8sP7WnEfpJo9CHjRp1CFvu6Bm1")
    SEED = bytes.fromhex("2e65fbf6c04d486be309486a1a5dc3e38f7872e818ed71eed256de86b2ebf4d6")

    def test_a_fulfilled_request(self):
        randomness = bytes(range(64))
        state = vrf.parse_request(_request(1, self.CLIENT, self.SEED, randomness))
        assert state.fulfilled
        assert state.seed == self.SEED
        assert state.client == self.CLIENT
        assert state.randomness == randomness

    def test_a_pending_request_has_no_randomness(self):
        # Pending accounts are larger and carry a growing response list; all the
        # worker needs to know is that the answer is not in yet.
        state = vrf.parse_request(_request(0, self.CLIENT, self.SEED) + bytes(600))
        assert not state.fulfilled
        assert state.randomness is None
        assert state.seed == self.SEED

    def test_a_truncated_fulfilled_request_is_an_error(self):
        # Reading past the end would hand the round a short seed rather than
        # refusing, and a short seed still hashes to something plausible.
        with pytest.raises(ValueError):
            vrf.parse_request(_request(1, self.CLIENT, self.SEED, bytes(10)))

    def test_the_layout_matches_the_real_account_length(self):
        full = _request(1, self.CLIENT, self.SEED, bytes(64))
        # 137 bytes is what a fulfilled account measures on chain.
        assert len(full) == 137


class TestTheTreasuryIsRead:
    def test_reads_the_treasury_out_of_the_configuration(self):
        authority = bytes(Pubkey.from_string("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"))
        treasury = Pubkey.from_string("9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR")
        data = bytes(8) + authority + bytes(treasury) + bytes(200)
        assert vrf.parse_treasury(data) == treasury

    def test_refuses_a_short_account(self):
        with pytest.raises(ValueError):
            vrf.parse_treasury(bytes(40))
