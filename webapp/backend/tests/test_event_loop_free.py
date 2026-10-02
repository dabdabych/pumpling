"""A slow outside source never holds up the rest of the API.

Coin search, the price chart and the purchase feed wait on pump.fun,
DexScreener, Helius, the node and the buyer through urllib, which blocks. They
were `async def`, so the wait ran on the event loop and every other request to
the API waited behind it. Measured on the stand on 2026-10-02: five coin
searches at once held /ping and /lottery/current for 2.3 s, and it adds up with
every visitor searching. They are plain `def` now, which FastAPI runs in its
thread pool; `place_bet` awaits, so its two blocking calls go to the pool by
hand.

Each test runs the real router with the outside sources replaced by ones that
sleep, and asks for /ping in the middle: on the old code the ping waits for the
sleep.
"""
from __future__ import annotations

import ast
import asyncio
import os
import sys
import time

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from presentation.lottery import lottery_router as router  # noqa: E402

SLOW = 0.6
MINT = "So11111111111111111111111111111111111111112"
ROUTER_SOURCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "presentation", "lottery", "lottery_router.py")


@pytest.fixture
def app():
    from infrastructure.database.database import Base
    from infrastructure.database.models.coin_screening_model import CoinScreeningModel
    from infrastructure.database.models.lottery_model import LotteryModel
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel
    from infrastructure.database.models.user_model import UserModel  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, TokenMetadataModel.__table__, CoinScreeningModel.__table__])
    sessions = sessionmaker(bind=engine)

    def get_db():
        session = sessions()
        try:
            yield session
        finally:
            session.close()

    api = FastAPI()
    api.include_router(router.router)

    @api.get("/ping")
    async def ping():
        return {"ok": True}

    api.dependency_overrides[router.get_db] = get_db
    api.dependency_overrides[router.get_current_user] = lambda: 1
    return api


def slow(result):
    def call(*args, **kwargs):
        time.sleep(SLOW)
        return result
    return call


PING_AFTER = 0.1


def race(api, method, path, **kwargs):
    """The slow request, and /ping due 0.1 s into it: how long the slow one took,
    and how late the ping answered.

    Late is counted from when the ping was due, not from when it went out: a
    blocked loop also holds the `sleep` before it, so a ping timed from its own
    start would look fast exactly when the loop is stuck.
    """
    async def run():
        transport = httpx.ASGITransport(app=api)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=10) as client:
            began = time.monotonic()

            async def the_slow_one():
                response = await client.request(method, path, **kwargs)
                return response, time.monotonic() - began

            async def the_ping():
                await asyncio.sleep(PING_AFTER)
                response = await client.get("/ping")
                return response, time.monotonic() - began - PING_AFTER

            return await asyncio.gather(the_slow_one(), the_ping())

    (slow_response, slow_seconds), (ping_response, ping_late) = asyncio.run(run())
    assert ping_response.status_code == 200
    return slow_response, slow_seconds, ping_late


class TestTheLoopStaysFree:
    def test_a_coin_search_waiting_on_its_sources(self, app, monkeypatch):
        from domain.lottery.entities.allowed_mint import NetworkType

        monkeypatch.setattr(router, "_validate_mint", slow((MINT, NetworkType.MAINNET, True, True, 1, False)))
        monkeypatch.setattr(router, "_fetch_token_metadata", lambda mint: {"token_name": "Mochi", "token_symbol": "MOCHI", "token_image_url": None})
        monkeypatch.setattr(router, "_coin_can_burn", lambda mint, network: True)
        monkeypatch.setattr(router, "_cached_dex_pools", lambda mint: [])
        monkeypatch.setattr(router, "_dex_market_info", lambda mint, pools: {})

        response, searched, pinged = race(app, "POST", "/lottery/check-mint", json={"mint_address": MINT, "lottery_type": "dex"})

        assert response.status_code == 200 and response.json()["token_symbol"] == "MOCHI"
        assert searched >= SLOW
        assert pinged < SLOW / 2, f"/ping waited {pinged:.2f} s behind the coin search"

    def test_a_price_chart_waiting_on_dexscreener(self, app, monkeypatch):
        from types import SimpleNamespace

        monkeypatch.setattr(router, "_cached_dex_pools", slow([]))
        monkeypatch.setattr(router, "coin_chart", lambda *args, **kwargs: SimpleNamespace(available=False, points=[], minutes=0, venue=None))

        response, charted, pinged = race(app, "GET", f"/lottery/coin/{MINT}/chart")

        assert response.status_code == 200 and charted >= SLOW
        assert pinged < SLOW / 2, f"/ping waited {pinged:.2f} s behind the chart"

    def test_the_purchase_feed_waiting_on_the_buyer(self, app, monkeypatch):
        # The buyer is asked with a 60 s timeout: a stuck buyer used to stop the whole API that long.
        monkeypatch.setattr(router, "_cached_purchase_feed", slow(None))

        response, fed, pinged = race(app, "GET", "/lottery/42/purchases")

        assert response.status_code == 200 and response.json()["available"] is False and fed >= SLOW
        assert pinged < SLOW / 2, f"/ping waited {pinged:.2f} s behind the purchase feed"


#: What blocks: the network through urllib, directly or one call down.
BLOCKING = {
    "_validate_mint", "_fetch_token_metadata", "_fetch_pumpfun_token_metadata", "_fetch_dexscreener_token_metadata",
    "_fetch_helius_token_metadata", "_cached_dex_pools", "_fetch_dex_pools_for_mint", "_cached_purchase_feed",
    "_coin_can_burn", "coin_chart", "urlopen", "fetch_purchases",
}


def test_no_async_endpoint_calls_a_blocking_source_on_the_loop():
    """`await run_in_threadpool(fn, ...)` passes `fn` uncalled, so only a direct call is a finding."""
    tree = ast.parse(open(ROUTER_SOURCE, encoding="utf-8").read())
    findings = []
    for node in tree.body:
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        if not any(isinstance(d, ast.Call) and getattr(d.func, "attr", "") in ("get", "post", "put", "delete", "patch") for d in node.decorator_list):
            continue
        for call in ast.walk(node):
            if isinstance(call, ast.Call):
                name = call.func.id if isinstance(call.func, ast.Name) else getattr(call.func, "attr", "")
                if name in BLOCKING:
                    findings.append(f"{node.name}:{call.lineno} calls {name}")
    assert findings == []


def test_two_searches_storing_the_same_new_coin(monkeypatch):
    """Each read no row, the first wrote it, the second hit the key: the second now updates it."""
    from infrastructure.database.database import Base
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[TokenMetadataModel.__table__])
    sessions = sessionmaker(bind=engine)

    first = sessions()
    router._persist_token_metadata(first, MINT, name="Mochi", symbol="MOCHI")
    first.close()

    class SawNothingYet:
        """A session whose first look for the coin comes back empty, as if the other write had not landed."""

        def __init__(self, session):
            self.session = session
            self.looked = False

        def query(self, model):
            query = self.session.query(model)
            if self.looked:
                return query
            self.looked = True

            class Empty:
                def filter(self, *args):
                    return self

                def first(self):
                    return None

            return Empty()

        def __getattr__(self, name):
            return getattr(self.session, name)

    second = SawNothingYet(sessions())
    router._persist_token_metadata(second, MINT, logo_url="https://example.com/mochi.png")
    second.session.close()

    check = sessions()
    row = check.query(TokenMetadataModel).filter(TokenMetadataModel.mint == MINT).one()
    assert (row.name, row.symbol, row.logo_url) == ("Mochi", "MOCHI", "https://example.com/mochi.png")
    check.close()


def test_a_coin_search_holds_no_database_connection_while_it_waits(monkeypatch):
    """Searches run side by side now. One that kept its connection through a
    slow source would take one of the pool's 15 for that long, and enough of
    them would leave /lottery/current waiting for a connection on the loop."""
    from domain.lottery.entities.allowed_mint import NetworkType
    from infrastructure.database.database import Base
    from infrastructure.database.models.coin_screening_model import CoinScreeningModel
    from infrastructure.database.models.lottery_model import LotteryModel
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel
    from infrastructure.database.models.user_model import UserModel  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, TokenMetadataModel.__table__, CoinScreeningModel.__table__])
    session = sessionmaker(bind=engine)()
    held = []

    def network(result):
        def call(*args, **kwargs):
            held.append(session.in_transaction())
            return result
        return call

    monkeypatch.setattr(router, "_validate_mint", network((MINT, NetworkType.MAINNET, True, True, 1, False)))
    monkeypatch.setattr(router, "_fetch_token_metadata", network({"token_name": "Mochi", "token_symbol": "MOCHI", "token_image_url": None}))
    monkeypatch.setattr(router, "_coin_can_burn", network(True))
    monkeypatch.setattr(router, "_cached_dex_pools", network([]))
    monkeypatch.setattr(router, "_dex_market_info", lambda mint, pools: {})

    from application.lottery.schemas import MintAllowTokenRequest

    response = router.check_mint(MintAllowTokenRequest(mint_address=MINT, lottery_type="dex"), db=session, current_user_id=1)
    session.close()

    assert response.token_symbol == "MOCHI"
    assert held == [False, False, False, False], "a transaction was open during a network call"
