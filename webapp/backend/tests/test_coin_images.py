"""A coin's picture on IPFS reaches the site through a gateway that still serves it.

ipfs.io stopped serving files over HTTP on 2026-09-21. Most pump.fun pictures
point there, through pump.fun's record, Helius DAS and Helius's image CDN
alike, so the coin list showed initials where the pictures should be. The
addresses below are the shapes found in the mainnet database on 2026-10-01.
"""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.coin_images import GATEWAYS, image_url_candidates, ipfs_path, normalize_image_url  # noqa: E402

CID = "bafkreia4umue2lmjgxh7mmypr4w4lqyzfyueay3xwolb7td6dd637cgg7y"
CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"
PUMP = "https://pump.mypinata.cloud/ipfs/"


@pytest.mark.parametrize("url, expected", [
    # The retired gateway, as pump.fun and Helius give it.
    (f"https://ipfs.io/ipfs/{CID}", CID),
    (f"http://ipfs.io/ipfs/{CID}", CID),
    # Other path gateways seen in the database, dead or alive: one gateway for all.
    (f"https://desperate-moccasin-minnow.myfilebase.com/ipfs/{CID}", CID),
    (f"https://i.raze.sh/ipfs/{CID}", CID),
    (f"https://dweb.link/ipfs/{CID_V0}", CID_V0),
    # A path inside the content, kept; a query, dropped.
    (f"https://ipfs.io/ipfs/{CID}/logo.png?filename=logo.png", f"{CID}/logo.png"),
    # Subdomain gateways, like the coins listed by hand in the router.
    (f"https://{CID}.ipfs.nftstorage.link/", CID),
    (f"https://{CID}.ipfs.dweb.link/image.png", f"{CID}/image.png"),
    # The protocol's own form.
    (f"ipfs://{CID}", CID),
    (f"ipfs://ipfs/{CID}/a.png", f"{CID}/a.png"),
    # Helius's CDN is a proxy in front of the same dead address.
    (f"https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/{CID}", CID),
    (f"https://cdn.helius-rpc.com/cdn-cgi/image/width=256/https://ipfs.io/ipfs/{CID}", CID),
])
def test_an_ipfs_address_is_recognised(url, expected):
    assert ipfs_path(url) == expected
    assert normalize_image_url(url) == f"{PUMP}{expected}"


@pytest.mark.parametrize("url", [
    "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
    "https://cdn.dexscreener.com/cms/images/QKFAMPna_9jiw4bi?width=800&height=800",
    "https://edge.uxento.io/image/abc.png",
    "https://cdn.helius-rpc.com/cdn-cgi/image//https://arweave.net/abc",
    # Looks like a gateway, but the id is not a content id.
    "https://ipfs.io/ipfs/not-a-cid",
    "https://notacid.ipfs.example.com/x.png",
    "ipfs://short",
    "data:image/png;base64,AAAA",
    "",
    None,
])
def test_anything_else_is_left_as_it_is(url):
    assert ipfs_path(url) is None
    assert normalize_image_url(url) == url


def test_rewriting_twice_changes_nothing():
    once = normalize_image_url(f"https://ipfs.io/ipfs/{CID}")
    assert normalize_image_url(once) == once


def test_the_server_tries_each_gateway_in_turn():
    assert image_url_candidates(f"https://ipfs.io/ipfs/{CID}") == [f"{gateway}{CID}" for gateway in GATEWAYS]
    assert GATEWAYS[0] == PUMP
    assert image_url_candidates("https://arweave.net/abc") == ["https://arweave.net/abc"]
    assert image_url_candidates(None) == []
    assert image_url_candidates("") == []


class TestEveryResponseRewritesIt:
    """The rewrite is in the response types, so no path to the site can miss it."""

    def test_the_coin_list(self):
        from application.lottery.schemas import CoinResponse

        coin = CoinResponse(name="lapa", symbol="LAPA", address="x", market_cap=0, current_price=0, price_history=[], volume_24h=0, logo_url=f"https://ipfs.io/ipfs/{CID}")
        assert coin.logo_url == f"{PUMP}{CID}"
        # A coin with no picture keeps none.
        assert CoinResponse(name="a", symbol="A", address="x", market_cap=0, current_price=0, price_history=[], volume_24h=0, logo_url="").logo_url == ""

    def test_my_commits_the_feed_and_the_coin_check(self):
        from datetime import datetime, timezone

        from application.lottery import schemas

        dead = f"https://ipfs.io/ipfs/{CID}"
        for model, fields in [
            (schemas.MyCommitCoinResponse, {"mint": "m", "name": "n", "ticker": "T", "my_sol": 0, "my_commits": 0, "pool_sol": 0}),
            (schemas.PurchaseFeedItemResponse, {"mint": "m", "name": "n", "symbol": "T", "sol_amount": 0, "signature": "s", "at": datetime.now(timezone.utc)}),
        ]:
            assert model(**fields, logo_url=dead).logo_url == f"{PUMP}{CID}", model.__name__
            assert model(**fields, logo_url=None).logo_url is None, model.__name__

        check = schemas.MintAllowTokenResponse(is_pumpfun_mint=True, mint_address="m", network_type="mainnet", token_image_url=dead)
        assert check.token_image_url == f"{PUMP}{CID}"

    def test_every_picture_field_is_covered(self):
        """A new response with a picture in it must use the same type."""
        import typing

        from application.lottery import schemas
        from pydantic import BaseModel

        missed = []
        for name in dir(schemas):
            model = getattr(schemas, name)
            if not (isinstance(model, type) and issubclass(model, BaseModel)) or model is BaseModel:
                continue
            for field, info in model.model_fields.items():
                if field.endswith(("logo_url", "image_url")):
                    validators = [m for m in info.metadata if type(m).__name__ == "AfterValidator"]
                    if not any(getattr(v, "func", None) is normalize_image_url for v in validators):
                        missed.append(f"{model.__name__}.{field}")
        assert missed == []


class TestTheShareCard:
    def test_it_falls_back_to_the_second_gateway(self, monkeypatch):
        from types import SimpleNamespace

        from PIL import Image

        from presentation.share import share_router

        asked = []

        def fetch(url):
            asked.append(url)
            return Image.new("RGBA", (8, 8)) if url.startswith(GATEWAYS[1]) else None

        monkeypatch.setattr(share_router, "fetch_image", fetch)
        logo = share_router._logo(SimpleNamespace(logo_url=f"https://ipfs.io/ipfs/{CID}"))
        assert logo is not None
        assert asked == [f"{GATEWAYS[0]}{CID}", f"{GATEWAYS[1]}{CID}"]

    def test_the_first_gateway_is_enough_when_it_answers(self, monkeypatch):
        from types import SimpleNamespace

        from PIL import Image

        from presentation.share import share_router

        asked = []

        def fetch(url):
            asked.append(url)
            return Image.new("RGBA", (8, 8))

        monkeypatch.setattr(share_router, "fetch_image", fetch)
        share_router._logo(SimpleNamespace(logo_url=f"https://ipfs.io/ipfs/{CID}"))
        assert asked == [f"{GATEWAYS[0]}{CID}"]
