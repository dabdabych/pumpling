"""The picture a shared pumpling link shows on X and in other previews.

The share dialog on the site draws its card in the browser, and that card can
be copied or downloaded. A link posted on its own showed only the site's
generic picture: X reads the image from the page's `twitter:image` tag and runs
no script, and the pool page is a script. So the link now points at a page the
server renders (`presentation/share/share_router.py`), and its image is drawn
here, from what the database says, never from anything in the link: a card
that claims "I put 1,000 SOL behind $X" on our domain has to be true.

It is the same card as the site's, redrawn for the shape X shows: X crops a
`summary_large_image` to 2:1 (developer.twitter.com, "Summary Card with Large
Image": aspect ratio 2:1, 300x157 to 4096x4096, under 5MB, PNG among the
formats), so the site's 1200x675 would lose its header and its footer. The
wording is the site's (`webapp/ui/src/app/pool/share/share-card.ts`,
`shareCardCopy`), line for line.
"""
from __future__ import annotations

import hashlib
import io
import math
import os
import re
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from functools import lru_cache
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

WIDTH = 1200
HEIGHT = 600

SITE = "pumpling.xyz"

PAPER = (252, 252, 252)
INK = (2, 2, 2)
PURPLE = (175, 143, 255)
GREEN = (143, 255, 175)
# rgba(2, 2, 2, 0.66) on paper.
MUTED = (86, 86, 86)
# rgba(2, 2, 2, 0.12) on paper.
DOT = (222, 222, 222)

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "share")


@dataclass(frozen=True)
class ShareCard:
    """What a card says. `kind` is "commit", "coin" or "pool"."""

    kind: str
    pool_id: Optional[int]
    phase: str
    ticker: str = ""
    name: str = ""
    mint: str = ""
    commit_sol: float = 0.0
    coin_sol: float = 0.0
    coin_share: float = 0.0
    pool_sol: float = 0.0
    cap_sol: float = 111.0
    coins: int = 0
    closes_at: Optional[datetime] = None


@dataclass(frozen=True)
class CardCopy:
    headline: tuple[tuple[str, bool], ...]
    sub: str
    stats: tuple[tuple[str, str], ...]
    post: str


def format_sol(value: float) -> str:
    """The site's `formatSol`: two decimals, half up, thousands separated, no trailing zeros."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(number):
        return "0"
    if 0 < abs(number) < 0.005:
        return ">-0.01" if number < 0 else "<0.01"
    try:
        # JavaScript's toFixed rounds the exact binary value half up; Decimal of
        # the float is that exact value. Python's own formatting would round a
        # tie such as 0.125 to even.
        rounded = Decimal(number).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return "0"
    text = f"{rounded:,.2f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _js_round(value: float) -> int:
    """JavaScript's `Math.round`: halves go up. Python's `round` sends 12.5 to 12."""
    return math.floor(value + 0.5)


def coin_initials(ticker: str) -> str:
    """The site's `coinInitials`: the first two letters or digits of the ticker."""
    return re.sub(r"[^A-Za-z0-9]", "", ticker)[:2].upper() or "?"


def card_copy(card: ShareCard) -> CardCopy:
    """The site's `shareCardCopy`, the same words."""
    ticker = f"${card.ticker}" if card.ticker else ""
    commit = format_sol(card.commit_sol)
    behind = format_sol(card.coin_sol)
    pool = format_sol(card.pool_sol)

    if card.kind == "commit" and ticker:
        return CardCopy(
            headline=((f"{commit} SOL behind", False), (ticker, True)),
            sub="Once SOL is in, nobody can take it back. When the pool closes, it goes into public buys.",
            stats=(("My commit", f"{commit} SOL"), (f"Behind {ticker}", f"{behind} SOL"), ("In the pool", f"{pool} SOL")),
            post=f"I put {commit} SOL behind {ticker} on pumpling. When the pool closes, that SOL goes into public on-chain buys. Nobody can cancel it.",
        )
    if card.kind == "coin" and ticker:
        return CardCopy(
            headline=((ticker, True), ("is in the pool", False)),
            sub=f"{behind} SOL stands behind it. When the pool closes, that SOL goes into public buys.",
            stats=(("Behind it", f"{behind} SOL"), ("Share of pool", f"{_js_round(card.coin_share * 100)}%"), ("In the pool", f"{pool} SOL")),
            post=f"{ticker} is in the pumpling pool with {behind} SOL behind it. When the pool closes, that SOL goes into public on-chain buys.",
        )
    return CardCopy(
        headline=((f"{pool} SOL", False), ("goes into buys", False)),
        sub="Name any Solana memecoin and add SOL. When the pool closes, it goes into public buys.",
        stats=(("In the pool", f"{pool} SOL"), ("Cap", f"{format_sol(card.cap_sol)} SOL"), ("Coins", str(card.coins))),
        post=f"{pool} SOL is in the pumpling pool right now, on its way into public on-chain buys of the coins people named.",
    )


def footer_note(card: ShareCard) -> str:
    """The site's `shareCardFooterNote`."""
    if card.phase == "open":
        if card.closes_at is not None:
            closes = card.closes_at if card.closes_at.tzinfo else card.closes_at.replace(tzinfo=timezone.utc)
            return f"Closes {closes.astimezone(timezone.utc):%H:%M} UTC"
        return "Pool is open"
    if card.phase == "locked":
        return "Pool locked · draw"
    if card.phase == "buying":
        return "Buys running"
    if card.phase == "done":
        return "Pool done"
    return "Next pool soon"


def card_version(card: ShareCard, logo_url: Optional[str]) -> str:
    """A short fingerprint of what the picture shows, for its address.

    X keeps a card's picture by its URL: the same address after the numbers
    changed would bring back the old picture. A new fingerprint is a new URL.
    """
    return hashlib.sha256(repr((card, logo_url)).encode("utf-8")).hexdigest()[:12]


# ------------------------------------------------------------------ drawing

@lru_cache(maxsize=32)
def _font(weight: int, size: int) -> ImageFont.FreeTypeFont:
    name = "Inter-Bold.ttf" if weight >= 600 else "Inter-Medium.ttf"
    return ImageFont.truetype(os.path.join(ASSETS, name), size)


@lru_cache(maxsize=1)
def _mascot() -> Image.Image:
    return Image.open(os.path.join(ASSETS, "pumpling-mascot.png")).convert("RGBA")


@lru_cache(maxsize=1)
def _missing_glyph() -> tuple:
    mask = _font(700, 40).getmask("\U0010FFFD")
    return mask.size, bytes(mask)


@lru_cache(maxsize=4096)
def _has_glyph(char: str) -> bool:
    mask = _font(700, 40).getmask(char)
    return (mask.size, bytes(mask)) != _missing_glyph()


def _drawable(text: str) -> str:
    """The text without the characters Inter has no glyph for.

    A browser falls back to another font for an emoji or a hieroglyph in a
    ticker; Pillow draws an empty box instead. So they are left out here, and
    the ticker keeps the letters it has.
    """
    return "".join(char for char in text if char == " " or _has_glyph(char))


def _text_width(text: str, font: ImageFont.FreeTypeFont, spacing: float) -> float:
    if not text:
        return 0.0
    return sum(font.getlength(char) for char in text) + spacing * (len(text) - 1)


def _draw_text(draw: ImageDraw.ImageDraw, x: float, y: float, text: str, font: ImageFont.FreeTypeFont, fill, spacing: float) -> None:
    """Text on its baseline at (x, y), with the canvas's letter spacing."""
    if spacing == 0:
        draw.text((x, y), text, font=font, fill=fill, anchor="ls")
        return
    for char in text:
        draw.text((x, y), char, font=font, fill=fill, anchor="ls")
        x += font.getlength(char) + spacing


def _frame(draw: ImageDraw.ImageDraw, box: tuple[float, float, float, float], width: int, fill=None) -> None:
    """A filled box with a border drawn inside it, like the canvas `strokeRect` inset by half the line."""
    x0, y0, x1, y1 = box
    if fill is not None:
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=fill)
    draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline=INK, width=width)


def _wrap(text: str, font: ImageFont.FreeTypeFont, max_width: float) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}" if line else word
        if font.getlength(candidate) > max_width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def _clamp(lines: list[str], limit: int) -> list[str]:
    if len(lines) <= limit:
        return lines
    kept = lines[:limit]
    kept[-1] = kept[-1].rstrip(".,;:") + "…"
    return kept


# Where a title line reaches, in its font size, from its baseline: up to the
# top of the plate, down to the plate's bottom. Lines follow each other at 1.1.
_LINE_ABOVE = 0.9
_LINE_BELOW = 0.24
_LINE_STEP = 1.1


def _headline_height(lines: int, size: float) -> float:
    return (_LINE_ABOVE + _LINE_BELOW + _LINE_STEP * (lines - 1)) * size


def _fit_headline(parts, max_width: float, max_height: float) -> int:
    size = 80
    while size > 38:
        font = _font(700, size)
        spacing = -0.02 * size
        widest = max(_text_width(text.upper(), font, spacing) + (24 if plate else 0) for text, plate in parts)
        if widest <= max_width and _headline_height(len(parts), size) <= max_height:
            return size
        size -= 2
    return size


def _fit_value(text: str, max_width: float, start: int) -> ImageFont.FreeTypeFont:
    size = start
    while size > 20:
        font = _font(700, size)
        if _text_width(text, font, -0.01 * size) <= max_width:
            return font
        size -= 2
    return _font(700, size)


def _paste_cover(canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]) -> None:
    """The image fills the box, cropped to its shape, like a logo in a square."""
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    source = image.convert("RGBA")
    scale = max(width / source.width, height / source.height)
    resized = source.resize((max(1, round(source.width * scale)), max(1, round(source.height * scale))), Image.LANCZOS)
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    cropped = resized.crop((left, top, left + width, top + height))
    canvas.paste(cropped, (x0, y0), cropped)


def render_card(card: ShareCard, logo: Optional[Image.Image] = None) -> bytes:
    """The card as a PNG, 1200x600."""
    if card.ticker:
        card = replace(card, ticker=_drawable(card.ticker).strip() or card.mint[:4].upper() or "COIN")
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(image)
    copy = card_copy(card)

    # The dotted paper under the card.
    for x in range(16, WIDTH, 24):
        for y in range(16, HEIGHT, 24):
            draw.rectangle((x, y, x + 1, y + 1), fill=DOT)

    # The card with its purple shadow, like the blocks on the site.
    fx, fy, fw, fh = 32, 26, WIDTH - 76, HEIGHT - 66
    draw.rectangle((fx + 12, fy + 12, fx + 12 + fw - 1, fy + 12 + fh - 1), fill=PURPLE)
    _frame(draw, (fx, fy, fx + fw, fy + fh), 6, fill=PAPER)

    pad_x = fx + 40
    header_bottom = fy + 84
    draw.rectangle((fx, header_bottom - 3, fx + fw - 1, header_bottom + 2), fill=INK)

    # The header: the mark, the name, the pool number.
    mascot = _mascot()
    small = mascot.resize((48, 48), Image.LANCZOS)
    image.paste(small, (pad_x, fy + 18), small)
    _draw_text(draw, pad_x + 62, fy + 57, "pumpling", _font(700, 32), INK, -0.02 * 32)

    chip = (f"Pool #{card.pool_id}" if card.pool_id is not None else "pumpling pool").upper()
    chip_font = _font(700, 19)
    chip_spacing = 0.1 * 19
    chip_w = _text_width(chip, chip_font, chip_spacing) + 36
    chip_h = 44
    chip_right = fx + fw - 40
    chip_top = fy + 42 - chip_h / 2
    _frame(draw, (chip_right - chip_w, chip_top, chip_right, chip_top + chip_h), 5, fill=GREEN)
    _draw_text(draw, chip_right - chip_w + 18, chip_top + 30, chip, chip_font, INK, chip_spacing)

    # Everything below is measured from the bars: the black strip at the
    # bottom, the row of numbers above it, and the rest for the title.
    strip_h = 60
    strip_y = fy + fh - strip_h
    box_h = 88
    box_y = strip_y - 22 - box_h
    content_top = header_bottom + 24
    content_bottom = box_y - 20
    right_w = 290 if card.ticker else 300
    text_width = fw - 80 - right_w - 28

    # The right column: the coin on top, the mascot under it. A coin without a
    # picture gets its initials in the same place, as in the coin list; only
    # the card about the whole pool, which has no coin, gives the column to the
    # mascot.
    right_x = fx + fw - 40 - right_w
    right_bottom = strip_y - 12
    has_coin = card.kind in ("commit", "coin") and bool(card.ticker)
    if logo is not None or has_coin:
        badge = 124
        bx = int(right_x + right_w - badge)
        by = int(content_top + 4)
        if logo is not None:
            draw.rectangle((bx, by, bx + badge - 1, by + badge - 1), fill=PAPER)
            _paste_cover(image, logo, (bx + 4, by + 4, bx + badge - 4, by + badge - 4))
        else:
            draw.rectangle((bx, by, bx + badge - 1, by + badge - 1), fill=GREEN)
            draw.text((bx + badge / 2, by + badge / 2), coin_initials(card.ticker), font=_font(700, round(badge * 0.4)), fill=INK, anchor="mm")
        draw.rectangle((bx, by, bx + badge - 1, by + badge - 1), outline=INK, width=5)
        size = 180
        big = mascot.resize((size, size), Image.LANCZOS)
        image.paste(big, (int(right_x + right_w - size), int(right_bottom - size)), big)
    else:
        size = 236
        big = mascot.resize((size, size), Image.LANCZOS)
        image.paste(big, (int(right_x + right_w - size), int(content_top + (right_bottom - content_top - size) / 2)), big)

    # The title, the second part may sit on a plate, then the caption. Every
    # height here is where the ink actually reaches, so the block can be
    # centred between the header and the numbers without touching either.
    sub_size, sub_step, sub_gap = 24, 33, 18
    sub_above, sub_below = 0.75 * sub_size, 0.25 * sub_size
    sub_font = _font(500, sub_size)
    sub_lines = _clamp(_wrap(copy.sub, sub_font, text_width), 2)
    sub_height = sub_gap + sub_above + sub_step * (len(sub_lines) - 1) + sub_below
    headline_size = _fit_headline(copy.headline, text_width, content_bottom - content_top - sub_height)
    block = _headline_height(len(copy.headline), headline_size) + sub_height
    y = content_top + max(0.0, (content_bottom - content_top - block) / 2) + _LINE_ABOVE * headline_size
    headline_font = _font(700, headline_size)
    headline_spacing = -0.02 * headline_size
    for index, (text, plate) in enumerate(copy.headline):
        upper = text.upper()
        if plate:
            # A little taller than the site's: at this size its border would
            # touch the capitals.
            width = _text_width(upper, headline_font, headline_spacing)
            plate_x = pad_x - 12
            plate_y = y - _LINE_ABOVE * headline_size
            plate_h = (_LINE_ABOVE + _LINE_BELOW) * headline_size
            _frame(draw, (plate_x, plate_y, plate_x + width + 24, plate_y + plate_h), 5, fill=PURPLE)
        _draw_text(draw, pad_x, y, upper, headline_font, INK, headline_spacing)
        if index < len(copy.headline) - 1:
            y += _LINE_STEP * headline_size
    y += _LINE_BELOW * headline_size + sub_gap + sub_above
    for line in sub_lines:
        _draw_text(draw, pad_x, y, line, sub_font, MUTED, 0)
        y += sub_step

    # The numbers in frames.
    box_w = (text_width - 2 * 16) // 3
    label_font = _font(700, 16)
    for index, (label, value) in enumerate(copy.stats):
        x = pad_x + index * (box_w + 16)
        _frame(draw, (x, box_y, x + box_w, box_y + box_h), 5, fill=PAPER)
        _draw_text(draw, x + 18, box_y + 33, label.upper(), label_font, MUTED, 0.08 * 16)
        value_font = _fit_value(value, box_w - 36, 32)
        _draw_text(draw, x + 18, box_y + 70, value, value_font, INK, -0.01 * value_font.size)

    # The black strip: the address and what the pool is doing.
    draw.rectangle((fx, strip_y, fx + fw - 1, strip_y + strip_h - 1), fill=INK)
    _draw_text(draw, pad_x, strip_y + 40, SITE, _font(700, 25), PAPER, 0.02 * 25)
    note = footer_note(card).upper()
    note_font = _font(700, 19)
    note_spacing = 0.1 * 19
    _draw_text(draw, fx + fw - 40 - _text_width(note, note_font, note_spacing), strip_y + 39, note, note_font, GREEN, note_spacing)

    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()
