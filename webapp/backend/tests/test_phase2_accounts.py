"""What the admin area is handed when it asks to close a round by hand.

The endpoint exists so the request seed is derived in one language rather than
three. That only helps if what it returns is right, and "right" here has a
sharp edge: the request account it names has to be the PDA of the seed the
program will derive from the same three values, or the program refuses and the
button does nothing but burn a signature.

So this runs the handler and rebuilds the derivation independently from the
values it returned.
"""
from __future__ import annotations

import hashlib
import os
import sys
from decimal import Decimal

import pytest
from solders.pubkey import Pubkey

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from presentation.lottery import lottery_router as router  # noqa: E402
from shared import orao_vrf  # noqa: E402

LOTTERY_ID = 1789840890636
TREASURY = Pubkey.from_string("9ZTHWWZDpB36UFe1vszf2KEpt83vwi27jDqtHQ7NSXyR")
SEED_SLOT = 501_319_379
LOTTERY_PDA = Pubkey.from_string("4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH")


class FakeLottery:
    id = LOTTERY_ID


class FakeQuery:
    def __init__(self, rows, lottery):
        self._rows, self._lottery = rows, lottery

    def filter(self, *_):
        return self

    def group_by(self, *_):
        return self

    def first(self):
        return self._lottery

    def all(self):
        return self._rows


class FakeSession:
    def __init__(self, rows, lottery=FakeLottery()):
        self._rows, self._lottery = rows, lottery

    def query(self, *args):
        if len(args) == 1 and getattr(args[0], "__name__", "") == "LotteryModel":
            return FakeQuery([], self._lottery)
        return FakeQuery(self._rows, self._lottery)


class FakeValue:
    def __init__(self, data):
        self.data = data


class FakeResponse:
    def __init__(self, data):
        self.value = FakeValue(data)


@pytest.fixture
def chain(monkeypatch):
    """A chain that answers with a known slot hash and a known treasury."""
    # Three entries so `back=2` has somewhere to land.
    sysvar = (3).to_bytes(8, "little")
    for offset in range(3):
        sysvar += (SEED_SLOT + 2 - offset).to_bytes(8, "little") + bytes([offset]) * 32
    network = bytes(8) + bytes(Pubkey.default()) + bytes(TREASURY) + bytes(200)

    class FakeClient:
        def __init__(self, *_, **__):
            pass

        def get_account_info(self, pubkey):
            if pubkey == orao_vrf.SLOT_HASHES_SYSVAR:
                return FakeResponse(sysvar)
            return FakeResponse(network)

    monkeypatch.setattr(router, "Client", FakeClient)
    # The round's address comes from settings this test does not configure.
    # Deriving it is checked elsewhere; here it only has to be a fixed value.
    monkeypatch.setattr(
        router, "_derive_lottery_account_summary",
        lambda *_a, **_k: (str(LOTTERY_PDA), "vault", "admin"),
    )
    # The slot hash the handler will actually pick, two entries back.
    return SEED_SLOT, bytes([2]) * 32


class TestItNamesTheRightAccounts:
    def test_the_request_account_is_the_pda_of_the_derived_seed(self, chain):
        expected_slot, expected_hash = chain
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5"))]

        answer = router.phase2_accounts(LOTTERY_ID, db=FakeSession(rows), current_user_id=1)

        assert answer.seed_slot == expected_slot
        # Rebuilt here from the returned values rather than trusted: the whole
        # point of the endpoint is that this address is not a matter of opinion.
        force = hashlib.sha256(
            orao_vrf.FORCE_DOMAIN
            + bytes(Pubkey.from_string(answer.lottery_pda))
            + bytes.fromhex(answer.weights_hash)
            + expected_hash
        ).digest()
        assert answer.vrf_request == str(orao_vrf.request_address(force))

    def test_the_fixed_accounts_are_the_real_ones(self, chain):
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5"))]
        answer = router.phase2_accounts(LOTTERY_ID, db=FakeSession(rows), current_user_id=1)

        assert answer.vrf_program == "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"
        assert answer.vrf_network_state == "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK"
        assert answer.recent_slothashes == "SysvarS1otHashes111111111111111111111111111"
        # Read off the chain rather than pinned, because ORAO can move it.
        assert answer.vrf_treasury == str(TREASURY)

    def test_the_commitment_is_the_one_the_round_will_be_drawn_from(self, chain):
        rows = [
            ("So11111111111111111111111111111111111111112", Decimal("1.5")),
            ("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", Decimal("0.5")),
        ]
        answer = router.phase2_accounts(LOTTERY_ID, db=FakeSession(rows), current_user_id=1)

        from shared.weights_commitment import build_weights_commitment

        expected = build_weights_commitment([(m, Decimal(str(v))) for m, v in rows])
        assert answer.weights_hash == expected[1]

    def test_a_round_with_no_commits_is_refused(self, chain):
        # Drawing an empty round would pin a commitment over nothing and spend
        # the ORAO fee for a result nobody can use.
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as caught:
            router.phase2_accounts(LOTTERY_ID, db=FakeSession([]), current_user_id=1)
        assert caught.value.status_code == 409

    def test_a_round_that_does_not_exist_is_a_404(self, chain):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as caught:
            router.phase2_accounts(LOTTERY_ID, db=FakeSession([], lottery=None), current_user_id=1)
        assert caught.value.status_code == 404

    def test_an_unreadable_chain_is_a_503_not_a_wrong_answer(self, chain, monkeypatch):
        # Guessing a slot hash would produce an address the program refuses,
        # and the admin would see a signature failure instead of the reason.
        from fastapi import HTTPException

        class DeadClient:
            def __init__(self, *_, **__):
                raise OSError("no network")

        monkeypatch.setattr(router, "Client", DeadClient)
        rows = [("So11111111111111111111111111111111111111112", Decimal("1.5"))]
        with pytest.raises(HTTPException) as caught:
            router.phase2_accounts(LOTTERY_ID, db=FakeSession(rows), current_user_id=1)
        assert caught.value.status_code == 503
