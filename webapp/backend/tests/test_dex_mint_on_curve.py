"""A coin on the pump.fun curve, in a DEX pool.

Such a coin has no DEX pool and cannot have one: it still trades on the curve.
The check used to answer "no SOL pool found", and the person read a warning
under the card that the buying might not go through. There is somewhere to buy
it, though: the buyer's router looks at the curve first and sends the coin to
pump.fun.

The test holds two cases: a live curve in SOL passes with no warning, while a
coin with neither a curve nor a pool stays as it was, with a measured caveat.
"""
from __future__ import annotations

import os
import sys

import pytest
from solders.pubkey import Pubkey

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from presentation.lottery import lottery_router as router  # noqa: E402
from domain.lottery.entities.lottery import LotteryType  # noqa: E402

MINT = "47MnKCEMVquA4TBppHacYBk9EhHMpjVeWhixYMRDpump"
NATIVE_SOL = Pubkey.from_string("11111111111111111111111111111111")
USDC = Pubkey.from_string("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")


def _no_dex_pools(monkeypatch):
    monkeypatch.setattr(router, "_cached_dex_pools", lambda mint: [])
    monkeypatch.setattr(router, "_count_direct_liquidity_pools", lambda mint, pools: 0)


def _curve(monkeypatch, is_pumpfun: bool, graduated: bool, quote=NATIVE_SOL):
    monkeypatch.setattr(
        router,
        "get_pumpfun_curve_info",
        lambda mint, rpc_url=None: (is_pumpfun, graduated, quote),
    )


@pytest.mark.parametrize(
    "is_pumpfun,graduated,quote,expected_pumpfun",
    [
        (True, False, NATIVE_SOL, True),      # a live curve in SOL — there is somewhere to buy
        (True, True, NATIVE_SOL, False),      # the curve is complete and there is no pool — as before
        (True, False, USDC, False),           # a curve not in SOL: it cannot be bought for SOL
        (False, False, NATIVE_SOL, False),    # not a pump.fun coin at all
    ],
)
def test_curve_decides_whether_a_poolless_coin_is_buyable(
    monkeypatch, is_pumpfun, graduated, quote, expected_pumpfun
):
    _no_dex_pools(monkeypatch)
    _curve(monkeypatch, is_pumpfun, graduated, quote)

    _mint, _network, is_pumpfun_mint, has_dex, pool_count, unverified = (
        router._validate_mint_by_lottery_type(MINT, LotteryType.DEX)
    )

    assert is_pumpfun_mint is expected_pumpfun
    assert has_dex is False
    assert pool_count == 0
    assert unverified is False


def test_broken_curve_probe_does_not_block_the_commit(monkeypatch):
    """The node did not answer — we let the coin through anyway, as before."""
    _no_dex_pools(monkeypatch)

    def boom(mint, rpc_url=None):
        raise RuntimeError("rpc down")

    monkeypatch.setattr(router, "get_pumpfun_curve_info", boom)

    _mint, _network, is_pumpfun_mint, has_dex, _count, _unverified = (
        router._validate_mint_by_lottery_type(MINT, LotteryType.DEX)
    )

    assert is_pumpfun_mint is False
    assert has_dex is False


def test_provider_outage_falls_back_to_the_curve(monkeypatch):
    """The pool source is down, but the curve is read from the network and speaks for itself."""

    def unavailable(mint):
        raise router.DexLiquidityCheckUnavailable("provider down")

    monkeypatch.setattr(router, "_cached_dex_pools", unavailable)
    _curve(monkeypatch, True, False, NATIVE_SOL)

    _mint, _network, is_pumpfun_mint, _has_dex, _count, unverified = (
        router._validate_mint_by_lottery_type(MINT, LotteryType.DEX)
    )

    assert is_pumpfun_mint is True
    # Since there is somewhere to buy, there is no reason to mark the coin "unverified".
    assert unverified is False
