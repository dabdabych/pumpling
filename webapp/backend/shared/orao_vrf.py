"""Everything the workers need to know about ORAO's randomness.

The program derives the request seed itself and the worker has to arrive at the
same answer, because it is the worker that must put the right request account
into the transaction. So the derivation lives here, written once, next to the
account parsing it belongs with, and it is checked against the on-chain program
by the tests rather than by hope.

Nothing in this module talks to the network. Everything takes bytes and returns
values, which is what makes it testable without a validator.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Optional

from solders.pubkey import Pubkey

# ORAO VRF, the same address on devnet and mainnet.
ORAO_PROGRAM_ID = Pubkey.from_string("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y")

RANDOMNESS_ACCOUNT_SEED = b"orao-vrf-randomness-request"
CONFIG_ACCOUNT_SEED = b"orao-vrf-network-configuration"

# Must match the constants in the program. A change on one side without the
# other means the worker offers a request account the program will not accept.
FORCE_DOMAIN = b"pumpling-vrf-force-v1"
SEED_DOMAIN = b"pumpling-vrf-seed-v1"
MAX_SEED_SLOT_AGE_SLOTS = 128

SLOT_HASHES_SYSVAR = Pubkey.from_string("SysvarS1otHashes111111111111111111111111111")

# SlotHashes: an 8-byte count, then pairs of an 8-byte slot and a 32-byte hash,
# newest first.
_SLOT_HASH_ENTRY = 40

# A fulfilled ORAO request: 8 discriminator, 1 enum tag, 32 client, 32 seed,
# 64 randomness. Tag 1 is the fulfilled variant, tag 0 is still pending.
_REQUEST_FULFILLED_TAG = 1
_REQUEST_FULFILLED_LEN = 137


def derive_force(lottery: Pubkey, weights_hash: bytes, slot_hash: bytes) -> bytes:
    """The request seed for a round, exactly as the program derives it."""
    if len(weights_hash) != 32:
        raise ValueError("weights_hash must be 32 bytes")
    if len(slot_hash) != 32:
        raise ValueError("slot_hash must be 32 bytes")
    digest = hashlib.sha256()
    digest.update(FORCE_DOMAIN)
    digest.update(bytes(lottery))
    digest.update(weights_hash)
    digest.update(slot_hash)
    return digest.digest()


def request_address(force: bytes) -> Pubkey:
    """Where ORAO keeps the answer to a request with this seed."""
    if len(force) != 32:
        raise ValueError("force must be 32 bytes")
    return Pubkey.find_program_address([RANDOMNESS_ACCOUNT_SEED, force], ORAO_PROGRAM_ID)[0]


def network_state_address() -> Pubkey:
    return Pubkey.find_program_address([CONFIG_ACCOUNT_SEED], ORAO_PROGRAM_ID)[0]


def fold_randomness(randomness: bytes) -> bytes:
    """ORAO's 64 bytes folded into the 32 a round stores, as the program does."""
    if len(randomness) != 64:
        raise ValueError("randomness must be 64 bytes")
    return hashlib.sha256(SEED_DOMAIN + randomness).digest()


@dataclass(frozen=True)
class SlotHashEntry:
    slot: int
    hash: bytes


def parse_slot_hashes(data: bytes, back: int = 2) -> SlotHashEntry:
    """One entry of the SlotHashes sysvar, counted from the newest.

    A couple of entries back rather than the newest one: the program will not
    take a slot newer than the one it executes in, and by the time a transaction
    lands the newest entry has usually moved on.
    """
    if len(data) < 8:
        raise ValueError("slot hashes sysvar is too short")
    count = int.from_bytes(data[0:8], "little")
    if count <= back:
        raise ValueError(f"slot hashes sysvar holds {count} entries, wanted index {back}")
    offset = 8 + back * _SLOT_HASH_ENTRY
    if len(data) < offset + _SLOT_HASH_ENTRY:
        raise ValueError("slot hashes sysvar is truncated")
    return SlotHashEntry(
        slot=int.from_bytes(data[offset:offset + 8], "little"),
        hash=bytes(data[offset + 8:offset + _SLOT_HASH_ENTRY]),
    )


@dataclass(frozen=True)
class RequestState:
    seed: bytes
    client: Optional[Pubkey]
    randomness: Optional[bytes]

    @property
    def fulfilled(self) -> bool:
        return self.randomness is not None


def parse_request(data: bytes) -> RequestState:
    """Reads an ORAO request account.

    Only the fulfilled shape is read in full. While a request is pending the
    account carries a growing list of responses that nothing here needs, so it
    is enough to know that the answer is not in yet.
    """
    if len(data) < 9:
        raise ValueError("request account is too short")
    tag = data[8]
    seed_start = 9 + 32
    if len(data) < seed_start + 32:
        raise ValueError("request account is truncated")
    seed = bytes(data[seed_start:seed_start + 32])
    client = Pubkey.from_bytes(bytes(data[9:9 + 32]))
    if tag != _REQUEST_FULFILLED_TAG:
        return RequestState(seed=seed, client=client, randomness=None)
    if len(data) < _REQUEST_FULFILLED_LEN:
        raise ValueError("fulfilled request account is truncated")
    return RequestState(
        seed=seed,
        client=client,
        randomness=bytes(data[73:_REQUEST_FULFILLED_LEN]),
    )


def parse_treasury(network_state_data: bytes) -> Pubkey:
    """The treasury ORAO wants paid, read out of its network configuration.

    Read rather than hardcoded: ORAO can move it with `update_network`, and a
    stale constant here would fail every request until somebody noticed.
    """
    # 8 discriminator, then NetworkConfiguration: authority, treasury.
    if len(network_state_data) < 72:
        raise ValueError("network state account is too short")
    return Pubkey.from_bytes(bytes(network_state_data[40:72]))
