"""Red flags on a coin: the rule, its two halves, the queue and what the site gets.

The cases are the coins the rule was calibrated on, 127 live coins on
2026-10-02 (`shared/coin_screening.py`): a creator with 79% of the supply, coins
whose launch bundlers still held a share, the large coins every top-ten rule
flags, PUMP with its transfer hook, pump.fun's Mayhem Mode coins with a billion
tokens on the protocol's agent. And Krackpot (7vG1Dr…NB7i), which the first
version of the rule called clean while pump.fun showed its bundlers at 30% and
its top ten at 28%: 79 bundled wallets had bought 78.5% at launch.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from solders.pubkey import Pubkey  # noqa: E402

from mint_validator import TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, mint_red_flags  # noqa: E402
from shared import coin_screening as cs  # noqa: E402
from shared import coin_screening_store as store  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)


def fixture_account(file: str, name: str) -> tuple[Pubkey, bytes]:
    with open(os.path.join(FIXTURES, file), encoding="utf-8") as handle:
        account = json.load(handle)[name]
    return Pubkey.from_string(account["owner"]), base64.b64decode(account["data_base64"])


# ------------------------------------------------------------ the mint itself

KEY = bytes(range(1, 33))


def mint_bytes(*, mint_authority=False, freeze_authority=False, extensions=()):
    """A mint account laid out as `MintLayout`, with Token-2022 TLV extensions after byte 165."""
    data = bytearray(82)
    if mint_authority:
        data[0:4] = (1).to_bytes(4, "little")
        data[4:36] = KEY
    data[44] = 6       # decimals
    data[45] = 1       # is_initialized
    if freeze_authority:
        data[46:50] = (1).to_bytes(4, "little")
        data[50:82] = KEY
    if not extensions:
        return bytes(data)
    data.extend(bytes(165 - 82))
    data.append(1)     # account type: mint
    for ext_type, value in extensions:
        data.extend(ext_type.to_bytes(2, "little") + len(value).to_bytes(2, "little") + value)
    return bytes(data)


METADATA_POINTER = (18, bytes(64))


class TestTheMintsOwnFlags:
    def test_real_coins_carry_none(self):
        # pump.fun's Token-2022 coin and BONK, whose revoked mint authority
        # still leaves the old key's bytes in the account: the option flag is
        # what counts, not the bytes.
        assert mint_red_flags(*fixture_account("mint_accounts.json", "token2022_pumpfun")) == []
        assert mint_red_flags(*fixture_account("mint_accounts.json", "legacy_bonk")) == []
        # A Mayhem Mode coin: two billion supply, nothing but metadata.
        assert mint_red_flags(*fixture_account("screening_mints.json", "pumpfun_mayhem_mode")) == []
        # PUMP has a transfer hook, and a transfer hook is not a flag.
        assert mint_red_flags(*fixture_account("screening_mints.json", "pump_token_transfer_hook")) == []

    def test_authorities(self):
        assert mint_red_flags(TOKEN_PROGRAM_ID, mint_bytes(freeze_authority=True)) == ["freeze_authority"]
        assert mint_red_flags(TOKEN_PROGRAM_ID, mint_bytes(mint_authority=True)) == ["mint_authority"]
        assert mint_red_flags(TOKEN_2022_PROGRAM_ID, mint_bytes(mint_authority=True, freeze_authority=True, extensions=[METADATA_POINTER])) == ["freeze_authority", "mint_authority"]

    @pytest.mark.parametrize("extension, flag", [
        ((12, KEY), "permanent_delegate"),
        ((9, b""), "non_transferable"),
        ((6, bytes([2])), "frozen_by_default"),
        ((26, KEY + b"\x00"), "pausable"),
        ((26, bytes(32) + b"\x01"), "pausable"),
    ])
    def test_extensions_that_take_power_over_holders(self, extension, flag):
        assert mint_red_flags(TOKEN_2022_PROGRAM_ID, mint_bytes(extensions=[METADATA_POINTER, extension])) == [flag]

    @pytest.mark.parametrize("extension", [
        (12, bytes(32)),             # a permanent delegate slot with nobody in it
        (6, bytes([1])),             # new accounts start initialized
        (26, bytes(32) + b"\x00"),   # pausable with no authority, not paused
        (14, KEY + KEY),             # a transfer hook
        (1, bytes(108)),             # a transfer fee
    ])
    def test_extensions_that_do_not(self, extension):
        assert mint_red_flags(TOKEN_2022_PROGRAM_ID, mint_bytes(extensions=[METADATA_POINTER, extension])) == []

    def test_not_a_mint(self):
        assert mint_red_flags(Pubkey.from_string("11111111111111111111111111111111"), mint_bytes()) is None
        assert mint_red_flags(TOKEN_PROGRAM_ID, b"\x00" * 40) is None
        uninitialised = bytearray(mint_bytes())
        uninitialised[45] = 0
        assert mint_red_flags(TOKEN_PROGRAM_ID, bytes(uninitialised)) is None


# ------------------------------------------------------- the pump.fun curve

class CurveRpc:
    """Answers `get_account` from a dict by address; raises what it is told to."""

    def __init__(self, accounts=None, error=None):
        self.accounts = accounts or {}
        self.error = error
        self.asked = []

    async def get_account(self, address):
        self.asked.append(address)
        if self.error:
            raise self.error
        return self.accounts.get(address)


def curve_fixture(name):
    with open(os.path.join(FIXTURES, "screening_mints.json"), encoding="utf-8") as handle:
        account = json.load(handle)[name]
    return account["mint"], account["address"], (account["owner"], base64.b64decode(account["data_base64"]))


class TestOnTheCurve:
    """Where the top ten and liquidity rules apply: read from the chain, mainnet accounts of 2026-10-02."""

    def test_krackpot_is_on_its_curve(self):
        mint, curve, account = curve_fixture("pumpfun_curve_live")
        rpc = CurveRpc({curve: account})
        assert asyncio.run(cs.read_curve(rpc, mint)) is True
        assert rpc.asked == [curve], "the curve's address is derived as pump.fun derives it"

    def test_a_graduated_coin_is_not(self):
        mint, curve, account = curve_fixture("pumpfun_curve_graduated")
        assert asyncio.run(cs.read_curve(CurveRpc({curve: account}), mint)) is False

    def test_a_coin_with_no_curve_is_not(self):
        mint, _curve, _account = curve_fixture("pumpfun_curve_live")
        assert asyncio.run(cs.read_curve(CurveRpc({}), mint)) is False

    def test_an_account_pump_fun_does_not_own_is_not_a_curve(self):
        mint, curve, (_owner, data) = curve_fixture("pumpfun_curve_live")
        assert asyncio.run(cs.read_curve(CurveRpc({curve: ("11111111111111111111111111111111", data)}), mint)) is False

    def test_no_answer_is_unknown(self):
        from shared.solana_rpc import SolanaRpcTransportError

        mint, _curve, _account = curve_fixture("pumpfun_curve_live")
        assert asyncio.run(cs.read_curve(CurveRpc(error=SolanaRpcTransportError("timeout")), mint)) is None


# ------------------------------------------------------------- the providers

class TestBothPathsGiveTheSameLevels:
    """Solana Tracker read directly is cut exactly as tracced cuts it."""

    @pytest.mark.parametrize("rule, value, expected", [
        ("dev", 4.99, "low"), ("dev", 5, "medium"), ("dev", 20, "medium"), ("dev", 20.01, "high"),
        ("bundle", 20, "medium"), ("bundle", 20.5, "high"),
        ("top10", 40, "medium"), ("top10", 40.1, "high"),
        ("insiders", 15, "medium"), ("insiders", 15.01, "high"),
        ("bundled_launch", 19.9, "low"), ("bundled_launch", 50, "medium"), ("bundled_launch", 78.5, "high"),
        ("dev", None, "unknown"), ("dev", True, "unknown"), ("dev", 250, "high"),
    ])
    def test_cuts(self, rule, value, expected):
        assert cs.level(rule, value) == expected

    def test_a_solana_tracker_body(self):
        body = {
            "token": {"creation": {"created_time": 1_000_000}},
            "risk": {"dev": {"percentage": 79.45}, "bundlers": {"totalPercentage": 31, "totalInitialPercentage": 78.53}, "top10": 88,
                     "insiders": {"totalPercentage": 2}, "rugged": False},
        }
        view = cs.holders_from_solana_tracker(body, now_s=1_000_000 + 600)
        assert (view.dev, view.bundle, view.top10, view.insiders, view.rugged) == ("high", "high", "high", "low", False)
        assert view.bundled_launch == "high"
        assert view.levels() == {"dev": "high", "bundle": "high", "bundled_launch": "high", "top10": "high", "insiders": "low"}
        assert view.age_minutes == 10
        assert view.source == "solana_tracker"
        assert cs.holders_from_solana_tracker({"token": {}, "risk": {}}) is None

    def test_a_tracced_body(self):
        body = {"passes": False, "failed": ["no_data", "top10"], "levels": {
            "dev": "low", "bundle": "unknown", "top10": "medium", "snipers": "low", "insiders": "low",
            "bundled_launch": "unknown", "mint": "low", "freeze": "low", "liquidity": "low"}, "age_minutes": None}
        view = cs.holders_from_tracced(body)
        assert (view.dev, view.bundle, view.top10, view.insiders, view.rugged) == ("low", "unknown", "medium", "low", False)
        assert view.missing() == ["bundle", "bundled_launch"]
        assert cs.holders_from_tracced({"error": "x"}) is None


def holders(dev="low", bundle="low", top10="low", insiders="low", rugged=False, age=60.0, source="tracced", bundled_launch="low"):
    return cs.HolderView(dev, bundle, top10, insiders, rugged, age, source, bundled_launch)


# ------------------------------------------------------------------ the rule

class TestTheRule:
    def test_a_creator_with_most_of_the_supply(self):
        # PUBG: 79% with the creator per RugCheck, bundles over 20% per tracced.
        decision = cs.decide([], holders(dev="high", bundle="high", top10="high"), on_curve=False)
        assert decision.status == "flagged"
        assert decision.reasons == ["creator_over_20", "bundles_over_20"]
        assert decision.source == "tracced"

    def test_krackpot_at_the_first_commit(self):
        # Bundlers at 30% and the top ten at 28%, both red on pump.fun: the
        # first rule wanted the top ten over 40% as well and called it clean.
        decision = cs.decide([], holders(bundle="high", top10="medium", bundled_launch="high"), on_curve=True)
        assert decision.reasons == ["bundles_over_20"]

    def test_krackpot_after_the_bundlers_sold_most_of_it(self):
        # 78.5% bought by 79 bundled wallets at launch, 10% still with them.
        decision = cs.decide([], holders(bundle="medium", bundled_launch="high"), on_curve=True)
        assert decision.reasons == ["bundled_launch"]

    def test_a_bundled_launch_whose_bundlers_left(self):
        # Over half the supply bundled at launch on 62 of 127 live coins, GOIF,
        # UDR and AROS among them. Bundlers gone, it says nothing.
        assert cs.decide([], holders(bundle="low", bundled_launch="high"), on_curve=False).status == "clean"
        assert cs.decide([], holders(bundle="unknown", bundled_launch="high"), on_curve=False).status == "clean"

    def test_bundlers_over_20_off_the_curve_too(self):
        # JEANPHIL and VSOF: bundlers over 20% on coins worth millions.
        assert cs.decide([], holders(bundle="high", top10="low"), on_curve=False).reasons == ["bundles_over_20"]

    def test_linked_wallets(self):
        assert cs.decide([], holders(insiders="high"), on_curve=False).reasons == ["insiders_over_15"]
        assert cs.decide([], holders(insiders="medium"), on_curve=False).status == "clean"

    def test_the_top_ten_counts_on_the_curve_only(self):
        assert cs.decide([], holders(top10="high"), on_curve=True).reasons == ["top10_over_40_on_curve"]
        # Over 20% on the curve was a quarter of all fresh coins.
        assert cs.decide([], holders(top10="medium"), on_curve=True).status == "clean"
        # PUMP, BONK, WIF: exchanges and vesting in the top ten.
        assert cs.decide([], holders(top10="high", bundle="unknown"), on_curve=False).status == "clean"
        # A curve not read is not a curve.
        assert cs.decide([], holders(top10="high"), on_curve=None).status == "clean"

    def test_liquidity_counts_off_the_curve_only(self):
        # A pump.fun curve cannot be pulled; `rugged` on one means sold out.
        assert cs.decide([], holders(rugged=True), on_curve=True).status == "clean"
        assert cs.decide([], holders(rugged=True), on_curve=False).reasons == ["liquidity_pulled"]
        assert cs.decide([], holders(rugged=True), on_curve=None).status == "clean"

    def test_the_mint_alone_is_enough_to_flag(self):
        decision = cs.decide(["freeze_authority", "permanent_delegate"], None)
        assert decision.status == "flagged"
        assert decision.reasons == ["freeze_authority", "permanent_delegate"]
        assert decision.source == "chain"

    def test_reasons_come_in_one_order(self):
        decision = cs.decide(["pausable", "mint_authority"], holders(dev="high", rugged=True, insiders="high"), on_curve=False)
        assert decision.reasons == ["creator_over_20", "insiders_over_15", "liquidity_pulled", "mint_authority", "pausable"]

    def test_clean_needs_both_halves(self):
        assert cs.decide([], None).status is None              # no holder data
        assert cs.decide(None, holders()).status is None       # mint not read
        assert cs.decide([], holders(dev="unknown")).status is None


# ------------------------------------------------------------- one try

def answer(kind="answer", view=None, code=200):
    return cs.ProviderAnswer(kind, view if view is not None or kind != "answer" else holders(), code)


READ = cs.ChainRead("read", [])


class TestOneTry:
    def test_clean_and_flagged_end_it(self):
        clean = store.judge(READ, answer(view=holders(bundle="unknown")), NOW, on_curve=False)
        assert (clean.status, clean.missing, clean.source, clean.on_curve) == ("clean", ["bundle"], "tracced", False)
        assert clean.levels == {"dev": "low", "bundle": "unknown", "bundled_launch": "low", "top10": "low", "insiders": "low"}
        krackpot = store.judge(READ, answer(view=holders(bundle="medium", bundled_launch="high")), NOW, on_curve=True)
        assert (krackpot.status, krackpot.reasons, krackpot.on_curve) == ("flagged", ["bundled_launch"], True)
        assert krackpot.levels["bundled_launch"] == "high"
        flagged = store.judge(cs.ChainRead("read", ["mint_authority"]), answer("failed", code=502), NOW)
        assert (flagged.status, flagged.reasons, flagged.source) == ("flagged", ["mint_authority"], "chain")

    def test_a_coin_seconds_old_waits(self):
        outcome = store.judge(READ, answer(view=holders(age=0.5)), NOW)
        assert outcome.status == "retry"
        assert timedelta(minutes=1.5) <= outcome.retry_at - NOW <= timedelta(minutes=1.6)

    def test_the_mints_own_flag_does_not_wait_for_age(self):
        # The mint's powers do not change with age; the holdings of a coin half a
        # minute old are not read at all, even when they look damning.
        outcome = store.judge(cs.ChainRead("read", ["freeze_authority"]), answer(view=holders(age=0.5, dev="high")), NOW)
        assert (outcome.status, outcome.reasons, outcome.source) == ("flagged", ["freeze_authority"], "chain")
        assert store.judge(cs.ChainRead("read", ["freeze_authority"]), answer("failed", code=503), NOW).status == "flagged"
        assert store.judge(READ, answer(view=holders(age=0.5, dev="high")), NOW).status == "retry"

    def test_no_such_mint_ends_it(self):
        assert store.judge(cs.ChainRead("missing"), answer("no_data", code=None), NOW).status == "unavailable"

    def test_no_data_on_the_coin_ends_it(self):
        assert store.judge(READ, answer("no_data", code=404), NOW).status == "unavailable"
        assert store.judge(READ, answer(view=holders(dev="unknown", bundle="unknown", top10="unknown", insiders="unknown")), NOW).status == "unavailable"

    def test_no_answer_is_tried_again(self):
        assert store.judge(READ, answer("failed", code=502), NOW).status == "retry"
        assert store.judge(READ, answer("rejected", code=403), NOW).status == "retry"
        assert store.judge(cs.ChainRead("failed"), answer(), NOW).status == "retry"


# ------------------------------------------------------------- the providers in turn

class _Response:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _Http:
    def __init__(self, answers):
        self.answers = answers
        self.asked = []

    async def get(self, url, params=None, headers=None):
        self.asked.append(url)
        result = self.answers[url.split("/")[2]]
        if isinstance(result, Exception):
            raise result
        return result


TRACCED_BODY = {"failed": [], "levels": {"dev": "low", "bundle": "low", "top10": "low", "insiders": "low"}, "age_minutes": 30}
ST_BODY = {"token": {"creation": {"created_time": 1}}, "risk": {"dev": {"percentage": 1}, "bundlers": {"totalPercentage": 1}, "top10": 5, "insiders": {"totalPercentage": 0}}}


class TestTheFallbacksDailyAllowance:
    """2,500 requests a month on Solana Tracker's free plan: about 80 a day."""

    DAY = 1_790_899_200  # 2026-10-02 00:00 UTC

    def test_it_stops_at_the_days_limit_and_starts_again_tomorrow(self):
        budget = cs.DailyBudget(3)
        for _ in range(3):
            assert budget.available(self.DAY + 60)
            budget.spend(self.DAY + 60)
        assert not budget.available(self.DAY + 3600)
        assert budget.available(self.DAY + 86_400 + 1)

    def test_a_429_spends_out_the_day(self):
        budget = cs.DailyBudget(80)
        budget.spent_out(self.DAY + 10)
        assert not budget.available(self.DAY + 20)
        assert budget.available(self.DAY + 86_400 + 1)

    def test_zero_means_never(self):
        assert not cs.DailyBudget(0).available(self.DAY)


class TestProvidersInTurn:
    def run(self, http, tracced="t", solana_tracker="s"):
        return asyncio.run(cs.ask_providers(http, "Mint", tracced_key=tracced, solana_tracker_key=solana_tracker))

    def test_tracced_answers(self):
        http = _Http({"tracced.xyz": _Response(200, TRACCED_BODY), "data.solanatracker.io": _Response(200, ST_BODY)})
        result, attempts = self.run(http)
        assert result.holders.source == "tracced" and len(http.asked) == 1
        assert [name for name, _ in attempts] == ["tracced"]

    def test_tracced_down_or_refusing_falls_back(self):
        import httpx

        for failure in (_Response(503), _Response(429), _Response(403), httpx.ConnectTimeout("slow")):
            http = _Http({"tracced.xyz": failure, "data.solanatracker.io": _Response(200, ST_BODY)})
            result, attempts = self.run(http)
            assert result.kind == "answer" and result.holders.source == "solana_tracker", failure
            assert [name for name, _ in attempts] == ["tracced", "solana_tracker"]

    def test_no_data_is_not_asked_twice(self):
        # tracced reads Solana Tracker: a coin one does not know, the other does not either.
        http = _Http({"tracced.xyz": _Response(404), "data.solanatracker.io": _Response(200, ST_BODY)})
        result, _ = self.run(http)
        assert result.kind == "no_data" and len(http.asked) == 1

    def test_without_keys(self):
        result, attempts = self.run(_Http({}), tracced=None, solana_tracker=None)
        assert result.kind == "failed" and attempts == []
        http = _Http({"data.solanatracker.io": _Response(200, ST_BODY)})
        result, _ = self.run(http, tracced=None)
        assert result.holders.source == "solana_tracker"


# ------------------------------------------------------------- the queue

@pytest.fixture
def db():
    from infrastructure.database.database import Base
    from infrastructure.database.models.bet_participation_model import BetParticipationModel
    from infrastructure.database.models.coin_screening_model import CoinScreeningModel
    from infrastructure.database.models.lottery_model import LotteryModel
    from infrastructure.database.models.user_model import UserModel  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, BetParticipationModel.__table__, CoinScreeningModel.__table__])
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX uq_lotteries_open_by_type"))
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def add_pool(db, pool_id, status="CREATED"):
    from domain.lottery.entities.lottery import LotteryStatus
    from infrastructure.database.models.lottery_model import LotteryModel

    db.add(LotteryModel(id=pool_id, name=f"pool {pool_id}", created_by_user_id=1, status=getattr(LotteryStatus, status), lottery_type="dex"))
    db.commit()


def add_commit(db, pool_id, mint, at, status="confirmed"):
    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    db.add(BetParticipationModel(user_id=1, lottery_id=pool_id, meme_coin_address=mint, sol_amount=0.1,
                                 wallet_address="W", confirmation_status=status, created_at=at))
    db.commit()


class TestTheQueue:
    def test_one_check_per_coin_per_pool_from_the_first_commit(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel

        add_pool(db, 1)
        add_pool(db, 2, "CLOSED")
        add_commit(db, 1, "AAA", NOW - timedelta(minutes=10))
        add_commit(db, 1, "AAA", NOW - timedelta(minutes=5))
        add_commit(db, 1, "BBB", NOW - timedelta(minutes=3), status="orphaned")
        add_commit(db, 2, "AAA", NOW - timedelta(hours=5))       # bought long ago
        assert store.enqueue_new(db, NOW) == 1
        assert store.enqueue_new(db, NOW) == 0                   # once
        row = db.query(CoinScreeningModel).one()
        assert (row.lottery_id, row.mint, row.status) == (1, "AAA", "pending")
        assert row.first_commit_at.replace(tzinfo=timezone.utc) == NOW - timedelta(minutes=10)

        add_pool(db, 3)
        add_commit(db, 3, "AAA", NOW - timedelta(minutes=1))     # the next pool checks again
        assert store.enqueue_new(db, NOW) == 1

    def test_tries_until_an_answer_then_stops(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel

        add_pool(db, 1)
        add_commit(db, 1, "AAA", NOW - timedelta(minutes=1))
        store.enqueue_new(db, NOW)
        replies = [(READ, answer("failed", code=502), True), (READ, answer(view=holders(dev="high")), True)]

        async def check(mint):
            return replies.pop(0)

        assert asyncio.run(store.run_due(db, NOW, check)) == 1
        row = db.query(CoinScreeningModel).one()
        assert row.status == "pending" and row.attempts == 1
        assert row.next_attempt_at.replace(tzinfo=timezone.utc) == NOW + timedelta(seconds=30)
        assert asyncio.run(store.run_due(db, NOW, check)) == 0          # not due yet

        later = NOW + timedelta(seconds=31)
        assert asyncio.run(store.run_due(db, later, check)) == 1
        db.refresh(row)
        assert (row.status, row.reasons, row.source, row.on_curve) == ("flagged", ["creator_over_20"], "tracced", True)
        assert row.levels["dev"] == "high"
        assert asyncio.run(store.run_due(db, later + timedelta(hours=1), check)) == 0  # checked once

    def test_pauses_grow_and_it_gives_up(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel

        row = CoinScreeningModel(lottery_id=1, mint="AAA", status="pending", reasons=[], missing=[],
                                 first_commit_at=NOW, attempts=0, next_attempt_at=NOW)
        pauses = []
        for _ in range(7):
            store.record(row, store.Outcome("retry"), NOW)
            pauses.append(row.next_attempt_at - NOW)
        assert pauses[:5] == list(store.RETRY_PAUSES)
        assert pauses[5:] == [store.RETRY_PAUSES[-1]] * 2
        store.record(row, store.Outcome("retry"), NOW + store.GIVE_UP_AFTER)
        assert row.status == "unavailable"

    def test_a_crashing_check_does_not_stop_the_queue(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel

        add_pool(db, 1)
        add_commit(db, 1, "AAA", NOW - timedelta(minutes=2))
        add_commit(db, 1, "BBB", NOW - timedelta(minutes=2))
        store.enqueue_new(db, NOW)

        async def check(mint):
            if mint == "AAA":
                raise RuntimeError("boom")
            return READ, answer(), False

        assert asyncio.run(store.run_due(db, NOW, check)) == 2
        statuses = {row.mint: row.status for row in db.query(CoinScreeningModel).all()}
        assert statuses == {"AAA": "pending", "BBB": "clean"}


# ------------------------------------------------------------- what the site gets

class TestWhatTheSiteGets:
    def test_only_answers_are_shown(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel
        from presentation.lottery.lottery_router import _open_pool_screening, _pool_screenings

        add_pool(db, 1)
        for mint, status, reasons in (("AAA", "clean", []), ("BBB", "flagged", ["creator_over_20"]),
                                      ("CCC", "pending", []), ("DDD", "unavailable", [])):
            db.add(CoinScreeningModel(lottery_id=1, mint=mint, status=status, reasons=reasons, missing=[], source="tracced",
                                      first_commit_at=NOW, checked_at=None if status == "pending" else NOW, attempts=1, next_attempt_at=NOW))
        db.commit()
        db.query(CoinScreeningModel).filter(CoinScreeningModel.mint == "BBB").update(
            {"levels": {"dev": "high", "bundle": "low"}, "on_curve": True})
        db.commit()
        shown = _pool_screenings(db, 1)
        assert sorted(shown) == ["AAA", "BBB"]
        assert shown["BBB"].levels == {"dev": "high", "bundle": "low"} and shown["BBB"].on_curve is True
        assert shown["AAA"].levels == {} and shown["AAA"].on_curve is None  # a check from before levels were kept
        assert shown["BBB"].status == "flagged" and shown["BBB"].reasons == ["creator_over_20"]
        assert _open_pool_screening(db, "BBB").status == "flagged"
        assert _open_pool_screening(db, "CCC") is None

    def test_an_odd_row_costs_its_own_mark_never_the_pool(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel
        from presentation.lottery.lottery_router import _pool_screenings

        add_pool(db, 1)
        for mint in ("AAA", "BBB"):
            db.add(CoinScreeningModel(lottery_id=1, mint=mint, status="clean", reasons=[], missing=[], source="tracced",
                                      first_commit_at=NOW, checked_at=NOW, attempts=1, next_attempt_at=NOW))
        db.commit()
        # JSON the API cannot turn into levels: a list where a mapping belongs.
        db.query(CoinScreeningModel).filter(CoinScreeningModel.mint == "AAA").update({"levels": ["dev", "high"]})
        db.commit()
        shown = _pool_screenings(db, 1)
        assert sorted(shown) == ["BBB"]

    def test_a_closed_pool_says_nothing_to_the_dialog(self, db):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel
        from presentation.lottery.lottery_router import _open_pool_screening

        add_pool(db, 1, "CLOSED")
        db.add(CoinScreeningModel(lottery_id=1, mint="AAA", status="flagged", reasons=["mint_authority"], missing=[], source="chain",
                                  first_commit_at=NOW, checked_at=NOW, attempts=1, next_attempt_at=NOW))
        db.commit()
        assert _open_pool_screening(db, "AAA") is None

    def test_the_schema_carries_it(self):
        from application.lottery.schemas import CoinResponse, CoinScreeningResponse, LotteryEntryResponse, MintAllowTokenResponse

        screening = CoinScreeningResponse(status="flagged", reasons=["creator_over_20"], source="tracced", checked_at=NOW)
        entry = LotteryEntryResponse(rank=1, lottery_id=1, coin=CoinResponse(name="a", symbol="A", address="x", market_cap=0,
                                     current_price=0, price_history=[], volume_24h=0), total_solana_bet=1, bet_count=1, screening=screening)
        assert entry.model_dump()["screening"]["reasons"] == ["creator_over_20"]
        assert MintAllowTokenResponse(is_pumpfun_mint=True, mint_address="m", network_type="mainnet").screening is None
        with pytest.raises(Exception):
            CoinScreeningResponse(status="pending", checked_at=NOW)

    def test_every_reason_has_words_on_the_site(self):
        """A new reason code has to be worded in the site's module as well."""
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        with open(os.path.join(root, "ui", "src", "app", "shared", "coin-screening", "coin-screening.ts"), encoding="utf-8") as handle:
            source = handle.read()
        missing = [reason for reason in cs.REASONS if f"{reason}:" not in source]
        assert missing == []


# ------------------------------------------------------- off on a server

class TestTheSwitch:
    """COIN_SCREENING_ENABLED=false: off on mainnet since 2026-10-03, on the stand still on."""

    @pytest.mark.parametrize("value, enabled", [(None, True), ("", True), ("true", True), ("1", True),
                                                ("false", False), ("False", False), ("0", False), ("off", False), ("no", False)])
    def test_the_values(self, monkeypatch, value, enabled):
        if value is None:
            monkeypatch.delenv("COIN_SCREENING_ENABLED", raising=False)
        else:
            monkeypatch.setenv("COIN_SCREENING_ENABLED", value)
        assert cs.screening_enabled() is enabled

    def test_off_the_site_shows_nothing_even_with_answers_in_the_table(self, db, monkeypatch):
        from infrastructure.database.models.coin_screening_model import CoinScreeningModel
        from presentation.lottery.lottery_router import _pool_screenings, _screening_for_dialog

        add_pool(db, 1)
        db.add(CoinScreeningModel(lottery_id=1, mint="AAA", status="flagged", reasons=["creator_over_20"], missing=[], source="tracced",
                                  first_commit_at=NOW, checked_at=NOW, attempts=1, next_attempt_at=NOW))
        db.commit()
        monkeypatch.setenv("COIN_SCREENING_ENABLED", "true")
        assert list(_pool_screenings(db, 1)) == ["AAA"] and _screening_for_dialog(db, "AAA") is not None

        monkeypatch.setenv("COIN_SCREENING_ENABLED", "false")
        assert _pool_screenings(db, 1) == {}
        assert _screening_for_dialog(db, "AAA") is None

    def test_off_the_worker_asks_no_provider(self, monkeypatch):
        import asyncio
        import importlib

        workers = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "workers")
        sys.path.insert(0, workers)
        try:
            worker = importlib.import_module("coin_screening_worker")
        finally:
            sys.path.remove(workers)
        monkeypatch.setenv("COIN_SCREENING_ENABLED", "false")
        monkeypatch.setattr(worker, "setup_logging", lambda: None)
        monkeypatch.setattr(worker, "SolanaJsonRpc", lambda *a, **k: pytest.fail("no node is read when the check is off"))
        monkeypatch.setattr(worker, "run_once", lambda *a, **k: pytest.fail("nothing is checked when the check is off"))

        async def run_and_stop():
            task = asyncio.create_task(worker.main())
            await asyncio.sleep(0.2)
            assert not task.done(), "it stays up instead of exiting, or compose would restart it in a loop"
            task.cancel()

        asyncio.run(run_and_stop())
