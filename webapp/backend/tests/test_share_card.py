"""The card behind a shared link says what the site's card says.

The site draws its card in the browser (`webapp/ui/src/app/pool/share/
share-card.ts`); the server draws the same card for link previews. Two copies
of the words drift apart unless something compares them, so these tests read
the site's file and hold the server's words to it, number formatting included.
"""
from __future__ import annotations

import io
import os
import re
import sys
from datetime import datetime, timezone

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.share_card import HEIGHT, WIDTH, ShareCard, card_copy, card_version, coin_initials, footer_note, format_sol, render_card  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
_SITE_CARD = os.path.join(_ROOT, "webapp", "ui", "src", "app", "pool", "share", "share-card.ts")

MINT = "7GPviorAr6tHeFBVGF6Hc2i1RvMd4m54bVbCb7aBNC9q"


def _site_source() -> str:
    with open(_SITE_CARD, encoding="utf-8") as handle:
        return handle.read()


def _function(source: str, name: str) -> str:
    start = source.index(f"export function {name}(")
    return source[start:source.index("\n}\n", start)]


# The site's formatSol, run in node on these inputs (2026-09-30):
#   Number(v.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 })
@pytest.mark.parametrize("value, expected", [
    (0, "0"), (0.004, "<0.01"), (0.005, "0.01"), (0.125, "0.13"), (1.005, "1"), (1.5, "1.5"),
    (2.675, "2.67"), (12.25, "12.25"), (39.4, "39.4"), (109.2, "109.2"), (111, "111"),
    (1234.5678, "1,234.57"), (11111.4, "11,111.4"), (1_000_000, "1,000,000"), (0.1 + 0.2, "0.3"),
    (-3.456, "-3.46"), (float("nan"), "0"), (float("inf"), "0"),
])
def test_numbers_are_written_as_on_the_site(value, expected):
    assert format_sol(value) == expected


SAMPLE = ShareCard(
    kind="commit", pool_id=128, phase="open", ticker="TICK", mint=MINT,
    commit_sol=1.23, coin_sol=4.56, coin_share=0.125, pool_sol=7.89, cap_sol=111, coins=5,
)

# What the site's placeholders come to for SAMPLE. Math.round(12.5) is 13 in
# JavaScript and 12 with Python's round, which is why it is spelled out.
_SITE_VALUES = {
    "${commit}": "1.23",
    "${behind}": "4.56",
    "${pool}": "7.89",
    "${ticker}": "$TICK",
    "${formatSol(data.capSol)}": "111",
    "${Math.round(data.coinShare * 100)}": "13",
    "String(data.coins)": "5",
}


def _site_strings(kind_block: str) -> list[str]:
    found = re.findall(r"\b(?:text|sub|label|value|post):\s*('[^']*'|`[^`]*`|String\(data\.coins\)|ticker\b)", kind_block)
    out = []
    for literal in found:
        text = literal[1:-1] if literal[0] in "'`" else literal
        if text == "ticker":
            text = "${ticker}"
        for placeholder, value in _SITE_VALUES.items():
            text = text.replace(placeholder, value)
        assert "${" not in text, f"a placeholder this test does not know: {literal}"
        out.append(text)
    return out


def _server_strings(card: ShareCard) -> list[str]:
    copy = card_copy(card)
    out = [text for text, _ in copy.headline]
    out.append(copy.sub)
    for label, value in copy.stats:
        out += [label, value]
    out.append(copy.post)
    return out


def _branches() -> list[str]:
    body = _function(_site_source(), "shareCardCopy")
    commit = body[body.index("if (data.kind === 'commit' && ticker)"):body.index("if (data.kind === 'coin' && ticker)")]
    coin = body[body.index("if (data.kind === 'coin' && ticker)"):]
    coin, pool = coin[:coin.index("\n  return {")], coin[coin.index("\n  return {"):]
    return [commit, coin, pool]


@pytest.mark.parametrize("index, kind", [(0, "commit"), (1, "coin"), (2, "pool")])
def test_every_word_is_the_sites(index, kind):
    site = _site_strings(_branches()[index])
    server = _server_strings(ShareCard(**{**SAMPLE.__dict__, "kind": kind}))
    assert server == site


def test_the_plate_sits_where_the_site_puts_it():
    body = _function(_site_source(), "shareCardCopy")
    assert "headline: [{ text: `${commit} SOL behind` }, { text: ticker, plate: true }]" in body
    assert "headline: [{ text: ticker, plate: true }, { text: 'is in the pool' }]" in body
    assert [plate for _, plate in card_copy(SAMPLE).headline] == [False, True]
    assert [plate for _, plate in card_copy(ShareCard(**{**SAMPLE.__dict__, "kind": "coin"})).headline] == [True, False]


def test_without_a_ticker_it_is_the_pools_card():
    assert card_copy(ShareCard(**{**SAMPLE.__dict__, "ticker": ""})).headline[1][0] == "goes into buys"


def test_the_footer_is_the_sites():
    body = _function(_site_source(), "shareCardFooterNote")
    for phrase in ("Pool is open", "Pool locked · draw", "Buys running", "Pool done", "Next pool soon", "`Closes ${utcTime(data.closesAtMs)} UTC`"):
        assert phrase in body
    closes = datetime(2026, 9, 30, 19, 36, 12, tzinfo=timezone.utc)
    notes = {phase: footer_note(ShareCard(**{**SAMPLE.__dict__, "phase": phase, "closes_at": closes if phase == "open" else None}))
             for phase in ("open", "locked", "buying", "done", "opening", "waiting")}
    assert notes == {
        "open": "Closes 19:36 UTC", "locked": "Pool locked · draw", "buying": "Buys running",
        "done": "Pool done", "opening": "Next pool soon", "waiting": "Next pool soon",
    }
    assert footer_note(ShareCard(**{**SAMPLE.__dict__, "closes_at": None})) == "Pool is open"


class TestThePicture:
    def _open(self, png: bytes) -> Image.Image:
        image = Image.open(io.BytesIO(png))
        image.load()
        return image

    def test_the_shape_x_shows(self):
        png = render_card(SAMPLE)
        image = self._open(png)
        assert image.format == "PNG"
        # X: summary_large_image is 2:1, at least 300x157, under 5 MB.
        assert image.size == (WIDTH, HEIGHT) == (1200, 600)
        assert len(png) < 5 * 1024 * 1024

    def test_every_kind_and_phase_draws(self):
        logo = Image.new("RGBA", (300, 200), (255, 0, 0, 255))
        for kind in ("commit", "coin", "pool"):
            for phase in ("open", "locked", "buying", "done", "waiting"):
                for with_logo in (logo, None):
                    card = ShareCard(**{**SAMPLE.__dict__, "kind": kind, "phase": phase})
                    assert self._open(render_card(card, with_logo)).size == (1200, 600)

    def test_long_numbers_and_tickers_still_fit(self):
        card = ShareCard(**{**SAMPLE.__dict__, "ticker": "W" * 16, "commit_sol": 99999.99, "coin_sol": 1234567.89, "pool_sol": 7654321.5})
        assert self._open(render_card(card)).size == (1200, 600)

    def test_a_glyph_inter_does_not_have_is_left_out_not_boxed(self):
        # The emoji is dropped; a ticker of nothing but emoji falls back to the mint.
        with_emoji = render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": "🚀TICK"}))
        plain = render_card(SAMPLE)
        assert with_emoji == plain
        only_emoji = render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": "🚀🐸"}))
        as_mint = render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": MINT[:4].upper()}))
        assert only_emoji == as_mint

    # Inside the coin's square in the right column: 1200 - 76 wide frame at 32,
    # 40 in, a 290 wide column, a 124 square at its top right, 24 under the
    # header. The point is 12 px inside the square's corner.
    BADGE_POINT = (32 + 1124 - 40 - 124 + 12, 26 + 84 + 24 + 4 + 12)

    def test_a_coin_without_a_picture_shows_its_initials_as_in_the_coin_list(self):
        for kind in ("coin", "commit"):
            image = self._open(render_card(ShareCard(**{**SAMPLE.__dict__, "kind": kind}))).convert("RGB")
            assert image.getpixel(self.BADGE_POINT) == (143, 255, 175), kind
        # The letters are drawn, and they are the coin's.
        assert render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": "ABCD"})) != render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": "ABXY"}))
        assert render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": "ABCD"})) != render_card(ShareCard(**{**SAMPLE.__dict__, "ticker": "CDAB"}))

    def test_the_pool_card_has_no_coin_square(self):
        image = self._open(render_card(ShareCard(**{**SAMPLE.__dict__, "kind": "pool"}))).convert("RGB")
        assert image.getpixel(self.BADGE_POINT) != (143, 255, 175)

    def test_a_logo_changes_the_picture(self):
        logo = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
        assert render_card(SAMPLE, logo) != render_card(SAMPLE)


@pytest.mark.parametrize("ticker, expected", [
    ("LAPA", "LA"), ("$mochi", "MO"), ("🚀PEPE", "PE"), ("A", "A"), ("", "?"), ("ペペ", "?"), ("1inch", "1I"),
])
def test_the_initials_follow_the_sites_rule(ticker, expected):
    source = open(os.path.join(_ROOT, "webapp", "ui", "src", "app", "pool", "pool-state.ts"), encoding="utf-8").read()
    body = _function(source, "coinInitials")
    assert "ticker.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?'" in body
    assert coin_initials(ticker) == expected


def test_the_picture_address_changes_with_what_it_shows():
    assert card_version(SAMPLE, None) == card_version(ShareCard(**SAMPLE.__dict__), None)
    assert card_version(SAMPLE, None) != card_version(ShareCard(**{**SAMPLE.__dict__, "pool_sol": 7.9}), None)
    assert card_version(SAMPLE, None) != card_version(ShareCard(**{**SAMPLE.__dict__, "phase": "locked"}), None)
    assert card_version(SAMPLE, None) != card_version(SAMPLE, "https://x.example/logo.png")
