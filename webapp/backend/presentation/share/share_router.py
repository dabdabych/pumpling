"""Links that show their card when posted.

X, Telegram, Discord and the rest build a link's preview from the page's
`og:` and `twitter:` tags, and none of them runs the page's script. The pool
page is a script, so a link to it shows the site's generic picture whatever the
pool looks like. These links are served here instead, behind `/s/` on the site
(nginx rewrites `/s/...` to `/share/...`):

    /s/pool/<pool id>
    /s/coin/<pool id>/<mint>
    /s/commit/<commit signature>

A link-preview crawler gets a small page with the tags, whose image is the
card drawn from the database (`.../card.png`). A person gets a redirect to the
pool page, with the coin in the address when there is one. Crawlers are told
apart by their user agent. One we do not recognise follows the redirect and
reads the site's own tags, which is how every link behaved before; a person
taken for a crawler gets a page that sends them on at once.
"""
from __future__ import annotations

import html
import io
import json
import re
import threading
from collections import OrderedDict
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy.orm import Session

from application.lottery.share_card_data import MINT_PATTERN, CardSource, ShareCards
from infrastructure.database.database import get_db
from shared.coin_images import image_url_candidates
from shared.remote_image import fetch_image
from shared.settings import get_settings
from shared.share_card import HEIGHT, WIDTH, card_copy, card_version, render_card

router = APIRouter(prefix="/share", tags=["share"])

# The fetchers that build link previews. X's is "Twitterbot/1.0"
# (developer.x.com, Cards: getting started), Meta's "facebookexternalhit/1.1"
# (developers.facebook.com, web crawlers). iMessage sends both of those names in
# its own agent string.
_PREVIEW_CRAWLER = re.compile(
    r"Twitterbot|facebookexternalhit|Facebot|LinkedInBot|Slackbot|TelegramBot|Discordbot|"
    r"WhatsApp|redditbot|Embedly|Pinterestbot|SkypeUriPreview|vkShare|Iframely|Mastodon|Bluesky",
    re.IGNORECASE,
)

_HOST = re.compile(r"^[A-Za-z0-9.-]+(:\d{1,5})?$")
_FALLBACK_HOST = "pumpling.xyz"

# X: at most 70 characters of title, 200 of description, 420 of image alt text.
_TITLE_MAX = 70
_DESCRIPTION_MAX = 200
_ALT_MAX = 420

_PAGE_HEADERS = {
    # The same address answers a crawler and a person differently.
    "Vary": "User-Agent",
    "Cache-Control": "no-cache",
    # Not a page for search results: the pool page is.
    "X-Robots-Tag": "noindex",
}


def is_preview_crawler(user_agent: Optional[str]) -> bool:
    return bool(user_agent and _PREVIEW_CRAWLER.search(user_agent))


def _origin(request: Request) -> str:
    host = request.headers.get("host", "")
    if not _HOST.match(host):
        host = _FALLBACK_HOST
    # Behind nginx the scheme arrives as a header; the site is https only.
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    scheme = "http" if scheme == "http" and host.split(":", 1)[0] in ("localhost", "127.0.0.1") else "https"
    return f"{scheme}://{host}"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _cards(db: Session) -> ShareCards:
    # Imported here: the lottery router is large and pulls in Solana clients.
    from presentation.lottery.lottery_router import _get_coin_metadata

    return ShareCards(db, _get_coin_metadata, get_settings().execution_countdown_seconds)


# ------------------------------------------------------------------ the picture

_RENDERED_MAX = 64
_rendered: "OrderedDict[tuple, bytes]" = OrderedDict()
_rendered_lock = threading.Lock()


def _logo(source: CardSource):
    """The coin's picture, from the first address that gives one.

    A picture on IPFS is tried through each gateway in turn (`shared/coin_images.py`):
    ipfs.io no longer serves files, and any single gateway can have a bad minute.
    """
    for url in image_url_candidates(source.logo_url):
        image = fetch_image(url)
        if image is not None:
            return image
    return None


def _png(source: CardSource) -> bytes:
    logo = _logo(source)
    key = (source.card, source.logo_url, logo is not None)
    with _rendered_lock:
        cached = _rendered.get(key)
        if cached is not None:
            _rendered.move_to_end(key)
            return cached
    png = render_card(source.card, logo)
    with _rendered_lock:
        _rendered[key] = png
        while len(_rendered) > _RENDERED_MAX:
            _rendered.popitem(last=False)
    return png


def _image_response(source: Optional[CardSource]) -> Response:
    # A HEAD gets the same answer; uvicorn leaves the body out itself.
    if source is None:
        return Response(status_code=404, headers={"Cache-Control": "no-cache"})
    return Response(content=_png(source), media_type="image/png", headers={"Cache-Control": "public, max-age=300"})


# --------------------------------------------------------- the coin's picture

_LOGO_PNG_MAX = 128
_logo_png: "OrderedDict[str, bytes]" = OrderedDict()
_logo_png_lock = threading.Lock()


@router.api_route("/coin-logo/{mint}", methods=["GET", "HEAD"], include_in_schema=False)
def coin_logo(mint: str, db: Session = Depends(get_db)) -> Response:
    """The coin's picture, served from our own address, for the card the browser draws.

    The share dialog draws its card on a canvas, and a canvas only takes a
    picture whose server allows it (CORS); otherwise the card cannot be saved.
    DexScreener's CDN sends no such header, so a coin whose picture came from
    there showed it in the coin list, a plain <img>, and its initials on the
    card (stand, 2026-10-02, $WIFWWW). From here it is our own origin.

    Only a coin we keep a picture for: the address comes from our table, never
    from the request, so this is no open proxy. The download is
    `shared/remote_image.py`'s, public addresses only, size and time limits,
    remembered for an hour, IPFS through each gateway in turn.
    """
    missing = Response(status_code=404, headers={"Cache-Control": "public, max-age=60"})
    if not MINT_PATTERN.match(mint):
        return missing
    from presentation.lottery.lottery_router import _get_coin_metadata

    _name, _symbol, logo_url = _get_coin_metadata(db, mint)
    logo_url = (logo_url or "").strip()
    if not logo_url:
        return missing
    with _logo_png_lock:
        png = _logo_png.get(logo_url)
        if png is not None:
            _logo_png.move_to_end(logo_url)
    if png is None:
        image = None
        for url in image_url_candidates(logo_url):
            image = fetch_image(url)
            if image is not None:
                break
        if image is None:
            return missing
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        png = buffer.getvalue()
        with _logo_png_lock:
            _logo_png[logo_url] = png
            while len(_logo_png) > _LOGO_PNG_MAX:
                _logo_png.popitem(last=False)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


# ------------------------------------------------------------------ the page

def _redirect(target: str) -> Response:
    return RedirectResponse(url=target, status_code=302, headers=_PAGE_HEADERS)


def _tags(request: Request, public_path: str, source: Optional[CardSource]) -> Response:
    """The page a crawler reads: the tags, and a way on for anyone else."""
    target = source.target if source is not None else "/pool"
    origin = _origin(request)
    page_url = f"{origin}{public_path}"
    if request.url.query:
        page_url = f"{page_url}?{request.url.query}"

    if source is None:
        # Nothing to draw: the site's own preview, which is what the link
        # would have shown without us.
        title = "Pumpling — promote your memecoin on Solana"
        description = "Pumpling is a platform built so anyone can hype and promote their coin on the Solana network."
        image_url = f"{origin}/assets/seo/pumpling-share.png"
        alt = "Pumpling — promotion for Solana memecoins"
        width, height = 1200, 630
    else:
        copy = card_copy(source.card)
        title = " ".join(text for text, _ in copy.headline)
        description = copy.sub
        image_url = f"{origin}{public_path}/card.png?v={card_version(source.card, source.logo_url)}"
        alt = copy.post
        width, height = WIDTH, HEIGHT

    e = lambda text: html.escape(text, quote=True)  # noqa: E731
    # `</` cannot close the script from inside a JSON string written this way.
    target_js = json.dumps(target).replace("</", "<\\/")
    body = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Pumpling">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{e(page_url)}">
<meta property="og:image" content="{e(image_url)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="{width}">
<meta property="og:image:height" content="{height}">
<meta property="og:image:alt" content="{e(_clip(alt, _ALT_MAX))}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@pumplingxyz">
<meta name="twitter:title" content="{e(_clip(title, _TITLE_MAX))}">
<meta name="twitter:description" content="{e(_clip(description, _DESCRIPTION_MAX))}">
<meta name="twitter:image" content="{e(image_url)}">
<meta name="twitter:image:alt" content="{e(_clip(alt, _ALT_MAX))}">
</head>
<body>
<p><a href="{e(target)}">Open the pool on pumpling</a></p>
<script>location.replace({target_js});</script>
</body>
</html>
"""
    return HTMLResponse(content=body, headers=_PAGE_HEADERS)


# ------------------------------------------------------------------ routes

def _crawler(request: Request) -> bool:
    return is_preview_crawler(request.headers.get("user-agent"))


@router.api_route("/pool/{pool_id}", methods=["GET", "HEAD"], include_in_schema=False)
def share_pool(pool_id: int, request: Request, db: Session = Depends(get_db)) -> Response:
    if not _crawler(request):
        return _redirect("/pool")
    return _tags(request, f"/s/pool/{pool_id}", _cards(db).pool(pool_id))


@router.api_route("/pool/{pool_id}/card.png", methods=["GET", "HEAD"], include_in_schema=False)
def share_pool_card(pool_id: int, db: Session = Depends(get_db)) -> Response:
    return _image_response(_cards(db).pool(pool_id))


@router.api_route("/coin/{pool_id}/{mint}", methods=["GET", "HEAD"], include_in_schema=False)
def share_coin(pool_id: int, mint: str, request: Request, db: Session = Depends(get_db)) -> Response:
    if not _crawler(request):
        # Nothing to look up for a person: the mint is only a place on the page.
        return _redirect(f"/pool?coin={mint}" if MINT_PATTERN.match(mint) else "/pool")
    return _tags(request, f"/s/coin/{pool_id}/{mint}", _cards(db).coin(pool_id, mint))


@router.api_route("/coin/{pool_id}/{mint}/card.png", methods=["GET", "HEAD"], include_in_schema=False)
def share_coin_card(pool_id: int, mint: str, db: Session = Depends(get_db)) -> Response:
    return _image_response(_cards(db).coin(pool_id, mint))


@router.api_route("/commit/{signature}", methods=["GET", "HEAD"], include_in_schema=False)
def share_commit(signature: str, request: Request, db: Session = Depends(get_db)) -> Response:
    source = _cards(db).commit(signature)
    if not _crawler(request):
        return _redirect(source.target if source is not None else "/pool")
    return _tags(request, f"/s/commit/{signature}", source)


@router.api_route("/commit/{signature}/card.png", methods=["GET", "HEAD"], include_in_schema=False)
def share_commit_card(signature: str, db: Session = Depends(get_db)) -> Response:
    return _image_response(_cards(db).commit(signature))
