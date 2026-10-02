"""Opening an HTTP(S) connection without waiting out a dead address.

A name like api.dexscreener.com resolves to two IPv4 addresses, and the
standard library tries them in turn, giving each the whole request timeout. On
the devnet stand, on 2026-10-02, one of the two (Cloudflare's 8.6.112.0) could
not be reached at all, and the resolver hands the pair out in either order: any
call to DexScreener, pump.fun or Helius had an even chance of sitting six
seconds on the dead one before the live one answered in 7 ms. Coin search went
from under a second to six or twelve.

Here an address gets a short time to accept the connection, and the next one is
tried when it does not. That is what a browser does (RFC 8305), minus the
racing. An address that let us down is tried last for the next two minutes, so
a dead one costs that short wait once, not on every request. A server that only
connects slowly is not cut off: if every address ran out of its short time, the
first is tried once more with the whole timeout. Once connected, the socket
carries the full timeout for the request as before.

`urlopen` is `urllib.request.urlopen` with this connection underneath.
"""
from __future__ import annotations

import http.client
import socket
import threading
import time
import urllib.request
from typing import Any, Optional

#: How long one address has to accept the connection when there are others to try.
#: A server's connect to Cloudflare takes milliseconds; a dead address never answers.
CONNECT_ATTEMPT_SECONDS = 1.5
#: How long an address that did not answer goes to the back of the line.
DEAD_FOR_SECONDS = 120.0

_dead_until: dict[Any, float] = {}
_dead_lock = threading.Lock()

_DEFAULT = socket._GLOBAL_DEFAULT_TIMEOUT  # type: ignore[attr-defined]


def create_connection(address: tuple[str, int], timeout: Any = _DEFAULT, source_address: Optional[tuple[str, int]] = None, **_ignored: Any) -> socket.socket:
    """`socket.create_connection` that moves on from an address that does not answer."""
    host, port = address
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    if not infos:
        raise OSError(f"getaddrinfo returned nothing for {host}")
    full = None if timeout is _DEFAULT else timeout
    infos = _live_first(infos)
    attempt = CONNECT_ATTEMPT_SECONDS if full is None else min(CONNECT_ATTEMPT_SECONDS, full)
    if len(infos) == 1:
        attempt = full

    errors: list[OSError] = []
    timed_out: list[tuple[Any, ...]] = []
    for info in infos:
        try:
            return _connect(info, attempt, full, source_address)
        except TimeoutError as exc:
            errors.append(exc)
            timed_out.append(info)
            _mark_dead(info[4])
        except OSError as exc:
            errors.append(exc)
    if timed_out and attempt != full:
        # Slow rather than dead: one more go, with all the time there is.
        try:
            return _connect(timed_out[0], full, full, source_address)
        except OSError as exc:
            errors.append(exc)
    raise errors[-1]


def _live_first(infos: list[tuple[Any, ...]]) -> list[tuple[Any, ...]]:
    """The resolver's order, with addresses that recently did not answer moved to the end."""
    now = time.monotonic()
    with _dead_lock:
        for key in [key for key, until in _dead_until.items() if until <= now]:
            del _dead_until[key]
        dead = set(_dead_until)
    return [i for i in infos if i[4] not in dead] + [i for i in infos if i[4] in dead]


def _mark_dead(sockaddr: Any) -> None:
    with _dead_lock:
        _dead_until[sockaddr] = time.monotonic() + DEAD_FOR_SECONDS


def _connect(info: tuple[Any, ...], connect_timeout: Optional[float], timeout: Optional[float], source_address: Optional[tuple[str, int]]) -> socket.socket:
    family, socktype, proto, _canonname, sockaddr = info
    sock = socket.socket(family, socktype, proto)
    try:
        sock.settimeout(connect_timeout)
        if source_address:
            sock.bind(source_address)
        sock.connect(sockaddr)
        sock.settimeout(timeout)
        return sock
    except BaseException:
        sock.close()
        raise


class _HTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = create_connection


class _HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = create_connection


class _HTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_HTTPConnection, req)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_HTTPSConnection, req, context=self._context)


def urlopen(url: Any, data: Any = None, timeout: Any = _DEFAULT, *, context: Any = None) -> Any:
    """`urllib.request.urlopen`, with a dead address costing seconds, not the timeout."""
    opener = urllib.request.build_opener(_HTTPHandler(), _HTTPSHandler(context=context))
    return opener.open(url, data, timeout)
