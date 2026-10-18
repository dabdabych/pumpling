"""A coin's stay in pumpling, for the window that opens from its bubble.

Asked for on 2026-10-16: pressing a bubble shows the coin's chart from when it
came into a pool to when the pool had bought it, for the pool where the most
SOL stood behind it. What is checked: which pool, which buys, the window's
ends; GeckoTerminal asked within the one budget, the pool that traded most in
the window chosen; the schedule that keeps the bubbles' charts (refreshed
while the pool runs, final a quarter of an hour after its last buy, non-final
ones of coins gone from the bubbles deleted); and the endpoint, which reads
the kept chart and never asks GeckoTerminal.
"""
from __future__ import annotations

import io
import os
import sys
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from application.lottery import coin_story as cs  # noqa: E402
from shared import gecko_budget  # noqa: E402

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
MINT = "8QSGZb2hc8zTM4GxsEUBfPhPUwZZDWWxUPdZPHvbpump"
OTHER = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP"
ms = lambda moment: int(moment.timestamp() * 1000)  # noqa: E731


@pytest.fixture
def sessions():
    from infrastructure.database.database import Base
    from infrastructure.database.models.bet_participation_model import BetParticipationModel
    from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel
    from infrastructure.database.models.lottery_model import LotteryModel
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel
    from infrastructure.database.models.user_model import UserModel  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, BetParticipationModel.__table__, TokenMetadataModel.__table__,
                                             CoinStoryChartModel.__table__])
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX uq_lotteries_open_by_type"))
    return sessionmaker(bind=engine)


@pytest.fixture
def db(sessions):
    session = sessions()
    yield session
    session.close()


def add_pool(db, pool_id, status="CLOSED", closed_at=None):
    from domain.lottery.entities.lottery import LotteryStatus
    from infrastructure.database.models.lottery_model import LotteryModel

    db.add(LotteryModel(id=pool_id, name=f"pool {pool_id}", created_by_user_id=1, status=getattr(LotteryStatus, status), lottery_type="dex",
                        closed_at=closed_at))
    db.commit()


def add_commit(db, pool_id, mint, sol, at, status="confirmed"):
    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    db.add(BetParticipationModel(user_id=1, lottery_id=pool_id, meme_coin_address=mint, sol_amount=sol,
                                 wallet_address="W", confirmation_status=status, created_at=at))
    db.commit()


def seed(db):
    add_pool(db, 1)
    add_pool(db, 2)
    add_pool(db, 3, "CREATED")
    add_commit(db, 1, MINT, 0.5, NOW - timedelta(days=3, minutes=20))
    add_commit(db, 2, MINT, 15.0, NOW - timedelta(days=1, minutes=40))   # the pool with the most behind it
    add_commit(db, 2, MINT, 5.0, NOW - timedelta(days=1, minutes=10))
    add_commit(db, 3, MINT, 3.0, NOW - timedelta(minutes=5))
    add_commit(db, 3, MINT, 30.0, NOW - timedelta(minutes=4), status="orphaned")   # never counted


class TestWhichPool:
    def test_the_pool_with_the_most_sol_behind_the_coin(self, db):
        seed(db)
        stay = cs.chosen_stay(db, MINT)
        assert (stay.lottery_id, stay.sol, stay.status, stay.finished) == (2, 20.0, "closed", True)
        assert stay.entered_at == NOW - timedelta(days=1, minutes=40), "its first commit in that pool"

    def test_level_pools_give_the_later_one(self, db):
        add_pool(db, 1)
        add_pool(db, 2)
        add_commit(db, 1, MINT, 2.0, NOW - timedelta(days=2))
        add_commit(db, 2, MINT, 2.0, NOW - timedelta(days=1))
        assert cs.chosen_stay(db, MINT).lottery_id == 2

    def test_a_coin_never_in_a_pool_has_no_stay(self, db):
        seed(db)
        assert cs.chosen_stay(db, OTHER) is None


class TestTheBuysAndTheWindow:
    FEED = {"purchases": [
        {"mint": MINT, "solAmount": 0.4, "signature": "b2", "at": ms(NOW - timedelta(minutes=30))},
        {"mint": MINT, "solAmount": 0.39, "signature": "b1", "at": ms(NOW - timedelta(minutes=50))},
        {"mint": OTHER, "solAmount": 1.0, "signature": "o1", "at": ms(NOW - timedelta(minutes=40))},
        {"mint": MINT, "solAmount": 0.4, "signature": "", "at": ms(NOW)},                  # no signature
        {"mint": MINT, "solAmount": "x", "signature": "junk", "at": ms(NOW)},               # no amount
        {"mint": MINT, "solAmount": 0.4, "signature": "late", "at": "yesterday"},           # no time
    ]}

    def test_only_this_coins_buys_oldest_first_and_junk_left_out(self):
        assert [b.signature for b in cs.buys_of(self.FEED, MINT)] == ["b1", "b2"]
        assert cs.buys_of(None, MINT) == []

    def test_the_supply_before_the_burn_from_the_feed(self):
        feed = {"tokens": [{"mint": MINT, "decimals": 6, "burn": {"supplyAtStart": "999123456789000"}},
                           {"mint": OTHER, "decimals": 6, "burn": {"supplyAtStart": None}}]}
        assert cs.supply_from_feed(feed, MINT) == 999_123_456.789
        assert cs.supply_from_feed(feed, OTHER) is None and cs.supply_from_feed(None, MINT) is None
        assert cs.supply_from_feed({"tokens": [{"mint": MINT, "decimals": True, "burn": {"supplyAtStart": "1"}}]}, MINT) is None

    def test_what_the_pool_burned_from_the_feed(self):
        feed = {"tokens": [{"mint": MINT, "decimals": 6, "burn": {"burnedRaw": "79863241987601"}},
                           {"mint": OTHER, "decimals": 6, "burn": {"burnedRaw": None}}]}
        assert cs.burned_from_feed(feed, MINT) == 79_863_241.987601
        assert cs.burned_from_feed(feed, OTHER) == 0.0, "a coin the buyer knows and did not burn"
        assert cs.burned_from_feed({"tokens": [{"mint": MINT}]}, MINT) == 0.0
        assert cs.burned_from_feed(feed, "Z" * 44) is None and cs.burned_from_feed(None, MINT) is None

    def test_the_share_and_what_went_back(self):
        feed = {
            "tokens": [{"mint": MINT, "targetSol": 15.019}, {"mint": OTHER, "targetSol": 0}],
            "refunds": [{"mint": MINT, "sol": 15.019, "signature": "r1"}, {"mint": MINT, "sol": 1, "signature": ""},
                        {"mint": OTHER, "sol": "x", "signature": "r2"}],
        }
        assert cs.share_of(feed, MINT) == 15.019 and cs.refunded_of(feed, MINT) == 15.019
        assert cs.share_of(feed, OTHER) == 0.0 and cs.refunded_of(feed, OTHER) == 0.0
        assert cs.share_of(feed, "Z" * 44) == 0.0, "a pool the buyer knows and the coin not in it: no share"
        assert cs.share_of({"tokens": []}, MINT) is None and cs.share_of(None, MINT) is None, "no coins at all: not known"

    def test_a_finished_pool_ends_a_little_after_its_last_buy(self):
        stay = cs.Stay(2, 20.0, NOW - timedelta(minutes=90), "closed")
        start, end = cs.window(stay, cs.buys_of(self.FEED, MINT), NOW)
        assert start == NOW - timedelta(minutes=95)
        assert end == NOW - timedelta(minutes=25)

    def test_a_pool_still_running_runs_to_now(self):
        stay = cs.Stay(3, 3.0, NOW - timedelta(minutes=5), "proceeding_purchases")
        assert cs.window(stay, cs.buys_of(self.FEED, MINT), NOW)[1] == NOW
        assert cs.window(cs.Stay(3, 3.0, NOW - timedelta(minutes=5), "created"), [], NOW)[1] == NOW
        assert cs.left_at(stay, cs.buys_of(self.FEED, MINT)) is None

    def test_a_finished_pool_with_no_buys_of_it_ends_at_its_close_not_now(self):
        """On the stand the buyer had no buys of these pools, and their windows ran two weeks to now."""
        closed = NOW - timedelta(days=14, hours=-2)
        stay = cs.Stay(2, 5.0, NOW - timedelta(days=14), "closed", ended_at=closed)
        assert cs.window(stay, [], NOW) == (NOW - timedelta(days=14, minutes=5), closed + timedelta(minutes=5))
        assert cs.left_at(stay, []) == closed
        assert cs.left_at(stay, cs.buys_of(self.FEED, MINT)) == NOW - timedelta(minutes=30), "the last buy when there is one"

    def test_the_close_comes_from_the_pool(self, db):
        add_pool(db, 7, closed_at=NOW - timedelta(hours=1))
        add_commit(db, 7, MINT, 2.0, NOW - timedelta(hours=3))
        assert cs.chosen_stay(db, MINT).ended_at == NOW - timedelta(hours=1)


def pools_body(*pools):
    return {"data": [{"attributes": {"address": address, "pool_created_at": created}, "relationships": {"dex": {"data": {"id": dex}}}}
                     for address, dex, created in pools]}


def candles_body(rows):
    return {"data": {"attributes": {"ohlcv_list": rows}}}


def gecko_with(fetch, clock):
    """A GeckoTerminal reader with a budget of its own, so the tests do not spend each other's."""
    return cs.GeckoTerminal(fetch, clock=clock, budget=gecko_budget.Budget(clock=clock))


class FakeGecko:
    """GeckoTerminal answering from a script, remembering what it was asked."""

    def __init__(self, pools, candles):
        self.pools = pools
        self.candles = candles
        self.asked = []

    def __call__(self, url):
        self.asked.append(url)
        if "/tokens/" in url:
            return pools_body(*self.pools)
        address = url.split("/pools/")[1].split("/")[0]
        return candles_body(self.candles.get(address, []))


START = NOW - timedelta(minutes=60)
END = NOW - timedelta(minutes=10)
t = lambda minutes_before_now: int((NOW - timedelta(minutes=minutes_before_now)).timestamp())  # noqa: E731


class TestGeckoTerminal:
    def test_the_pool_that_traded_most_in_the_window_and_only_the_window(self):
        fake = FakeGecko(
            pools=[("CURVE", "pump-fun", "2026-10-17T10:00:00Z"), ("SWAP", "pumpswap", "2026-10-17T11:00:00Z")],
            candles={
                "CURVE": [[t(80), 1, 1, 1, 1, 99.0], [t(50), 1, 2, 1, 2, 10.0], [t(20), 2, 3, 2, 3, 10.0]],
                "SWAP": [[t(40), 5, 5, 5, 5, 1.0]],
            },
        )
        candles = gecko_with(fake, lambda: 0.0).fetch(MINT, START, END)
        assert candles.pool == "CURVE" and candles.minutes == 1
        assert [row[0] for row in candles.rows] == [t(50), t(20)], "the candle from before the window is left out"
        asked = [url for url in fake.asked if "/ohlcv/" in url]
        assert all("currency=token" in url and "aggregate=1" in url for url in asked), "priced in SOL, one candle a minute"

    def test_a_pool_made_after_the_window_cannot_hold_it(self):
        fake = FakeGecko(pools=[("LATE", "pumpswap", "2026-10-18T11:55:00Z"), ("CURVE", "pump-fun", None)],
                         candles={"LATE": [[t(30), 9, 9, 9, 9, 500.0]], "CURVE": [[t(30), 1, 1, 1, 1, 1.0]]})
        assert gecko_with(fake, lambda: 0.0).fetch(MINT, START, END).pool == "CURVE"
        assert not any("/LATE/" in url for url in fake.asked)

    def test_a_coin_that_left_its_curve_in_the_window_is_one_chart(self):
        fake = FakeGecko(
            pools=[("SWAP", "pumpswap", "2026-10-18T11:30:00Z"), ("CURVE", "pump-fun", "2026-10-17T10:00:00Z")],
            candles={
                "CURVE": [[t(50), 1, 2, 1, 2, 10.0], [t(31), 2, 4, 2, 4, 30.0]],
                "SWAP": [[t(31), 4, 5, 3, 5, 5.0], [t(20), 5, 6, 5, 6, 50.0]],
            },
        )
        candles = gecko_with(fake, lambda: 0.0).fetch(MINT, START, END)
        assert [row[0] for row in candles.rows] == [t(50), t(31), t(20)]
        assert candles.rows[1] == [t(31), 2, 5, 2, 5, 35.0], "the minute it moved: the curve's open, the new pool's close, both volumes"
        assert candles.pool == "SWAP", "the link goes to the pool that traded most"

    def test_the_empty_minutes_are_asked_for(self):
        """Skipped by default: a coin that came in on a quiet minute had no candle for its dot."""
        fake = FakeGecko(pools=[("CURVE", "pump-fun", None)], candles={"CURVE": [[t(30), 1, 1, 1, 1, 1.0]]})
        gecko_with(fake, lambda: 0.0).fetch(MINT, START, END)
        assert all("include_empty_intervals=true" in url for url in fake.asked if "/ohlcv/" in url)

    def test_filled_minutes_do_not_stop_a_curve_and_its_new_pool_being_joined(self):
        """Filled, the curve runs flat past its graduation and the new pool flat before its first trade."""
        fake = FakeGecko(
            pools=[("SWAP", "pumpswap", "2026-10-18T11:30:00Z"), ("CURVE", "pump-fun", "2026-10-17T10:00:00Z")],
            candles={
                "CURVE": [[t(50), 1, 2, 1, 2, 10.0], [t(31), 2, 4, 2, 4, 30.0], [t(30), 4, 4, 4, 4, 0.0], [t(20), 4, 4, 4, 4, 0.0]],
                "SWAP": [[t(50), 4, 4, 4, 4, 0.0], [t(31), 4, 5, 3, 5, 5.0], [t(20), 5, 6, 5, 6, 50.0]],
            },
        )
        candles = gecko_with(fake, lambda: 0.0).fetch(MINT, START, END)
        assert [row[0] for row in candles.rows] == [t(50), t(31), t(20)]
        assert candles.rows[1] == [t(31), 2, 5, 2, 5, 35.0]

    def test_two_pools_one_after_the_other_off_the_curve_are_not_joined(self):
        fake = FakeGecko(pools=[("RAY", "raydium", None), ("ORCA", "orca", None)],
                         candles={"RAY": [[t(50), 1, 1, 1, 1, 10.0]], "ORCA": [[t(20), 9, 9, 9, 9, 20.0]]})
        candles = gecko_with(fake, lambda: 0.0).fetch(MINT, START, END)
        assert candles.pool == "ORCA" and [row[0] for row in candles.rows] == [t(20)]

    def test_a_long_window_takes_five_minute_candles(self):
        fake = FakeGecko(pools=[("CURVE", "pump-fun", None)], candles={"CURVE": [[t(30), 1, 1, 1, 1, 1.0]]})
        gecko_with(fake, lambda: 0.0).fetch(MINT, NOW - timedelta(hours=10), END)
        assert "aggregate=5" in fake.asked[-1]

    def test_no_candles_is_none(self):
        fake = FakeGecko(pools=[("CURVE", "pump-fun", None)], candles={})
        assert gecko_with(fake, lambda: 0.0).fetch(MINT, START, END) is None

    def test_a_coins_pools_are_kept_ten_minutes_and_none_yet_three(self):
        now = [0.0]
        fake = FakeGecko(pools=[("CURVE", "pump-fun", None)], candles={"CURVE": [[t(30), 1, 1, 1, 1, 1.0]]})
        gecko = gecko_with(fake, lambda: now[0])
        gecko.fetch(MINT, START, END)
        now[0] = cs.POOLS_SECONDS - 1
        gecko.fetch(MINT, START, END)
        assert sum("/tokens/" in url for url in fake.asked) == 1
        now[0] = cs.POOLS_SECONDS + 1
        gecko.fetch(MINT, START, END)
        assert sum("/tokens/" in url for url in fake.asked) == 2, "a graduation makes a new pool"

        empty = FakeGecko(pools=[], candles={})
        gecko = gecko_with(empty, lambda: now[0])
        assert gecko.fetch(OTHER, START, END) is None
        now[0] += cs.NO_POOLS_SECONDS - 1
        gecko.fetch(OTHER, START, END)
        assert len(empty.asked) == 1
        now[0] += 2
        gecko.fetch(OTHER, START, END)
        assert len(empty.asked) == 2, "GeckoTerminal finds a new coin a little after it trades"

    def test_the_budget_and_their_429_both_say_busy(self, monkeypatch):
        fake = FakeGecko(pools=[("CURVE", "pump-fun", None)], candles={"CURVE": [[t(30), 1, 1, 1, 1, 1.0]]})
        gecko = gecko_with(fake, lambda: 0.0)
        for _ in range(gecko_budget.CALLS_PER_MINUTE - 1):
            gecko.fetch(MINT, START, END)
        with pytest.raises(cs.GeckoBusy):
            gecko.fetch(MINT, START, END)

        from shared import fast_http

        def too_many(request, timeout=None, context=None):
            raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, io.BytesIO(b""))
        monkeypatch.setattr(fast_http, "urlopen", too_many)
        with pytest.raises(cs.GeckoBusy):
            cs.fetch_json_with(None, 1.0)("https://api.geckoterminal.com/x")

    def test_the_hover_chart_and_the_coin_charts_spend_one_budget(self):
        """Each had twenty a minute of its own, forty together against GeckoTerminal's ten."""
        from shared import coin_chart

        coin_chart.reset_for_tests()
        try:
            for _ in range(gecko_budget.CALLS_PER_MINUTE):
                assert coin_chart._allow_call()
            fake = FakeGecko(pools=[("CURVE", "pump-fun", None)], candles={"CURVE": [[t(30), 1, 1, 1, 1, 1.0]]})
            with pytest.raises(cs.GeckoBusy):
                cs.GeckoTerminal(fake).fetch(MINT, START, END)
            assert fake.asked == []
            # "GeckoTerminal endpoints: ~10 calls/min" for keyless calls, per address.
            assert gecko_budget.CALLS_PER_MINUTE < 10
        finally:
            coin_chart.reset_for_tests()

    def test_a_coin_it_does_not_know_is_no_chart_not_a_failure(self, monkeypatch):
        from shared import fast_http

        def unknown(request, timeout=None, context=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b""))
        monkeypatch.setattr(fast_http, "urlopen", unknown)
        assert gecko_with(cs.fetch_json_with(None, 1.0), lambda: 0.0).fetch(MINT, START, END) is None

        def broken(request, timeout=None, context=None):
            raise urllib.error.HTTPError(request.full_url, 500, "Server Error", {}, io.BytesIO(b""))
        monkeypatch.setattr(fast_http, "urlopen", broken)
        with pytest.raises(urllib.error.HTTPError):
            gecko_with(cs.fetch_json_with(None, 1.0), lambda: 0.0).fetch(MINT, START, END)


THIRD = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
LAST_BUY = NOW - timedelta(hours=2, minutes=10)


class TestTheSchedule:
    """The thread that keeps the bubbles' charts (`coin_story.targets` and `run_once`)."""

    FEED = {"purchases": [{"mint": MINT, "solAmount": 1.9, "signature": "b1", "at": ms(LAST_BUY)}],
            "tokens": [{"mint": MINT, "targetSol": 1.94}], "refunds": [{"mint": MINT, "sol": 0.04, "signature": "r1"}]}

    @pytest.fixture
    def world(self, sessions):
        db = sessions()
        add_pool(db, 1, closed_at=NOW - timedelta(hours=2))
        add_commit(db, 1, MINT, 2.0, NOW - timedelta(hours=3))
        add_pool(db, 2, "CREATED")
        add_commit(db, 2, OTHER, 3.0, NOW - timedelta(minutes=10))
        db.close()
        self.sessions = sessions
        self.fake = FakeGecko(pools=[("CURVE", "pump-fun", None)],
                              candles={"CURVE": [[int((LAST_BUY - timedelta(minutes=20)).timestamp()), 1, 2, 1, 2, 5.0],
                                                 [int((NOW - timedelta(minutes=5)).timestamp()), 2, 2, 2, 2, 1.0]]})
        self.budget = gecko_budget.Budget(clock=lambda: 0.0)
        self.gecko = cs.GeckoTerminal(self.fake, clock=lambda: 0.0, budget=self.budget)
        self.feeds = {1: self.FEED}
        return self

    def run(self, now, feed_of=None):
        self.budget.reset()
        found = cs.targets(self.sessions())
        return cs.run_once(found, self.gecko, self.budget, feed_of or self.feeds.get, self.sessions, now)

    def row(self, mint, pool):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        return self.sessions().get(CoinStoryChartModel, (mint, pool))

    def test_the_bubbles_coins_and_only_non_final_charts_of_others_are_deleted(self, world):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        db = self.sessions()
        add_pool(db, 9)
        db.add(CoinStoryChartModel(mint=THIRD, lottery_id=9, window_start=NOW, window_end=NOW, final=False, fetched_at=NOW))
        db.add(CoinStoryChartModel(mint=OTHER, lottery_id=9, window_start=NOW, window_end=NOW, final=True, fetched_at=NOW))
        db.commit()
        found = cs.targets(self.sessions())
        assert sorted((target.mint, target.stay.lottery_id) for target in found) == sorted([(MINT, 1), (OTHER, 2)])
        assert self.row(THIRD, 9) is None, "a half-made chart of a coin gone from the bubbles"
        assert self.row(OTHER, 9) is not None, "a final chart stays: GeckoTerminal's history runs out"

    def test_a_finished_coin_is_final_a_quarter_of_an_hour_after_its_last_buy(self, world):
        self.run(LAST_BUY + timedelta(minutes=14))
        row = self.row(MINT, 1)
        assert row is not None and row.final is False, "fetched, not yet final: its last candles may still be coming"
        self.run(LAST_BUY + cs.FINAL_AFTER)
        row = self.row(MINT, 1)
        assert row.final is True and row.candles and row.pool_address == "CURVE"
        assert [b["signature"] for b in row.buys] == ["b1"] and (row.share_sol, row.refunded_sol) == (1.94, 0.04)
        assert row.window_end.replace(tzinfo=timezone.utc) == LAST_BUY + cs.PADDING
        fetched = row.fetched_at
        self.run(NOW + timedelta(days=30))
        assert self.row(MINT, 1).fetched_at == fetched, "a final chart is never asked again"

    def test_a_running_coin_every_five_minutes_while_taking_sol_three_while_buying(self, world):
        from domain.lottery.entities.lottery import LotteryStatus
        from infrastructure.database.models.lottery_model import LotteryModel

        start = NOW
        self.run(start)
        first = self.row(OTHER, 2)
        assert first is not None and first.final is False
        candle_calls = lambda: sum("/ohlcv/" in url and "/CURVE/" in url for url in self.fake.asked)  # noqa: E731
        before = candle_calls()
        self.run(start + cs.REFRESH_TAKING_SOL - timedelta(seconds=1))
        assert candle_calls() == before
        self.run(start + cs.REFRESH_TAKING_SOL)
        assert candle_calls() == before + 1
        db = self.sessions()
        db.query(LotteryModel).filter(LotteryModel.id == 2).update({"status": LotteryStatus.PROCEEDING_PURCHASES})
        db.commit()
        self.run(start + cs.REFRESH_TAKING_SOL + cs.REFRESH_BUYING)
        assert candle_calls() == before + 2, "while the pool buys, every three minutes"

    def test_without_the_buyers_feed_a_finished_coin_waits(self, world):
        def silent(pool):
            raise ConnectionError("buyer down")
        self.run(LAST_BUY + timedelta(hours=1), feed_of=silent)
        assert self.row(MINT, 1) is None, "its window ends at its last buy, which only the buyer knows"

    def test_nothing_for_a_final_chart_is_tried_three_times_an_hour_apart(self, world):
        self.fake.candles = {}
        at = LAST_BUY + cs.FINAL_AFTER
        self.run(at)
        assert (self.row(MINT, 1).final, self.row(MINT, 1).tries, self.row(MINT, 1).candles) == (True, 1, None)
        self.run(at + timedelta(minutes=30))
        assert self.row(MINT, 1).tries == 1
        for hour in (1, 2, 3, 4, 5):
            self.run(at + timedelta(hours=hour, minutes=1))
        assert self.row(MINT, 1).tries == cs.NOTHING_TRIES, "three tries, then it is left alone"

    def test_it_leaves_the_hover_chart_its_share_of_the_minute(self, world):
        found = cs.targets(self.sessions())
        for _ in range(gecko_budget.CALLS_PER_MINUTE - cs.LEAVES):
            self.budget.take()
        assert cs.run_once(found, self.gecko, self.budget, self.feeds.get, self.sessions, NOW) == 0
        assert self.fake.asked == [] and self.budget.left() == cs.LEAVES

    def test_a_chart_keeps_the_coins_supply_for_its_market_cap(self, world):
        found = cs.targets(self.sessions())
        cs.run_once(found, self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER,
                    supply_of=lambda mint: 999_999_000.5)
        assert self.row(MINT, 1).final is True and self.row(MINT, 1).supply == 999_999_000.5
        self.budget.reset()
        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, NOW,
                    supply_of=lambda mint: 123.0)
        assert self.row(OTHER, 2).final is False and self.row(OTHER, 2).supply == 123.0, "a running pool's chart has it too"

    def test_the_supply_before_the_pools_burn_wins_over_the_chains(self, world):
        """Read after the burn, the supply is smaller and the market cap before it would be too."""
        self.feeds[1] = {**self.FEED, "tokens": [{"mint": MINT, "targetSol": 1.94, "decimals": 6,
                                                   "burn": {"supplyAtStart": "1000000000000000"}}]}
        found = cs.targets(self.sessions())
        cs.run_once(found, self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER,
                    supply_of=lambda mint: 850_000_000.0)
        assert self.row(MINT, 1).supply == 1_000_000_000.0

    def test_a_final_chart_kept_without_its_supply_gets_it_and_spends_no_call(self, world):
        found = cs.targets(self.sessions())
        cs.run_once(found, self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER)
        assert self.row(MINT, 1).final is True and self.row(MINT, 1).supply is None
        asked = len(self.fake.asked)
        self.budget.reset()
        found = cs.targets(self.sessions())
        cs.run_once(found, self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER + timedelta(minutes=1),
                    supply_of=lambda mint: 1e9)
        assert self.row(MINT, 1).supply == 1e9
        assert not any(MINT in url for url in self.fake.asked[asked:]), "only the supply, never GeckoTerminal again"

    def test_a_final_chart_kept_without_the_empty_minutes_is_asked_again_once(self, world):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER)
        db = self.sessions()
        row = db.get(CoinStoryChartModel, (MINT, 1))
        assert row.candles_filled is True, "a new chart is asked with them"
        row.candles_filled, row.candles = False, [[1, 9, 9, 9, 9, 1.0]]
        db.commit()
        db.close()
        self.fake.candles = {"CURVE": [[int((LAST_BUY - timedelta(minutes=20)).timestamp()), 1, 2, 1, 2, 5.0],
                                       [int((LAST_BUY - timedelta(minutes=19)).timestamp()), 2, 2, 2, 2, 0.0]]}
        self.budget.reset()
        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, NOW)
        row = self.row(MINT, 1)
        assert row.candles_filled is True and len(row.candles) == 2 and row.final is True
        assert [b["signature"] for b in row.buys] == ["b1"], "its buys and share stay as they were"
        asked = len(self.fake.asked)
        self.budget.reset()
        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, NOW + timedelta(days=1))
        assert not any("/ohlcv/" in url for url in self.fake.asked[asked:] if MINT in url) and self.row(MINT, 1).candles_filled

    def test_nothing_back_from_the_second_ask_keeps_the_candles_there_were(self, world):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER)
        db = self.sessions()
        row = db.get(CoinStoryChartModel, (MINT, 1))
        kept = row.candles
        row.candles_filled = False
        db.commit()
        db.close()
        self.fake.candles = {}
        self.budget.reset()
        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, NOW)
        assert self.row(MINT, 1).candles == kept and self.row(MINT, 1).candles_filled is True

    def test_the_burn_is_kept_with_a_final_chart_and_filled_in_for_old_ones(self, world):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        self.feeds[1] = {**self.FEED, "tokens": [{"mint": MINT, "targetSol": 1.94, "decimals": 6, "burn": {"burnedRaw": "5000000"}}]}
        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, LAST_BUY + cs.FINAL_AFTER)
        assert self.row(MINT, 1).burned == 5.0
        db = self.sessions()
        db.get(CoinStoryChartModel, (MINT, 1)).burned = None
        db.commit()
        db.close()
        asked = len(self.fake.asked)
        self.budget.reset()
        cs.run_once(cs.targets(self.sessions()), self.gecko, self.budget, self.feeds.get, self.sessions, NOW)
        assert self.row(MINT, 1).burned == 5.0 and len(self.fake.asked) - asked <= 1, "no GeckoTerminal for the burn"

    def test_finished_coins_go_first(self, world):
        found = cs.targets(self.sessions())
        assert [target.mint for target in sorted(found, key=cs._order)] == [MINT, OTHER]


class TestTheEndpoint:
    @pytest.fixture
    def client(self, sessions, monkeypatch):
        from infrastructure.database.database import get_db
        from presentation.lottery import lottery_router as router
        from application.lottery import backed_coins as bc

        session = sessions()
        seed(session)
        session.close()
        self.sessions = sessions
        opened = []
        self.held = []
        self.fed = 0

        def get_test_db():
            s = sessions()
            opened.append(s)
            try:
                yield s
            finally:
                s.close()

        def feed(lottery_id):
            self.fed += 1
            self.held.append(any(s.in_transaction() for s in opened))
            return {"purchases": [{"mint": MINT, "solAmount": 0.39, "signature": "sig1", "at": ms(NOW - timedelta(days=1, minutes=5))}],
                    "tokens": [{"mint": MINT, "targetSol": 0.4}], "refunds": [{"mint": MINT, "sol": 0.01, "signature": "r1"}]}

        def never(url):
            raise AssertionError(f"a visitor's request reached GeckoTerminal: {url}")
        monkeypatch.setattr(router, "_gecko", cs.GeckoTerminal(never, budget=gecko_budget.Budget()))
        monkeypatch.setattr(router, "_cached_purchase_feed", feed)
        monkeypatch.setattr(router, "_made_on_pump", bc.MadeOnPumpCache(lambda mints: {m: True for m in mints}))
        api = FastAPI()
        api.include_router(router.router)
        api.dependency_overrides[get_db] = get_test_db
        return TestClient(api)

    def keep(self, final, candles=((1790000000, 1e-7, 2e-7, 1e-7, 2e-7, 5.0),), buys=None, share=None):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        db = self.sessions()
        db.add(CoinStoryChartModel(
            mint=MINT, lottery_id=2, window_start=NOW - timedelta(days=1, minutes=45), window_end=NOW - timedelta(days=1),
            pool_address="CURVE", candle_minutes=1, candles=[list(c) for c in candles] if candles else None,
            buys=buys, share_sol=share, refunded_sol=0.0, final=final, fetched_at=NOW - timedelta(minutes=2),
        ))
        db.commit()
        db.close()

    def test_before_the_first_fetch_the_chart_is_on_its_way(self, client):
        body = client.get(f"/lottery/coins/{MINT}/story").json()
        assert (body["lottery_id"], body["committed_sol"], body["finished"]) == (2, 20.0, True)
        assert body["trade_url"] == f"https://pump.fun/coin/{MINT}" and body["venue"] == "pump.fun"
        assert body["chart_state"] == "pending" and body["candles"] is None
        assert [b["signature"] for b in body["buys"]] == ["sig1"] and (body["share_sol"], body["refunded_sol"]) == (0.4, 0.01)
        assert body["left_at"].startswith("2026-10-17T11:55"), "its last buy"

    def test_a_final_chart_is_read_whole_and_the_buyer_is_not_asked(self, client):
        self.keep(final=True, buys=[{"at": "2026-10-17T11:50:00+00:00", "sol": 0.5, "signature": "kept1"}], share=0.52)
        body = client.get(f"/lottery/coins/{MINT}/story").json()
        assert self.fed == 0
        assert body["chart_state"] == "ready" and body["chart_final"] is True and len(body["candles"]) == 1
        assert body["chart_url"] == "https://www.geckoterminal.com/solana/pools/CURVE"
        assert [b["signature"] for b in body["buys"]] == ["kept1"] and body["share_sol"] == 0.52 and body["buys_known"] is True
        assert body["window_end"].startswith("2026-10-17T12:00")

    def test_the_burn_comes_with_a_final_chart_and_from_the_feed_for_a_running_one(self, client):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        assert client.get(f"/lottery/coins/{MINT}/story").json()["burned"] == 0.0, "the buyer knows the coin and burned none"
        self.keep(final=True, buys=[], share=0.5)
        db = self.sessions()
        db.get(CoinStoryChartModel, (MINT, 2)).burned = 79_863_241.98
        db.commit()
        db.close()
        assert client.get(f"/lottery/coins/{MINT}/story").json()["burned"] == 79_863_241.98

    def test_the_supply_comes_with_the_chart(self, client):
        from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel

        self.keep(final=True, buys=[], share=0.5)
        db = self.sessions()
        db.get(CoinStoryChartModel, (MINT, 2)).supply = 1e9
        db.commit()
        db.close()
        assert client.get(f"/lottery/coins/{MINT}/story").json()["supply"] == 1e9

    def test_a_chart_still_being_refreshed_comes_with_when_it_was_fetched(self, client):
        self.keep(final=False)
        body = client.get(f"/lottery/coins/{MINT}/story").json()
        assert body["chart_state"] == "ready" and body["chart_final"] is False
        assert body["chart_updated_at"].startswith("2026-10-18T11:58") and self.fed == 1

    def test_no_candles_kept_is_no_chart(self, client):
        self.keep(final=True, candles=None, buys=[], share=0.0)
        body = client.get(f"/lottery/coins/{MINT}/story").json()
        assert body["chart_state"] == "none" and body["candles"] is None and body["chart_url"] is None

    def test_the_buyer_is_asked_after_the_connection_is_back(self, client):
        client.get(f"/lottery/coins/{MINT}/story")
        assert self.held == [False]

    def test_anything_but_a_mint_and_a_coin_never_in_a_pool_are_404(self, client):
        assert client.get("/lottery/coins/not-a-mint/story").status_code == 404
        assert client.get(f"/lottery/coins/{OTHER}/story").status_code == 404

    def test_a_buyer_that_does_not_answer_is_not_known_buys_not_none(self, client, monkeypatch):
        from presentation.lottery import lottery_router as router

        monkeypatch.setattr(router, "_cached_purchase_feed", lambda lottery_id: None)
        body = client.get(f"/lottery/coins/{MINT}/story").json()
        assert body["buys"] == [] and body["buys_known"] is False and body["share_sol"] is None
