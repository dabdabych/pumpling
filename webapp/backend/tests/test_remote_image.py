"""A coin's picture is fetched from an address its creator wrote, so from inside
our network it must never reach anything but the public internet.

The server here is a real one on 127.0.0.1. A loopback address is exactly what
the fetcher refuses, so the tests that need it to succeed allow that one
address by name and nothing else; every other private address stays refused.
"""
from __future__ import annotations

import io
import ipaddress
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared import remote_image  # noqa: E402
from shared.remote_image import fetch_image, is_public_address  # noqa: E402


def _png(size=(64, 48), mode="RGB") -> bytes:
    out = io.BytesIO()
    Image.new(mode, size, "white" if mode != "1" else 1).save(out, format="PNG")
    return out.getvalue()


class _Server:
    """Routes: path -> (status, headers, body), or a callable writing the answer itself."""

    def __init__(self):
        self.routes: dict = {}
        self.hits: list[str] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                server.hits.append(self.path)
                route = server.routes.get(self.path)
                if callable(route):
                    route(self)
                    return
                status, headers, body = route or (404, {}, b"")
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                if "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def server():
    remote_image.clear_cache()
    s = _Server()
    yield s
    s.close()
    remote_image.clear_cache()


def _names(mapping):
    def resolve(host, port):
        if host not in mapping:
            raise socket.gaierror(f"unknown {host}")
        return list(mapping[host])
    return resolve


LOOPBACK = ipaddress.ip_address("127.0.0.1")


def only_our_loopback(ip):
    """Public addresses, plus the test server's own."""
    return ip == LOOPBACK or is_public_address(ip)


class TestRefusedWithoutConnecting:
    @pytest.fixture(autouse=True)
    def no_connections(self, monkeypatch):
        remote_image.clear_cache()
        self.attempts = []

        def refuse(address, *args, **kwargs):
            self.attempts.append(address)
            raise AssertionError(f"connected to {address}")

        monkeypatch.setattr(remote_image.socket, "create_connection", refuse)
        yield
        remote_image.clear_cache()

    @pytest.mark.parametrize("address", [
        "127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "100.64.0.1",
        "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::",
        "224.0.0.1", "198.18.0.1",
    ])
    def test_a_name_that_resolves_inside(self, address):
        assert fetch_image("https://logo.example/x.png", resolve=_names({"logo.example": [address]})) is None
        assert self.attempts == []

    def test_one_inside_address_among_public_ones_is_enough_to_refuse(self):
        resolve = _names({"logo.example": ["93.184.216.34", "10.0.0.5"]})
        assert fetch_image("https://logo.example/x.png", resolve=resolve) is None
        assert self.attempts == []

    @pytest.mark.parametrize("url", [
        "file:///etc/passwd", "ftp://logo.example/x.png", "gopher://logo.example/", "data:image/png;base64,AAAA",
        "https://user:pass@logo.example/x.png", "http:///nohost",
    ])
    def test_not_an_address_we_fetch(self, url):
        assert fetch_image(url, resolve=_names({"logo.example": ["93.184.216.34"]})) is None
        assert self.attempts == []

    def test_an_ip_literal_is_checked_too(self):
        assert fetch_image("http://169.254.169.254/latest/meta-data/", resolve=remote_image._resolve) is None
        assert self.attempts == []


class TestFetching:
    def test_a_picture_comes_back_small(self, server):
        server.routes["/logo.png"] = (200, {"Content-Type": "image/png"}, _png((1000, 800)))
        image = fetch_image(f"http://logo.example:{server.port}/logo.png",
                            resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback)
        assert image is not None
        assert max(image.size) <= remote_image.KEEP_SIZE
        assert image.mode == "RGBA"

    def test_it_connects_to_the_checked_address_and_resolves_once(self, server, monkeypatch):
        server.routes["/logo.png"] = (200, {}, _png())
        calls = []

        def resolve(host, port):
            calls.append(host)
            return ["127.0.0.1"]

        connected = []
        real = socket.create_connection

        def spy(address, *args, **kwargs):
            connected.append(address)
            return real(address, *args, **kwargs)

        monkeypatch.setattr(remote_image.socket, "create_connection", spy)
        assert fetch_image(f"http://logo.example:{server.port}/logo.png", resolve=resolve, allowed=only_our_loopback) is not None
        assert calls == ["logo.example"]
        assert connected == [("127.0.0.1", server.port)]

    def test_a_redirect_inside_is_refused(self, server):
        server.routes["/logo.png"] = (302, {"Location": "http://internal.example/secret.png"}, b"")
        resolve = _names({"logo.example": ["127.0.0.1"], "internal.example": ["10.0.0.5"]})
        assert fetch_image(f"http://logo.example:{server.port}/logo.png", resolve=resolve, allowed=only_our_loopback) is None
        assert server.hits == ["/logo.png"]

    def test_a_redirect_outside_is_followed(self, server):
        server.routes["/old.png"] = (301, {"Location": "/new.png"}, b"")
        server.routes["/new.png"] = (200, {}, _png())
        image = fetch_image(f"http://logo.example:{server.port}/old.png",
                            resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback)
        assert image is not None
        assert server.hits == ["/old.png", "/new.png"]

    def test_redirects_end(self, server):
        server.routes["/loop.png"] = (302, {"Location": "/loop.png"}, b"")
        assert fetch_image(f"http://logo.example:{server.port}/loop.png",
                           resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback) is None
        assert len(server.hits) == remote_image.MAX_REDIRECTS + 1

    def test_too_large_by_its_header(self, server):
        server.routes["/big.png"] = (200, {"Content-Length": str(remote_image.MAX_BYTES + 1)}, b"")
        assert fetch_image(f"http://logo.example:{server.port}/big.png",
                           resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback) is None

    def test_too_large_without_saying_so(self, server):
        def stream(handler):
            handler.send_response(200)
            handler.send_header("Connection", "close")
            handler.end_headers()
            chunk = b"\0" * 65536
            try:
                for _ in range(remote_image.MAX_BYTES // len(chunk) + 4):
                    handler.wfile.write(chunk)
            except OSError:
                pass

        server.routes["/endless.png"] = stream
        assert fetch_image(f"http://logo.example:{server.port}/endless.png",
                           resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback) is None

    def test_not_a_picture(self, server):
        server.routes["/page"] = (200, {"Content-Type": "text/html"}, b"<html>hello</html>")
        server.routes["/logo.svg"] = (200, {"Content-Type": "image/svg+xml"}, b"<svg xmlns='http://www.w3.org/2000/svg'/>")
        resolve = _names({"logo.example": ["127.0.0.1"]})
        assert fetch_image(f"http://logo.example:{server.port}/page", resolve=resolve, allowed=only_our_loopback) is None
        assert fetch_image(f"http://logo.example:{server.port}/logo.svg", resolve=resolve, allowed=only_our_loopback) is None

    def test_too_many_pixels_is_not_decoded(self, server):
        # A few kilobytes on the wire, 25 million pixels once decoded.
        bomb = _png((5000, 5000), mode="1")
        assert len(bomb) < remote_image.MAX_BYTES
        server.routes["/bomb.png"] = (200, {}, bomb)
        assert fetch_image(f"http://logo.example:{server.port}/bomb.png",
                           resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback) is None

    def test_a_slow_server_does_not_hold_the_request(self, server, monkeypatch):
        monkeypatch.setattr(remote_image, "DEADLINE_SECONDS", 0.6)

        def drip(handler):
            handler.send_response(200)
            handler.end_headers()
            try:
                for _ in range(40):
                    handler.wfile.write(b"\x89")
                    handler.wfile.flush()
                    time.sleep(0.1)
            except OSError:
                pass

        server.routes["/slow.png"] = drip
        started = time.monotonic()
        assert fetch_image(f"http://logo.example:{server.port}/slow.png",
                           resolve=_names({"logo.example": ["127.0.0.1"]}), allowed=only_our_loopback) is None
        assert time.monotonic() - started < 2.5

    def test_remembered_both_ways(self, server):
        server.routes["/logo.png"] = (200, {}, _png())
        resolve = _names({"logo.example": ["127.0.0.1"]})
        url = f"http://logo.example:{server.port}/logo.png"
        missing = f"http://logo.example:{server.port}/missing.png"
        assert fetch_image(url, resolve=resolve, allowed=only_our_loopback) is not None
        assert fetch_image(missing, resolve=resolve, allowed=only_our_loopback) is None
        assert fetch_image(url, resolve=resolve, allowed=only_our_loopback) is not None
        assert fetch_image(missing, resolve=resolve, allowed=only_our_loopback) is None
        assert server.hits == ["/logo.png", "/missing.png"]

    def test_requests_at_the_same_time_share_one_download(self, server):
        def slow_png(handler):
            time.sleep(0.4)
            body = _png()
            handler.send_response(200)
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)

        server.routes["/logo.png"] = slow_png
        url = f"http://logo.example:{server.port}/logo.png"
        resolve = _names({"logo.example": ["127.0.0.1"]})
        results = []
        threads = [threading.Thread(target=lambda: results.append(fetch_image(url, resolve=resolve, allowed=only_our_loopback))) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(results) == 5 and all(result is not None for result in results)
        assert server.hits == ["/logo.png"]
