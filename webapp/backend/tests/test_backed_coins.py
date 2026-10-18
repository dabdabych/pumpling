"""The coins people have backed with SOL, for the bubbles on the main page.

Asked for on 2026-10-16: in place of the chat on the first screen, the coins
that have been through the pools with at least 1 SOL, each one opening where it
trades. What is checked here: only counted commits add up, the threshold and
the order, where each coin is sent, and that the node is asked once per coin
and never while the database connection is held.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from application.lottery import backed_coins as bc  # noqa: E402

NOW = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)
PUMP_COIN = "8QSGZb2hc8zTM4GxsEUBfPhPUwZZDWWxUPdZPHvbpump"
RAYDIUM_COIN = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP"
HOOK_COIN = "9BMbyUfW6g4ptTGqyZeLdKRMz9tM4ssSgUEKYK94hook"
SMALL_COIN = "Be7XH8yqkyWBzJgUVSX5pa3bnzQsR13PTn6oJnrzpump"


@pytest.fixture
def sessions():
    from infrastructure.database.database import Base
    from infrastructure.database.models.bet_participation_model import BetParticipationModel
    from infrastructure.database.models.lottery_model import LotteryModel
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel
    from infrastructure.database.models.user_model import UserModel  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, BetParticipationModel.__table__, TokenMetadataModel.__table__])
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX uq_lotteries_open_by_type"))
    return sessionmaker(bind=engine)


@pytest.fixture
def db(sessions):
    session = sessions()
    yield session
    session.close()


def add_pool(db, pool_id):
    from domain.lottery.entities.lottery import LotteryStatus
    from infrastructure.database.models.lottery_model import LotteryModel

    db.add(LotteryModel(id=pool_id, name=f"pool {pool_id}", created_by_user_id=1, status=LotteryStatus.CLOSED, lottery_type="dex"))
    db.commit()


def add_commit(db, pool_id, mint, sol, status="confirmed", at=NOW):
    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    db.add(BetParticipationModel(user_id=1, lottery_id=pool_id, meme_coin_address=mint, sol_amount=sol,
                                 wallet_address="W", confirmation_status=status, created_at=at))
    db.commit()


def seed(db):
    add_pool(db, 1)
    add_pool(db, 2)
    add_commit(db, 1, PUMP_COIN, 15.0, at=NOW - timedelta(days=3))
    add_commit(db, 2, PUMP_COIN, 5.05, status="finalized", at=NOW - timedelta(days=1))
    add_commit(db, 1, RAYDIUM_COIN, 0.6)
    add_commit(db, 2, RAYDIUM_COIN, 0.45, status="finalized")
    add_commit(db, 1, HOOK_COIN, 0.9)
    add_commit(db, 2, HOOK_COIN, 5.0, status="orphaned")     # never counted
    add_commit(db, 1, SMALL_COIN, 1.0)


class TestWhatAddsUp:
    def test_counted_commits_from_every_pool_over_the_threshold_most_first(self, db):
        seed(db)
        coins = bc.backed_coins(db, 1.0, 60)
        assert [(c.mint, c.sol, c.pools) for c in coins] == [
            (PUMP_COIN, 20.05, 2),
            (RAYDIUM_COIN, 1.05, 2),
            (SMALL_COIN, 1.0, 1),
        ]
        assert HOOK_COIN not in [c.mint for c in coins], "an orphaned commit does not lift a coin over the line"
        assert coins[0].last_at.replace(tzinfo=timezone.utc) == NOW - timedelta(days=1)

    def test_the_threshold_and_the_limit(self, db):
        seed(db)
        assert [c.mint for c in bc.backed_coins(db, 0.5, 60)] == [PUMP_COIN, RAYDIUM_COIN, SMALL_COIN, HOOK_COIN]
        assert [c.mint for c in bc.backed_coins(db, 2.0, 60)] == [PUMP_COIN]
        assert [c.mint for c in bc.backed_coins(db, 0.5, 2)] == [PUMP_COIN, RAYDIUM_COIN]

    def test_the_latest_committed_to_first_for_the_main_page(self, db):
        seed(db)
        add_pool(db, 3)
        add_commit(db, 3, SMALL_COIN, 0.5, at=NOW + timedelta(hours=1))   # the latest commit of all
        recent = bc.backed_coins(db, 1.0, 60, sort=bc.SORT_RECENT)
        assert [c.mint for c in recent][0] == SMALL_COIN
        assert [c.mint for c in recent] == [SMALL_COIN, RAYDIUM_COIN, PUMP_COIN], "latest first, then by SOL among equals"
        assert [c.mint for c in bc.backed_coins(db, 1.0, 2, sort=bc.SORT_RECENT)] == [SMALL_COIN, RAYDIUM_COIN], "the limit keeps the latest"

    def test_nothing_yet_is_an_empty_list(self, db):
        assert bc.backed_coins(db, 1.0, 60) == []


class TestWhereACoinTrades:
    def test_a_pump_fun_coin_opens_on_pump_fun_whatever_its_address(self):
        assert bc.trade_link(HOOK_COIN, True) == (f"https://pump.fun/coin/{HOOK_COIN}", "pump.fun")

    def test_any_other_coin_opens_on_dexscreener(self):
        assert bc.trade_link(RAYDIUM_COIN, False) == (f"https://dexscreener.com/solana/{RAYDIUM_COIN}", "DexScreener")

    def test_when_the_node_said_nothing_the_address_decides(self):
        assert bc.trade_link(PUMP_COIN, None)[1] == "pump.fun"
        assert bc.trade_link(RAYDIUM_COIN, None)[1] == "DexScreener"


def node(answers, calls):
    """A node that knows which curve accounts exist, and remembers what it was asked."""
    def handle(request):
        import json

        body = json.loads(request.content)
        calls.append(body["params"][0])
        if answers == "down":
            return httpx.Response(503, text="unavailable")
        value = [{"owner": answers[address], "lamports": 1, "data": ["", "base64"]} if address in answers else None
                 for address in body["params"][0]]
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 1}, "value": value}})
    return httpx.Client(transport=httpx.MockTransport(handle))


class TestReadingTheChain:
    def test_a_curve_owned_by_pump_fun_says_yes_and_one_call_asks_for_all(self):
        calls = []
        curve = bc._curve_address(HOOK_COIN)
        foreign = bc._curve_address(RAYDIUM_COIN)
        client = node({curve: bc.PUMP_PROGRAM, foreign: "11111111111111111111111111111111"}, calls)
        answers = bc.read_made_on_pump("http://node", [HOOK_COIN, RAYDIUM_COIN, SMALL_COIN], client=client)
        assert answers == {HOOK_COIN: True, RAYDIUM_COIN: False, SMALL_COIN: False}
        assert len(calls) == 1 and len(calls[0]) == 3

    def test_a_node_that_is_down_leaves_every_answer_unknown(self):
        answers = bc.read_made_on_pump("http://node", [HOOK_COIN, RAYDIUM_COIN], client=node("down", []))
        assert answers == {HOOK_COIN: None, RAYDIUM_COIN: None}

    def test_something_that_is_not_an_address_is_not_a_pump_coin_and_is_not_sent(self):
        calls = []
        answers = bc.read_made_on_pump("http://node", ["not-a-mint"], client=node({}, calls))
        assert answers == {"not-a-mint": False}
        assert calls == []

    def test_known_answers_are_kept_unknown_ones_are_asked_again(self):
        asked = []
        replies = iter([{HOOK_COIN: True, RAYDIUM_COIN: None}, {RAYDIUM_COIN: False}])

        def reader(mints):
            asked.append(list(mints))
            return next(replies)

        cache = bc.MadeOnPumpCache(reader)
        assert cache.get([HOOK_COIN, RAYDIUM_COIN]) == {HOOK_COIN: True, RAYDIUM_COIN: None}
        assert cache.get([HOOK_COIN, RAYDIUM_COIN]) == {HOOK_COIN: True, RAYDIUM_COIN: False}
        assert asked == [[HOOK_COIN, RAYDIUM_COIN], [RAYDIUM_COIN]]
        assert cache.get([HOOK_COIN, RAYDIUM_COIN]) == {HOOK_COIN: True, RAYDIUM_COIN: False}
        assert len(asked) == 2, "nothing left to ask"


class TestTheEndpoint:
    @pytest.fixture
    def client(self, sessions, monkeypatch):
        from infrastructure.database.database import get_db
        from infrastructure.database.models.token_metadata_model import TokenMetadataModel
        from presentation.lottery import lottery_router as router

        session = sessions()
        seed(session)
        session.add(TokenMetadataModel(mint=PUMP_COIN, name="pumpling", symbol="PUMPLING", logo_url="https://pump.mypinata.cloud/ipfs/bafkreiabc"))
        session.commit()
        session.close()

        self.held = []
        opened = []

        def get_test_db():
            s = sessions()
            opened.append(s)
            try:
                yield s
            finally:
                s.close()

        def reader(mints):
            # The node must never be asked with a transaction open on the request's session.
            self.held.append(any(s.in_transaction() for s in opened))
            return {mint: mint == PUMP_COIN for mint in mints}

        self.asked = []
        cache = bc.MadeOnPumpCache(lambda mints: (self.asked.append(list(mints)), reader(mints))[1])
        monkeypatch.setattr(router, "_made_on_pump", cache)
        monkeypatch.setattr(router, "_backed_coins_cache", bc.TimedCache(60))
        api = FastAPI()
        api.include_router(router.router)
        api.dependency_overrides[get_db] = get_test_db
        return TestClient(api)

    def test_the_answer(self, client):
        response = client.get("/lottery/coins/backed")
        assert response.status_code == 200
        body = response.json()
        assert body["min_sol"] == 1.0
        first = body["items"][0]
        assert first == {
            "mint": PUMP_COIN, "name": "pumpling", "symbol": "PUMPLING",
            "logo_url": "https://pump.mypinata.cloud/ipfs/bafkreiabc",
            "sol": 20.05, "pools": 2, "last_at": first["last_at"],
            "trade_url": f"https://pump.fun/coin/{PUMP_COIN}", "venue": "pump.fun",
        }
        second = body["items"][1]
        assert (second["mint"], second["venue"], second["logo_url"]) == (RAYDIUM_COIN, "DexScreener", None)
        assert second["symbol"], "a coin with no stored name still gets one"
        assert [item["mint"] for item in body["items"]] == [PUMP_COIN, RAYDIUM_COIN, SMALL_COIN]

    def test_the_node_is_asked_after_the_connection_is_back(self, client):
        client.get("/lottery/coins/backed")
        assert self.held == [False], "a transaction was open while the node was asked"

    def test_a_second_ask_within_a_minute_is_served_from_memory(self, client):
        first = client.get("/lottery/coins/backed").json()
        assert client.get("/lottery/coins/backed").json() == first
        assert len(self.asked) == 1

    def test_the_main_page_asks_for_the_ten_latest(self, client):
        body = client.get("/lottery/coins/backed", params={"limit": 10, "sort": "recent"}).json()
        assert [i["mint"] for i in body["items"]][0] == RAYDIUM_COIN, "committed to at NOW, after PUMPLING's last at NOW-1d"
        assert client.get("/lottery/coins/backed", params={"sort": "newest"}).status_code == 422

    def test_bounds_on_what_can_be_asked(self, client):
        assert client.get("/lottery/coins/backed", params={"min_sol": 0}).status_code == 422
        assert client.get("/lottery/coins/backed", params={"limit": 500}).status_code == 422
        assert [i["mint"] for i in client.get("/lottery/coins/backed", params={"min_sol": 2}).json()["items"]] == [PUMP_COIN]


def test_the_timed_cache_forgets_after_its_time():
    now = [0.0]
    cache = bc.TimedCache(60, clock=lambda: now[0])
    cache.put("k", "v")
    now[0] = 59.0
    assert cache.get("k") == "v"
    now[0] = 61.0
    assert cache.get("k") is None


def test_the_timed_cache_cannot_be_grown_by_made_up_keys():
    now = [0.0]
    cache = bc.TimedCache(60, clock=lambda: now[0], max_items=8)
    for step in range(10_000):
        now[0] = step * 0.001
        cache.put((round(1 + step / 10_000, 4), 10, "recent"), "answer")
    assert len(cache._items) <= 8
    assert cache.get((round(1 + 9_999 / 10_000, 4), 10, "recent")) == "answer", "the newest stays"
    now[0] = 1_000.0
    cache.put("fresh", "v")
    assert cache.get("fresh") == "v"
