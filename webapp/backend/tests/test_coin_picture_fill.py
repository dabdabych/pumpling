"""A coin's picture is looked for after a commit to it, on a schedule, until found.

TOILETDOG on the stand, 2026-10-02: committed to at 15:27 with no picture
anywhere. The old in-memory queue tried while the pool was on screen, every
half hour, and the stand's pool closed within minutes. DexScreener had the
picture an hour later; nothing asked again. Here the schedule lives in the
database and does not care whether the pool is still open.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import coin_picture_fill as fill  # noqa: E402

NOW = datetime(2026, 10, 2, 16, 0, tzinfo=timezone.utc)
TOILETDOG = "4jdKhCf5TifzDEZN39gXzcoDMEpTARy99WPSGNGopump"
PICTURE = "https://cdn.dexscreener.com/cms/images/LiCxN5fo8--7kbfr"


@pytest.fixture
def db():
    from infrastructure.database.database import Base
    from infrastructure.database.models.bet_participation_model import BetParticipationModel
    from infrastructure.database.models.lottery_model import LotteryModel
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel
    from infrastructure.database.models.user_model import UserModel  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, BetParticipationModel.__table__, TokenMetadataModel.__table__])
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX uq_lotteries_open_by_type"))
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def commit(db, mint, at, status="confirmed", pool_status="CLOSED"):
    from domain.lottery.entities.lottery import LotteryStatus
    from infrastructure.database.models.bet_participation_model import BetParticipationModel
    from infrastructure.database.models.lottery_model import LotteryModel

    if db.get(LotteryModel, 1) is None:
        db.add(LotteryModel(id=1, name="pool", created_by_user_id=1, status=getattr(LotteryStatus, pool_status), lottery_type="dex"))
    db.add(BetParticipationModel(user_id=1, lottery_id=1, meme_coin_address=mint, sol_amount=0.1, wallet_address="W",
                                 confirmation_status=status, created_at=at))
    db.commit()


def searched(db, mint, name="TOILETDOG", logo=None):
    """What a coin search leaves behind: the name, no picture yet."""
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel

    db.add(TokenMetadataModel(mint=mint, name=name, symbol=name, logo_url=logo))
    db.commit()


def row(db, mint):
    from infrastructure.database.models.token_metadata_model import TokenMetadataModel

    db.expire_all()
    return db.get(TokenMetadataModel, mint)


class Sources:
    """The sources as the fill sees them: a picture from a given try on, and who was asked to pay."""

    def __init__(self, picture_from_try=None):
        self.picture_from_try = picture_from_try
        self.calls = []

    def __call__(self, mint, may_pay):
        self.calls.append(may_pay)
        has = self.picture_from_try is not None and len(self.calls) >= self.picture_from_try
        return {"token_name": "TOILETDOG", "token_symbol": "TOILETDOG", "token_image_url": PICTURE if has else None}


def run_until(db, sources, start, hours):
    """Run the loop every 20 s, as the thread does, for this long."""
    now = start
    while now < start + timedelta(hours=hours):
        fill.run_once(db, now, sources)
        now += timedelta(seconds=fill.POLL_SECONDS)
    return now


def test_toiletdog_gets_its_picture_after_its_pool_closed(db):
    commit(db, TOILETDOG, NOW - timedelta(minutes=1), pool_status="CLOSED")
    searched(db, TOILETDOG)
    # No picture for the first three tries (about eight minutes), then DexScreener has it.
    sources = Sources(picture_from_try=4)

    run_until(db, sources, NOW, hours=1)

    assert row(db, TOILETDOG).logo_url == PICTURE
    assert len(sources.calls) == 4, "found on the fourth try, and not asked again"


def test_the_schedule_and_its_end(db):
    commit(db, TOILETDOG, NOW, pool_status="CLOSED")
    searched(db, TOILETDOG)
    sources = Sources(picture_from_try=None)

    run_until(db, sources, NOW, hours=23)

    assert len(sources.calls) == fill.MAX_ATTEMPTS == 9, "nine tries, then it stops"
    assert row(db, TOILETDOG).logo_next_attempt_at is None and row(db, TOILETDOG).logo_attempts == 9
    total = sum(pause.total_seconds() for pause in fill.PAUSES) / 3600
    assert 8 <= total <= 12, f"about ten hours of looking ({total:.1f} h)"


def test_the_paid_lookup_twice_at_most(db):
    commit(db, TOILETDOG, NOW)
    searched(db, TOILETDOG)
    sources = Sources(picture_from_try=None)

    run_until(db, sources, NOW, hours=23)

    assert sources.calls.count(True) == 2
    assert [i + 1 for i, paid in enumerate(sources.calls) if paid] == [1, 4]


def test_the_first_try_comes_right_after_the_commit(db):
    commit(db, TOILETDOG, NOW)
    searched(db, TOILETDOG)
    sources = Sources(picture_from_try=1)

    fill.run_once(db, NOW, sources)

    assert row(db, TOILETDOG).logo_url == PICTURE


def test_a_coin_nobody_searched_gets_a_row(db):
    commit(db, TOILETDOG, NOW)
    fill.run_once(db, NOW, Sources(picture_from_try=1))
    assert (row(db, TOILETDOG).name, row(db, TOILETDOG).logo_url) == ("TOILETDOG", PICTURE)


def test_not_before_a_commit_is_confirmed(db):
    commit(db, TOILETDOG, NOW, status="pending")
    searched(db, TOILETDOG)
    sources = Sources(picture_from_try=1)

    fill.run_once(db, NOW, sources)

    assert sources.calls == [] and row(db, TOILETDOG).logo_url is None


def test_coins_with_a_picture_or_an_old_commit_are_left_alone(db):
    commit(db, TOILETDOG, NOW - timedelta(days=2))
    searched(db, TOILETDOG)
    other = "Other111111111111111111111111111111111111pump"
    commit(db, other, NOW)
    searched(db, other, name="OTHER", logo="https://example.com/other.png")
    sources = Sources(picture_from_try=1)

    fill.run_once(db, NOW, sources)

    assert sources.calls == []


def test_a_name_from_the_search_is_not_overwritten(db):
    commit(db, TOILETDOG, NOW)
    searched(db, TOILETDOG, name="Toilet Dog")

    fill.run_once(db, NOW, Sources(picture_from_try=1))

    assert row(db, TOILETDOG).name == "Toilet Dog"


def test_the_search_never_pays_and_stops_waiting_after_two_seconds(monkeypatch):
    """check-mint asks pump.fun and DexScreener at once and takes what it has at two seconds."""
    import time

    from presentation.lottery import lottery_router as router

    def slow_pumpfun(mint):
        time.sleep(3)
        return {"token_name": "late", "token_symbol": "LATE", "token_image_url": "https://late"}

    def paid(mint):
        raise AssertionError("a search must not use the paid lookup")

    monkeypatch.setattr(router, "_fetch_pumpfun_token_metadata", slow_pumpfun)
    monkeypatch.setattr(router, "_fetch_dexscreener_token_metadata", lambda mint: {"token_name": "TOILETDOG", "token_symbol": "TOILETDOG", "token_image_url": None})
    monkeypatch.setattr(router, "_fetch_helius_token_metadata", paid)
    monkeypatch.setattr(router, "_fetch_onchain_token_metadata", lambda mint: {"token_name": None, "token_symbol": None, "token_image_url": None})

    started = time.monotonic()
    found = router._quick_token_metadata(TOILETDOG)
    took = time.monotonic() - started

    assert found == {"token_name": "TOILETDOG", "token_symbol": "TOILETDOG", "token_image_url": None}
    assert router.SEARCH_METADATA_BUDGET_SECONDS <= took < router.SEARCH_METADATA_BUDGET_SECONDS + 0.5


class TestTheNameFromTheChain:
    """A coin minutes old: DexScreener does not know it, pump.fun refuses the stand.
    On 2026-10-02 eight fresh pump.fun coins came back from the stand's search
    with no name at all once DAS was taken out of it. The name is on chain."""

    @staticmethod
    def account(name):
        import base64
        import json

        from solders.pubkey import Pubkey

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "screening_mints.json")
        entry = json.load(open(path, encoding="utf-8"))[name]
        return Pubkey.from_string(entry["owner"]), base64.b64decode(entry["data_base64"])

    def test_a_token_2022_mint_carries_its_own_name(self):
        from mint_validator import token_2022_name

        assert token_2022_name(*self.account("pump_token_transfer_hook")) == ("Pump", "PUMP")
        assert token_2022_name(*self.account("pumpfun_mayhem_mode")) == ("Dirt Nasty Gold Chain 1980", "DNGC1980")

    def test_an_spl_mint_names_itself_in_its_metaplex_account(self):
        from mint_validator import metaplex_metadata_address, metaplex_name, token_2022_name

        assert token_2022_name(*self.account("spl_mint_fartcoin")) is None, "an SPL Token mint has no extension"
        assert metaplex_metadata_address("9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump") == "9XQ1xyaxP4ALeRbzj9Rm9KByCuwcLjf5yJ4nbyKLxG5u"
        assert metaplex_name(*self.account("metaplex_fartcoin")) == ("Fartcoin", "Fartcoin"), "padding and the trailing space go"

    def test_anything_else_is_no_name(self):
        from solders.pubkey import Pubkey

        from mint_validator import TOKEN_2022_PROGRAM_ID, metaplex_name, token_2022_name

        owner, data = self.account("pump_token_transfer_hook")
        assert metaplex_name(owner, data) is None
        assert token_2022_name(TOKEN_2022_PROGRAM_ID, data[:200]) is None
        assert token_2022_name(Pubkey.from_string("11111111111111111111111111111111"), data) is None

    def test_a_search_gets_the_name_when_only_the_chain_knows_it(self, monkeypatch):
        from presentation.lottery import lottery_router as router

        nothing = {"token_name": None, "token_symbol": None, "token_image_url": None}
        monkeypatch.setattr(router, "_fetch_pumpfun_token_metadata", lambda mint: dict(nothing))
        monkeypatch.setattr(router, "_fetch_dexscreener_token_metadata", lambda mint: dict(nothing))
        accounts = {"MintAddr": self.account("pumpfun_mayhem_mode")}
        monkeypatch.setattr(router, "_rpc_get_account", lambda endpoint, account: (str(accounts[account][0]), accounts[account][1]) if account in accounts else None)

        found = router._quick_token_metadata("MintAddr")

        assert found == {"token_name": "Dirt Nasty Gold Chain 1980", "token_symbol": "DNGC1980", "token_image_url": None}

    def test_the_stand_reads_names_from_mainnet(self, monkeypatch):
        from types import SimpleNamespace

        from presentation.lottery import lottery_router as router

        monkeypatch.setattr(router, "get_settings", lambda: SimpleNamespace(solana_http_endpoint="https://api.devnet.solana.com"))
        assert router._names_rpc_url() == "https://api.mainnet-beta.solana.com"
        monkeypatch.setattr(router, "get_settings", lambda: SimpleNamespace(solana_http_endpoint="https://mainnet.helius-rpc.com/?api-key=k"))
        assert router._names_rpc_url() == "https://mainnet.helius-rpc.com/?api-key=k"
