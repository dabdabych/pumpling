"""Where a coin's picture is fetched from, when it lives on IPFS.

The public gateway at ipfs.io stopped serving content over HTTP on 2026-09-21
(gatewaychanges.ipfs.io). It answers a server with 429 "switching to a service
worker gateway only" and a browser with a Cloudflare challenge, so an `<img>`
pointing at it shows nothing. Most pump.fun coins have their picture at
`https://ipfs.io/ipfs/<cid>`: that is what pump.fun's own record, Helius DAS
and even Helius's image CDN (a proxy in front of the same address) all give.
dweb.link, w3s.link and nftstorage.link answer the same way.

The pictures themselves are fine; only the gateway went away. So an IPFS
address is rewritten to a gateway that serves it, by its content id, which
names the file whatever gateway it is fetched through. Measured on
2026-10-01 from the mainnet server and from a browser: pump.fun's Pinata
gateway answered in 0.4 to 0.9 seconds with `Access-Control-Allow-Origin: *`
(so the share card's canvas can use the picture), also for content pump.fun
did not upload; Filebase's public gateway answered in 0.3 to 2.6 seconds and
once timed out from the server. Pinata's own public gateway took 3 to 7.

The rewrite happens on the way out (`ImageUrl` in the API schemas), so the
addresses stored in the database stay what the sources said, and nothing
needs migrating.
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlsplit

GATEWAYS = (
    "https://pump.mypinata.cloud/ipfs/",
    "https://ipfs.filebase.io/ipfs/",
)

_CID = re.compile(
    r"^(?:"
    r"Qm[1-9A-HJ-NP-Za-km-z]{44}"   # CIDv0, base58btc
    r"|b[a-z2-7]{50,}"              # CIDv1, base32 (bafy..., bafk...)
    r"|k[0-9a-z]{50,}"              # CIDv1, base36
    r"|z[1-9A-HJ-NP-Za-km-z]{40,}"  # CIDv1, base58btc
    r")$"
)
# What may follow the content id: a path inside it, as it was written.
_PATH = re.compile(r"^(?:/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*$")
# Helius serves pictures through Cloudflare image resizing:
# https://cdn.helius-rpc.com/cdn-cgi/image/<options>/<original address>
_CDN_WRAPPER = re.compile(r"^https?://[^/]+/cdn-cgi/image/[^/]*/(https?://.+)$", re.IGNORECASE)


def ipfs_path(url: Optional[str]) -> Optional[str]:
    """`<cid>` or `<cid>/<path>` when the address is a file on IPFS, else None."""
    if not url or not isinstance(url, str):
        return None
    text = url.strip()
    wrapped = _CDN_WRAPPER.match(text)
    if wrapped:
        return ipfs_path(wrapped.group(1))

    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    scheme = parts.scheme.lower()

    if scheme == "ipfs":
        # ipfs://<cid>/path, and the odd ipfs://ipfs/<cid>/path.
        rest = f"{parts.netloc}{parts.path}"
        if rest.startswith("ipfs/"):
            rest = rest[len("ipfs/"):]
        cid, _, path = rest.partition("/")
        return _join(cid, f"/{path}" if path else "")

    if scheme not in ("http", "https") or not parts.hostname:
        return None

    host = parts.hostname.lower()
    # Subdomain gateways: https://<cid>.ipfs.<gateway>/<path>
    label, dot, rest = host.partition(".")
    if dot and rest.startswith("ipfs."):
        return _join(label, parts.path if parts.path != "/" else "")

    # Path gateways: https://<gateway>/ipfs/<cid>/<path>
    if parts.path.startswith("/ipfs/"):
        cid, _, path = parts.path[len("/ipfs/"):].partition("/")
        return _join(cid, f"/{path}" if path else "")
    return None


def _join(cid: str, path: str) -> Optional[str]:
    if not _CID.match(cid) or not _PATH.match(path):
        return None
    return f"{cid}{path}"


def image_url_candidates(url: Optional[str]) -> list[str]:
    """Addresses to fetch a picture from, in order: the gateways for IPFS, else the address itself."""
    path = ipfs_path(url)
    if path:
        return [f"{gateway}{path}" for gateway in GATEWAYS]
    return [url.strip()] if isinstance(url, str) and url.strip() else []


def normalize_image_url(url: Optional[str]) -> Optional[str]:
    """The address a browser should load the picture from: IPFS through the first gateway, anything else as it is."""
    path = ipfs_path(url)
    return f"{GATEWAYS[0]}{path}" if path else url
