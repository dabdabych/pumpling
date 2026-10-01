"""A coin's picture, downloaded for a share card.

The address comes from the coin's metadata, and whoever made the coin wrote it.
So it is somebody else's URL fetched from inside our network, the textbook
server-side request forgery: `http://169.254.169.254/...`, `http://postgres:5432`,
`http://lottery-api:8000/...`, or a public name that resolves to any of them.

What stops it:

- only http and https;
- the name is resolved here, and every address it gives must be public
  unicast (`is_public_address`), IPv4 addresses wrapped in IPv6 included, or
  nothing is fetched;
- the connection goes to the addresses that were checked, not to the name
  again, so a DNS answer that changes between the check and the connect
  (rebinding) changes nothing; TLS still verifies the certificate against the
  name;
- redirects are followed by hand, at most three, and each one is checked the
  same way;
- a time limit on the whole download, not only on each read, a size limit, and
  a pixel limit before the picture is decoded.

Anything that goes wrong is None, and the card is drawn without the coin.
"""
from __future__ import annotations

import http.client
import io
import ipaddress
import logging
import socket
import ssl
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit

import certifi
from PIL import Image

logger = logging.getLogger(__name__)

MAX_BYTES = 2 * 1024 * 1024
MAX_PIXELS = 4096 * 4096
MAX_REDIRECTS = 3
DEADLINE_SECONDS = 5.0
CONNECT_TIMEOUT_SECONDS = 3.0
# Large enough for a 124-pixel badge on a card, small enough to keep in memory.
KEEP_SIZE = 256
FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}

_CACHE_SIZE = 256
_FOUND_TTL = 60 * 60
_MISSING_TTL = 10 * 60

Resolver = Callable[[str, int], list[str]]
Allowed = Callable[[ipaddress._BaseAddress], bool]

# IPv6 prefixes that carry an IPv4 address inside: well-known NAT64 (RFC 6052).
# 6to4 and Teredo have their own accessors on the address.
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


class _Refused(Exception):
    """The address is not one we fetch from."""


def _resolve(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def is_public_address(ip: ipaddress._BaseAddress) -> bool:
    """A public unicast address, and so is any IPv4 address hidden inside it."""
    if isinstance(ip, ipaddress.IPv6Address):
        inner = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if inner is None and ip in _NAT64:
            inner = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        if inner is not None and not is_public_address(inner):
            return False
    return ip.is_global and not ip.is_multicast


def _public_addresses(host: str, port: int, resolve: Resolver, allowed: Allowed) -> list[str]:
    """The addresses to connect to, when every address of the name is public.

    IPv4 first: a container often has no IPv6 route at all.
    """
    try:
        addresses = resolve(host, port)
    except OSError as error:
        raise _Refused(f"cannot resolve {host}: {error}") from error
    if not addresses:
        raise _Refused(f"{host} has no address")
    for address in addresses:
        # An IPv6 answer can carry a zone, "fe80::1%eth0".
        if not allowed(ipaddress.ip_address(address.split("%", 1)[0])):
            raise _Refused(f"{host} resolves to a non-public address")
    return sorted(dict.fromkeys(addresses), key=lambda address: ":" in address)


def _connect(addresses: list[str], port: int, timeout: float) -> socket.socket:
    last: Optional[OSError] = None
    for address in addresses:
        try:
            return socket.create_connection((address, port), timeout)
        except OSError as error:
            last = error
    raise last or OSError("no address to connect to")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, addresses: list[str], timeout: float):
        super().__init__(host, port, timeout=timeout)
        self._addresses = addresses

    def connect(self) -> None:
        self.sock = _connect(self._addresses, self.port, self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, addresses: list[str], timeout: float, context: ssl.SSLContext):
        super().__init__(host, port, timeout=timeout, context=context)
        self._addresses = addresses
        self._tls = context

    def connect(self) -> None:
        sock = _connect(self._addresses, self.port, self.timeout)
        # The name, not the address: SNI and the certificate check both use it.
        self.sock = self._tls.wrap_socket(sock, server_hostname=self.host)


_TLS = ssl.create_default_context(cafile=certifi.where())


def _download(url: str, resolve: Resolver, allowed: Allowed) -> Optional[bytes]:
    deadline = time.monotonic() + DEADLINE_SECONDS
    for _ in range(MAX_REDIRECTS + 1):
        if time.monotonic() > deadline:
            return None
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in ("http", "https") or not parts.hostname:
            raise _Refused("not an http(s) address")
        if parts.username or parts.password:
            raise _Refused("credentials in the address")
        port = parts.port or (443 if scheme == "https" else 80)
        addresses = _public_addresses(parts.hostname, port, resolve, allowed)
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"

        if scheme == "https":
            connection: http.client.HTTPConnection = _PinnedHTTPSConnection(parts.hostname, port, addresses, CONNECT_TIMEOUT_SECONDS, _TLS)
        else:
            connection = _PinnedHTTPConnection(parts.hostname, port, addresses, CONNECT_TIMEOUT_SECONDS)
        try:
            connection.request("GET", path, headers={
                "User-Agent": "pumpling-card/1.0 (+https://pumpling.xyz)",
                "Accept": "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1",
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    return None
                url = urljoin(url, location)
                continue
            if response.status != 200:
                return None
            length = response.getheader("Content-Length")
            if length and length.isdigit() and int(length) > MAX_BYTES:
                return None
            chunks: list[bytes] = []
            size = 0
            while True:
                if time.monotonic() > deadline:
                    return None
                # read1: whatever has arrived, so a server that sends a byte at a
                # time meets the deadline instead of filling a 64 KB read.
                chunk = response.read1(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    return None
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            connection.close()
    return None


def _decode(data: bytes) -> Optional[Image.Image]:
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in FORMATS:
                return None
            width, height = image.size
            # Checked before decoding: the header is read, the pixels are not yet.
            if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
                return None
            image.seek(0)
            picture = image.convert("RGBA")
    except Exception:
        return None
    picture.thumbnail((KEEP_SIZE, KEEP_SIZE), Image.LANCZOS)
    return picture


class _Cache:
    def __init__(self) -> None:
        self._items: "OrderedDict[str, tuple[float, Optional[Image.Image]]]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, url: str) -> tuple[bool, Optional[Image.Image]]:
        with self._lock:
            item = self._items.get(url)
            if item is None:
                return False, None
            expires, image = item
            if expires < time.monotonic():
                del self._items[url]
                return False, None
            self._items.move_to_end(url)
            return True, image

    def put(self, url: str, image: Optional[Image.Image]) -> None:
        with self._lock:
            self._put(url, image)

    def put_missing_unless_known(self, url: str) -> None:
        with self._lock:
            item = self._items.get(url)
            if item is None or item[0] < time.monotonic():
                self._put(url, None)

    def _put(self, url: str, image: Optional[Image.Image]) -> None:
        ttl = _FOUND_TTL if image is not None else _MISSING_TTL
        self._items[url] = (time.monotonic() + ttl, image)
        self._items.move_to_end(url)
        while len(self._items) > _CACHE_SIZE:
            self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


_cache = _Cache()

# Downloads run here, never on the thread that answers the request. A server
# that sends its headers a byte every few seconds can hold a thread for as long
# as it likes; this way it holds one of these few, and the request still
# answers at `DEADLINE_SECONDS` with the card drawn without the coin.
_POOL_SIZE = 4
_pool = ThreadPoolExecutor(max_workers=_POOL_SIZE, thread_name_prefix="coin-picture")
_in_flight: dict[str, Future] = {}
_in_flight_lock = threading.Lock()


def clear_cache() -> None:
    _cache.clear()


def _load(url: str, resolve: Resolver, allowed: Allowed) -> Optional[Image.Image]:
    try:
        data = _download(url, resolve, allowed)
        image = _decode(data) if data else None
    except _Refused as refusal:
        logger.info("Coin picture not fetched: %s", refusal)
        image = None
    except Exception as error:  # a dead host, a TLS error, a reset: no picture, no failure
        logger.info("Coin picture not fetched: %s", type(error).__name__)
        image = None
    _cache.put(url, image)
    with _in_flight_lock:
        _in_flight.pop(url, None)
    return image


def fetch_image(url: Optional[str], resolve: Resolver = _resolve, allowed: Allowed = is_public_address) -> Optional[Image.Image]:
    """The picture at `url`, at most 256 pixels a side, or None. Remembered for an hour.

    Requests for the same address while it is downloading wait for that one
    download rather than starting their own.
    """
    if not url:
        return None
    found, image = _cache.get(url)
    if found:
        return image
    with _in_flight_lock:
        future = _in_flight.get(url)
        if future is None:
            future = _pool.submit(_load, url, resolve, allowed)
            _in_flight[url] = future
    try:
        return future.result(timeout=DEADLINE_SECONDS + 1)
    except FutureTimeout:
        # Remembered as missing, so the next request does not wait as well. If
        # the download does finish, it writes over this.
        _cache.put_missing_unless_known(url)
        return None
