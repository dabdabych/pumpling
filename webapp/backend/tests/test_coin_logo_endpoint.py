"""The coin's picture from our own address, for the card the browser draws.

DexScreener's CDN sends no CORS header, so a canvas may not draw its pictures:
the share card showed $WIFWWW's initials on the stand on 2026-10-02 while the
coin list showed its picture. `/share/coin-logo/<mint>` serves the stored
picture from our origin. It takes a mint and nothing else, so it is no proxy.
"""
from __future__ import annotations

import inspect
import os
import sys

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from presentation.lottery import lottery_router  # noqa: E402
from presentation.share import share_router  # noqa: E402

MINT = "HUzsazhQgGmRfxfuo3HU4w5gtdB5nffkYBNUuogJpump"
DEX_PICTURE = "https://cdn.dexscreener.com/cms/images/LLtCKlWC4MLsnh5J?width=800"


@pytest.fixture(autouse=True)
def fresh_cache():
    share_router._logo_png.clear()
    yield
    share_router._logo_png.clear()


@pytest.fixture
def coin(monkeypatch):
    stored = {"logo": DEX_PICTURE}
    monkeypatch.setattr(lottery_router, "_get_coin_metadata", lambda db, mint: ("WIFWWW", "WIFWWW", stored["logo"] if mint == MINT else ""))
    return stored


def test_a_stored_picture_comes_back_as_png_from_us(coin, monkeypatch):
    fetched = []

    def fetch(url):
        fetched.append(url)
        return Image.new("RGBA", (32, 32), (220, 20, 60, 255))

    monkeypatch.setattr(share_router, "fetch_image", fetch)

    response = share_router.coin_logo(MINT, db=None)

    assert response.status_code == 200 and response.media_type == "image/png"
    assert response.body[:8] == b"\x89PNG\r\n\x1a\n"
    assert "max-age=3600" in response.headers["cache-control"]
    assert fetched == [DEX_PICTURE]

    share_router.coin_logo(MINT, db=None)
    assert fetched == [DEX_PICTURE], "the second ask is served from memory"


def test_ipfs_goes_through_each_gateway_in_turn(coin, monkeypatch):
    coin["logo"] = "https://ipfs.io/ipfs/bafkreibcglldkfdekdkxgumlveoe6qv3pbiceypkwtli33clbzul7leo4m"
    tried = []

    def fetch(url):
        tried.append(url)
        return Image.new("RGBA", (8, 8)) if len(tried) == 2 else None

    monkeypatch.setattr(share_router, "fetch_image", fetch)

    assert share_router.coin_logo(MINT, db=None).status_code == 200
    assert len(tried) == 2 and "ipfs.io" not in tried[0], "a gateway that still serves files, not ipfs.io"


@pytest.mark.parametrize("mint", ["not-a-mint", "../../etc/passwd", "So1111111111111111111111111111111111111111112X"])
def test_anything_but_a_mint_is_404(coin, monkeypatch, mint):
    monkeypatch.setattr(share_router, "fetch_image", lambda url: pytest.fail("nothing is fetched"))
    assert share_router.coin_logo(mint, db=None).status_code == 404


def test_a_coin_without_a_picture_or_a_dead_one_is_404(coin, monkeypatch):
    monkeypatch.setattr(share_router, "fetch_image", lambda url: None)
    assert share_router.coin_logo(MINT, db=None).status_code == 404
    coin["logo"] = ""
    assert share_router.coin_logo(MINT, db=None).status_code == 404


def test_it_takes_a_mint_and_nothing_else():
    """No address from the request: the picture's address comes from our table."""
    assert list(inspect.signature(share_router.coin_logo).parameters) == ["mint", "db"]
