"""Which coins the buyer can burn, from the mint account alone.

Two real mint accounts, read from mainnet on 2026-09-29: a pump.fun coin on
Token-2022 (the $CMC of round 1790348400190, with MetadataPointer and
TokenMetadata) and a legacy SPL coin (BONK). The refusing cases are the
Token-2022 one with an extension added, laid out as the program lays it out.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from solders.pubkey import Pubkey

import mint_validator
from mint_validator import TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, burn_blocker, can_burn

ACCOUNTS = json.loads((Path(__file__).parent / "fixtures" / "mint_accounts.json").read_text())
T22 = base64.b64decode(ACCOUNTS["token2022_pumpfun"]["data_base64"])
LEGACY = base64.b64decode(ACCOUNTS["legacy_bonk"]["data_base64"])


def with_extension(data: bytes, ext_type: int, value: bytes) -> bytes:
    """The mint with one more TLV entry after its last one."""
    index = 166
    while index + 4 <= len(data):
        kind = int.from_bytes(data[index:index + 2], "little")
        if kind == 0:
            break
        index += 4 + int.from_bytes(data[index + 2:index + 4], "little")
    entry = ext_type.to_bytes(2, "little") + len(value).to_bytes(2, "little") + value
    return data[:index] + entry + data[index:]


def pausable(paused: bool) -> bytes:
    return bytes(range(1, 33)) + bytes([1 if paused else 0])


def test_the_real_pumpfun_token2022_coin_can_be_burned():
    assert ACCOUNTS["token2022_pumpfun"]["owner"] == str(TOKEN_2022_PROGRAM_ID)
    assert burn_blocker(TOKEN_2022_PROGRAM_ID, T22) is None


def test_the_real_legacy_coin_can_be_burned():
    assert ACCOUNTS["legacy_bonk"]["owner"] == str(TOKEN_PROGRAM_ID)
    assert burn_blocker(TOKEN_PROGRAM_ID, LEGACY) is None


@pytest.mark.parametrize("ext_type, value, reason", [
    (24, bytes(64), "ConfidentialMintBurn"),
    (28, bytes(32), "PermissionedBurn"),
    (26, pausable(True), "paused"),
])
def test_what_refuses_a_burn(ext_type, value, reason):
    assert reason in burn_blocker(TOKEN_2022_PROGRAM_ID, with_extension(T22, ext_type, value))


def test_a_pausable_mint_that_is_not_paused_can_be_burned():
    assert burn_blocker(TOKEN_2022_PROGRAM_ID, with_extension(T22, 26, pausable(False))) is None


@pytest.mark.parametrize("ext_type", [1, 12, 14, 16, 25, 27])
def test_extensions_that_do_not_touch_a_burn(ext_type):
    # Transfer fee, interest, permanent delegate, transfer hook, scaled UI
    # amount, pausable account: none of them is checked by process_burn.
    assert burn_blocker(TOKEN_2022_PROGRAM_ID, with_extension(T22, ext_type, bytes(40))) is None


def test_the_blocker_is_found_whatever_comes_before_it():
    data = with_extension(with_extension(T22, 1, bytes(108)), 28, bytes(32))
    assert "PermissionedBurn" in burn_blocker(TOKEN_2022_PROGRAM_ID, data)


def test_not_a_mint():
    assert burn_blocker(Pubkey.from_string("11111111111111111111111111111111"), T22) == "not a token mint"
    assert burn_blocker(TOKEN_2022_PROGRAM_ID, T22[:40]) == "not a token mint"
    token_account = T22[:165] + bytes([2]) + T22[166:]
    assert burn_blocker(TOKEN_2022_PROGRAM_ID, token_account) == "not a token mint"


def test_a_truncated_extension_is_unreadable_not_fine():
    data = with_extension(T22, 26, pausable(True))
    assert burn_blocker(TOKEN_2022_PROGRAM_ID, data[:-20]) is not None


class _Client:
    def __init__(self, info=None, error=None):
        self._info, self._error = info, error

    def get_account_info(self, _pubkey):
        if self._error:
            raise self._error
        return type("Answer", (), {"value": self._info})()


class _Info:
    def __init__(self, owner, data):
        self.owner, self.data = owner, data


def test_can_burn_reads_the_account(monkeypatch):
    monkeypatch.setattr(mint_validator, "Client", lambda url: _Client(_Info(TOKEN_2022_PROGRAM_ID, T22)))
    assert can_burn(ACCOUNTS["token2022_pumpfun"]["address"]) is True
    monkeypatch.setattr(mint_validator, "Client", lambda url: _Client(_Info(TOKEN_2022_PROGRAM_ID, with_extension(T22, 24, bytes(8)))))
    assert can_burn(ACCOUNTS["token2022_pumpfun"]["address"]) is False


def test_can_burn_does_not_know_when_the_node_does_not_say(monkeypatch):
    monkeypatch.setattr(mint_validator, "Client", lambda url: _Client(error=RuntimeError("429")))
    assert can_burn(ACCOUNTS["token2022_pumpfun"]["address"]) is None
    monkeypatch.setattr(mint_validator, "Client", lambda url: _Client(None))
    assert can_burn(ACCOUNTS["token2022_pumpfun"]["address"]) is None
    assert can_burn("not-an-address") is False


def test_the_site_offers_it_on_mainnet_only_when_known(monkeypatch):
    from presentation.lottery import lottery_router as router

    monkeypatch.setattr(router, "can_burn", lambda mint, url: None)
    assert router._coin_can_burn("x", router.NetworkType.MAINNET) is False
    assert router._coin_can_burn("x", router.NetworkType.DEVNET) is True
    monkeypatch.setattr(router, "can_burn", lambda mint, url: False)
    assert router._coin_can_burn("x", router.NetworkType.DEVNET) is False
