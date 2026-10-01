"""A shared link shows its card to X and takes a person to the pool.

Run against a real SQL database (SQLite in memory) with the real models, so
the queries are the ones production runs, not a fake that agrees with them.
"""
from __future__ import annotations

import io
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from domain.lottery.entities.lottery import LotteryStatus  # noqa: E402
from infrastructure.database.database import Base, get_db  # noqa: E402
from infrastructure.database.models.bet_participation_model import BetParticipationModel  # noqa: E402
from infrastructure.database.models.lottery_model import LotteryModel  # noqa: E402
from infrastructure.database.models.token_metadata_model import TokenMetadataModel  # noqa: E402
from presentation.share import share_router  # noqa: E402
from shared import remote_image  # noqa: E402

NOW = datetime.now(timezone.utc)
MINT_A = "7GPviorAr6tHeFBVGF6Hc2i1RvMd4m54bVbCb7aBNC9q"
MINT_B = "8PaK9mufsAyiGCpFN6Z6pyXs1ZzdC8tWcLV5Qmokpump"
MINT_ELSEWHERE = "Dz4bX3snTDxqdKyZwdUgKoDvSjyvmoA23E6j5odZpump"
SIG_A = "5" * 87
SIG_ORPHANED = "4" * 87
SIG_UNKNOWN = "3" * 87

TWITTERBOT = "Twitterbot/1.0"
IMESSAGE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0"
CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
X_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.60"


class _Meta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags: dict[str, str] = {}
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            key = attrs.get("property") or attrs.get("name")
            if key:
                self.tags[key] = attrs.get("content", "")
        self._in_title = tag == "title"

    def handle_data(self, data):
        if self._in_title:
            self.title += data

    def handle_endtag(self, tag):
        self._in_title = False


def meta(body: str) -> dict[str, str]:
    parser = _Meta()
    parser.feed(body)
    return parser.tags


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[LotteryModel.__table__, BetParticipationModel.__table__, TokenMetadataModel.__table__])
    # Postgres keeps one open round per type; SQLite would read it as one round ever.
    with engine.begin() as connection:
        connection.execute(text("DROP INDEX uq_lotteries_open_by_type"))
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


@pytest.fixture
def client(db, monkeypatch):
    remote_image.clear_cache()
    share_router._rendered.clear()
    fetched = []

    def no_network(url, *args, **kwargs):
        fetched.append(url)
        return Image.new("RGBA", (64, 64), (0, 200, 0, 255)) if url else None

    monkeypatch.setattr(share_router, "fetch_image", no_network)
    app = FastAPI()
    app.include_router(share_router.router)
    app.dependency_overrides[get_db] = lambda: db
    test_client = TestClient(app, base_url="http://testserver")
    test_client.fetched = fetched
    return test_client


def add_round(db, pool_id=128, status=LotteryStatus.CREATED, end_in=timedelta(minutes=30), max_total=111, buys_started=None):
    db.add(LotteryModel(
        id=pool_id, name=f"pool {pool_id}", created_by_user_id=1, status=status, lottery_type="dex",
        end_date=NOW + end_in, max_total=max_total, proceeding_purchases_started_at=buys_started,
    ))
    db.commit()


def add_bet(db, mint, sol, signature=None, pool_id=128, status="confirmed"):
    db.add(BetParticipationModel(
        user_id=1, lottery_id=pool_id, meme_coin_address=mint, sol_amount=sol,
        wallet_address="Wal1et1111111111111111111111111111111111111", tx_signature=signature, confirmation_status=status,
    ))
    db.commit()


def add_coin(db, mint, symbol, logo="https://images.example/logo.png"):
    db.add(TokenMetadataModel(mint=mint, name=f"{symbol} coin", symbol=symbol, logo_url=logo))
    db.commit()


@pytest.fixture
def pool(db):
    add_round(db)
    add_coin(db, MINT_A, "lapa")
    add_coin(db, MINT_B, "$mochi")
    add_bet(db, MINT_A, 2.5, SIG_A)
    add_bet(db, MINT_A, 9.75)
    add_bet(db, MINT_B, 27.15)
    add_bet(db, MINT_B, 50.0, SIG_ORPHANED, status="orphaned")
    return db


def get(client, path, agent, **kwargs):
    return client.get(path, headers={"User-Agent": agent, "Host": "pumpling.xyz", "X-Forwarded-Proto": "https"}, follow_redirects=False, **kwargs)


class TestAPersonGoesToThePool:
    @pytest.mark.parametrize("agent", [CHROME, X_APP, ""])
    def test_the_coin_link(self, client, pool, agent):
        response = get(client, f"/share/coin/128/{MINT_A}?v=abc", agent)
        assert response.status_code == 302
        assert response.headers["location"] == f"/pool?coin={MINT_A}"
        assert "user-agent" in response.headers["vary"].lower()

    def test_the_pool_link(self, client, pool):
        response = get(client, "/share/pool/128", CHROME)
        assert (response.status_code, response.headers["location"]) == (302, "/pool")

    def test_the_commit_link_finds_its_coin(self, client, pool):
        response = get(client, f"/share/commit/{SIG_A}", CHROME)
        assert (response.status_code, response.headers["location"]) == (302, f"/pool?coin={MINT_A}")

    def test_anything_odd_still_lands_on_the_pool(self, client, pool):
        assert get(client, f"/share/commit/{SIG_UNKNOWN}", CHROME).headers["location"] == "/pool"
        assert get(client, "/share/coin/128/not-a-mint", CHROME).headers["location"] == "/pool"
        assert get(client, "/share/pool/999", CHROME).headers["location"] == "/pool"

    def test_the_redirect_never_leaves_the_site(self, client, pool):
        for path in ("/share/coin/128/%2F%2Fevil.example", f"/share/commit/{'//evil.example'}"):
            location = get(client, path, CHROME).headers.get("location", "/pool")
            assert location.startswith("/pool")


class TestACrawlerGetsTheCard:
    def test_the_coin_card(self, client, pool):
        response = get(client, f"/share/coin/128/{MINT_A}?v=abc", TWITTERBOT)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["x-robots-tag"] == "noindex"
        tags = meta(response.text)
        assert tags["twitter:card"] == "summary_large_image"
        assert tags["twitter:site"] == "@pumplingxyz"
        # Only confirmed commits: the orphaned 50 SOL is not in the pool.
        assert tags["twitter:title"] == "$LAPA is in the pool"
        assert tags["og:description"] == "12.25 SOL stands behind it. When the pool closes, that SOL goes into public buys."
        assert tags["og:url"] == f"https://pumpling.xyz/s/coin/128/{MINT_A}?v=abc"
        assert re.fullmatch(rf"https://pumpling\.xyz/s/coin/128/{MINT_A}/card\.png\?v=[0-9a-f]{{12}}", tags["twitter:image"])
        assert tags["og:image"] == tags["twitter:image"]
        assert (tags["og:image:width"], tags["og:image:height"]) == ("1200", "600")
        assert "12.25 SOL behind it" in tags["twitter:image:alt"]

    def test_imessage_counts_as_a_crawler(self, client, pool):
        assert get(client, "/share/pool/128", IMESSAGE).status_code == 200

    def test_the_commit_card_takes_its_numbers_from_the_database(self, client, pool):
        tags = meta(get(client, f"/share/commit/{SIG_A}", TWITTERBOT).text)
        assert tags["twitter:title"] == "2.5 SOL behind $LAPA"
        assert tags["og:url"] == f"https://pumpling.xyz/s/commit/{SIG_A}"
        assert f"/s/commit/{SIG_A}/card.png?v=" in tags["twitter:image"]

    def test_an_orphaned_or_unknown_commit_gets_no_card_of_its_own(self, client, pool):
        for signature in (SIG_ORPHANED, SIG_UNKNOWN):
            tags = meta(get(client, f"/share/commit/{signature}", TWITTERBOT).text)
            assert tags["twitter:image"] == "https://pumpling.xyz/assets/seo/pumpling-share.png"
            assert get(client, f"/share/commit/{signature}/card.png", TWITTERBOT).status_code == 404

    def test_a_coin_not_in_the_pool_gets_the_pools_card(self, client, pool):
        tags = meta(get(client, f"/share/coin/128/{MINT_ELSEWHERE}", TWITTERBOT).text)
        assert tags["twitter:title"] == "39.4 SOL goes into buys"

    def test_the_pool_card(self, client, pool):
        tags = meta(get(client, "/share/pool/128", TWITTERBOT).text)
        assert tags["twitter:title"] == "39.4 SOL goes into buys"

    def test_a_ticker_cannot_write_into_the_page(self, client, db):
        # Whoever made the coin wrote its ticker. Sixteen characters at most
        # reach the card, which is enough to close an attribute and open a tag.
        add_round(db)
        add_coin(db, MINT_A, '"><script>')
        add_bet(db, MINT_A, 1.0)
        body = get(client, f"/share/coin/128/{MINT_A}?v=%22%3E%3Cscript%3E", TWITTERBOT).text
        assert '"><SCRIPT>' not in body
        assert "&quot;&gt;&lt;SCRIPT&gt;" in body
        assert meta(body)["twitter:title"] == '$"><SCRIPT> is in the pool'
        assert body.lower().count("<script>") == 1  # the redirect for a person taken for a crawler

    def test_a_forged_host_does_not_move_the_picture(self, client, pool):
        response = client.get("/share/pool/128", headers={"User-Agent": TWITTERBOT, "Host": 'evil.example"><x'})
        assert meta(response.text)["twitter:image"].startswith("https://pumpling.xyz/")

    def test_head_is_answered(self, client, pool):
        response = client.head("/share/pool/128", headers={"User-Agent": TWITTERBOT, "Host": "pumpling.xyz"})
        assert response.status_code == 200
        assert client.head("/share/pool/128/card.png").headers["content-type"] == "image/png"


class TestThePicture:
    def test_it_is_the_card(self, client, pool):
        response = get(client, f"/share/coin/128/{MINT_A}/card.png?v=anything", TWITTERBOT)
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert "max-age" in response.headers["cache-control"]
        image = Image.open(io.BytesIO(response.content))
        assert image.size == (1200, 600)
        assert client.fetched == ["https://images.example/logo.png"]

    def test_the_address_changes_when_the_numbers_do(self, client, pool, db):
        before = meta(get(client, f"/share/coin/128/{MINT_A}", TWITTERBOT).text)["twitter:image"]
        add_bet(db, MINT_A, 1.0)
        after = meta(get(client, f"/share/coin/128/{MINT_A}", TWITTERBOT).text)["twitter:image"]
        assert before != after
        before_png = get(client, f"/share/coin/128/{MINT_A}/card.png", TWITTERBOT).content
        add_bet(db, MINT_B, 1.0)
        assert get(client, f"/share/coin/128/{MINT_A}/card.png", TWITTERBOT).content != before_png

    def test_unknown_things_are_not_found(self, client, pool):
        assert get(client, "/share/pool/999/card.png", TWITTERBOT).status_code == 404
        assert get(client, "/share/coin/999/{}/card.png".format(MINT_A), TWITTERBOT).status_code == 404
        assert get(client, "/share/coin/128/not-a-mint/card.png", TWITTERBOT).status_code == 404


class TestThePhaseOnTheCard:
    """The footer follows the page's own rules (pool-state.ts, buildPoolSnapshot)."""

    def _phase(self, db, **round_args):
        from application.lottery.share_card_data import ShareCards

        add_round(db, **round_args)
        add_bet(db, MINT_A, 1.0)
        cards = ShareCards(db, lambda _db, mint: ("", "LAPA", ""), buy_window_seconds=3000, now=NOW)
        return cards.pool(128).card.phase

    def test_open(self, db):
        assert self._phase(db) == "open"

    def test_time_is_up(self, db):
        assert self._phase(db, end_in=timedelta(seconds=-1)) == "locked"

    def test_the_cap_is_reached(self, db):
        assert self._phase(db, max_total=1.02) == "locked"

    def test_the_draw(self, db):
        assert self._phase(db, status=LotteryStatus.VRF_BINDED) == "locked"

    def test_buying(self, db):
        assert self._phase(db, status=LotteryStatus.PROCEEDING_PURCHASES) == "buying"

    def test_closed_inside_the_window_is_still_buying(self, db):
        assert self._phase(db, status=LotteryStatus.CLOSED, buys_started=NOW - timedelta(minutes=20)) == "buying"

    def test_closed_after_the_window_is_done(self, db):
        assert self._phase(db, status=LotteryStatus.CLOSED, buys_started=NOW - timedelta(minutes=51)) == "done"

    def test_an_abandoned_round_has_no_card(self, db):
        from application.lottery.share_card_data import ShareCards

        add_round(db, status=LotteryStatus.INITIALIZE_ABANDONED)
        assert ShareCards(db, lambda _db, mint: ("", "", ""), 3000, NOW).pool(128) is None
