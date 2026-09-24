"""Asking the cheapest question about a coin first.

Checking a coin reaches outside: DexScreener for pools, the chain for the
pump.fun curve, and for metadata pump.fun, then Helius DAS, then DexScreener
again. A Helius DAS call costs ten credits where an ordinary RPC call costs
one, so an address that is not a coin at all used to cost eleven credits to
turn down — and a valid-looking address is 32 bytes anyone can generate without
touching the network.

Now the first question is whether the address is an initialised SPL mint, which
is one RPC call, and nothing else runs when the answer is no.

The other half of this is what happens when the node cannot be reached. That is
not an answer, and `_validate_mint` also guards `place_bet`, so it must not turn
into a rejected commit.
"""
from __future__ import annotations

import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mint_validator import MintCheckUnavailable  # noqa: E402
from presentation.lottery import lottery_router as router  # noqa: E402

MINT = "47MnKCEMVquA4TBppHacYBk9EhHMpjVeWhixYMRDpump"


@pytest.fixture
def watch_the_expensive_calls(monkeypatch):
    """Records anything that would reach a paid or throttled provider."""
    called: list[str] = []

    def pools(mint):
        called.append("dexscreener")
        return []

    def curve(mint, rpc_url=None):
        called.append("curve-rpc")
        return (False, False, None)

    monkeypatch.setattr(router, "_cached_dex_pools", pools)
    monkeypatch.setattr(router, "_count_direct_liquidity_pools", lambda mint, p: 0)
    monkeypatch.setattr(router, "get_pumpfun_curve_info", curve)
    return called


class TestAnAddressThatIsNotACoin:
    def test_it_is_turned_down(self, monkeypatch, watch_the_expensive_calls):
        monkeypatch.setattr(router, "is_spl_mint", lambda mint, rpc_url=None: False)

        with pytest.raises(HTTPException) as caught:
            router._validate_mint(MINT)

        assert caught.value.status_code == 400
        assert "not a coin" in caught.value.detail

    def test_nothing_expensive_is_reached(self, monkeypatch, watch_the_expensive_calls):
        # The whole point. One RPC call, then stop.
        monkeypatch.setattr(router, "is_spl_mint", lambda mint, rpc_url=None: False)

        with pytest.raises(HTTPException):
            router._validate_mint(MINT)

        assert watch_the_expensive_calls == []

    def test_a_malformed_address_never_reaches_the_network(self, watch_the_expensive_calls):
        # Rejected on parsing, before even the one cheap call.
        with pytest.raises(HTTPException) as caught:
            router._validate_mint("not-a-pubkey")

        assert caught.value.status_code == 400
        assert watch_the_expensive_calls == []


class TestACoinThatExists:
    def test_the_usual_checks_still_run(self, monkeypatch, watch_the_expensive_calls):
        monkeypatch.setattr(router, "is_spl_mint", lambda mint, rpc_url=None: True)

        canonical, _network, _is_pumpfun, _has_dex, _count, _unverified = router._validate_mint(MINT)

        assert canonical == MINT
        assert "dexscreener" in watch_the_expensive_calls

    def test_the_cheap_check_comes_first(self, monkeypatch, watch_the_expensive_calls):
        order: list[str] = []

        def cheap(mint, rpc_url=None):
            order.append("is-spl-mint")
            return True

        monkeypatch.setattr(router, "is_spl_mint", cheap)
        monkeypatch.setattr(
            router, "_cached_dex_pools",
            lambda mint: order.append("dexscreener") or [],
        )

        router._validate_mint(MINT)

        assert order[0] == "is-spl-mint"


class TestWhenTheNodeCannotBeReached:
    """Not an answer. A commit must not fail because a node had a bad minute."""

    def test_the_slower_checks_still_decide(self, monkeypatch, watch_the_expensive_calls):
        def unreachable(mint, rpc_url=None):
            raise MintCheckUnavailable("connection refused")

        monkeypatch.setattr(router, "is_spl_mint", unreachable)

        canonical, _network, _is_pumpfun, _has_dex, _count, _unverified = router._validate_mint(MINT)

        assert canonical == MINT
        assert "dexscreener" in watch_the_expensive_calls

    def test_it_is_not_read_as_a_rejection(self, monkeypatch, watch_the_expensive_calls):
        def unreachable(mint, rpc_url=None):
            raise MintCheckUnavailable("timeout")

        monkeypatch.setattr(router, "is_spl_mint", unreachable)

        # No HTTPException: the address is still allowed through to the checks
        # that can answer, which is exactly the behaviour before this check
        # existed.
        router._validate_mint(MINT)
