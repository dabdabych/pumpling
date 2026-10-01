"""No API key reaches a log line.

On 2026-09-29 the mainnet server's logs held the Helius key in five lines:
every worker printed its RPC endpoint, `?api-key=...` included, when it
started. From there it went to Loki and Grafana. These tests check the filter
and that every process that logs actually installs it.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.join(_ROOT, "workers"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

from shared.log_redaction import (  # noqa: E402
    _SECRET_PARAMETER,
    RedactSecretsFilter,
    install_log_redaction,
    redact,
)

KEY = "helius-test-key-0000"
ENDPOINT = f"https://mainnet.helius-rpc.com/?api-key={KEY}"


def _logger_into(buffer: io.StringIO, name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.handlers = []
    logger.propagate = False
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(logging.Formatter("%(levelname)s | %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    return logger


class TestTheText:
    def test_the_key_goes_and_the_address_stays(self):
        assert redact(ENDPOINT) == "https://mainnet.helius-rpc.com/?api-key=***"

    def test_other_parameters_are_left_alone(self):
        assert redact(f"https://x/?cluster=mainnet&api-key={KEY}&commitment=confirmed") == (
            "https://x/?cluster=mainnet&api-key=***&commitment=confirmed"
        )

    def test_every_spelling_of_a_credential(self):
        text = f"API_KEY={KEY} apikey={KEY} access_token={KEY} token={KEY} secret={KEY}"
        assert KEY not in redact(text)

    def test_a_word_that_only_ends_in_token_is_not_a_credential(self):
        assert redact("mytoken=keep") == "mytoken=keep"

    def test_the_buyer_scrubs_with_the_same_pattern(self):
        with open(os.path.join(_ROOT, "offchain", "logger.ts"), encoding="utf-8") as handle:
            source = handle.read()
        match = re.search(r"const SECRET_PARAMETER = /(.+)/gi;", source)
        assert match, "the buyer no longer declares SECRET_PARAMETER this way"
        assert match.group(1) == _SECRET_PARAMETER.pattern.removeprefix("(?i)")

    def test_an_escaped_quote_in_json_survives(self):
        line = json.dumps({"msg": f'call to "{ENDPOINT}" failed'})
        cleaned = redact(line)
        assert KEY not in cleaned
        assert json.loads(cleaned)["msg"] == 'call to "https://mainnet.helius-rpc.com/?api-key=***" failed'


class TestTheFilter:
    def test_a_startup_line_like_the_workers(self):
        buffer = io.StringIO()
        logger = _logger_into(buffer, "redaction.startup")
        install_log_redaction(logger)

        logger.info("Starting lottery lifecycle worker (rpc=%s, interval=%ss)", ENDPOINT, 1.0)

        out = buffer.getvalue()
        assert KEY not in out
        assert "rpc=https://mainnet.helius-rpc.com/?api-key=***, interval=1.0s" in out

    def test_an_exception_that_quotes_the_url(self):
        buffer = io.StringIO()
        logger = _logger_into(buffer, "redaction.exception")
        install_log_redaction(logger)

        try:
            raise RuntimeError(f"Client error '429 Too Many Requests' for url '{ENDPOINT}'")
        except RuntimeError:
            logger.exception("Polling error")

        out = buffer.getvalue()
        assert KEY not in out
        assert "Traceback" in out and "api-key=***" in out

    def test_every_handler_is_covered(self):
        first, second = io.StringIO(), io.StringIO()
        logger = _logger_into(first, "redaction.two")
        extra = logging.StreamHandler(second)
        logger.addHandler(extra)
        install_log_redaction(logger)

        logger.error("down: %s", ENDPOINT)

        assert KEY not in first.getvalue()
        assert KEY not in second.getvalue()

    def test_a_percent_left_in_the_text_stays_literal(self):
        buffer = io.StringIO()
        logger = _logger_into(buffer, "redaction.percent")
        install_log_redaction(logger)

        logger.info("100%% of %s", ENDPOINT)

        assert "100% of https://mainnet.helius-rpc.com/?api-key=***" in buffer.getvalue()

    def test_installing_twice_adds_one_filter(self):
        logger = _logger_into(io.StringIO(), "redaction.twice")
        install_log_redaction(logger)
        install_log_redaction(logger)

        filters = [f for f in logger.handlers[0].filters if isinstance(f, RedactSecretsFilter)]
        assert len(filters) == 1


@pytest.fixture
def clean_root():
    """The workers configure the root logger; give it back as it was."""
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    probe = logging.StreamHandler(io.StringIO())
    root.addHandler(probe)
    yield root, probe
    for handler in list(root.handlers):
        if handler not in handlers:
            root.removeHandler(handler)
    for handler in handlers:
        for f in [f for f in handler.filters if isinstance(f, RedactSecretsFilter)]:
            handler.removeFilter(f)
    root.setLevel(level)


def _covered(handler: logging.Handler) -> bool:
    return any(isinstance(f, RedactSecretsFilter) for f in handler.filters)


class TestEveryProcessInstallsIt:
    @pytest.mark.parametrize("module_name", ["backfill_worker", "bet_finalizer_worker", "events_worker"])
    def test_the_workers(self, clean_root, module_name):
        root, probe = clean_root
        module = __import__(module_name)

        module.setup_logging()

        assert _covered(probe), module_name
        assert all(_covered(handler) for handler in root.handlers), module_name

    def test_the_phase_worker(self, clean_root, monkeypatch):
        root, probe = clean_root
        import lottery_phase_worker as worker

        worker.setup_logging(worker._settings())

        assert _covered(probe)
        assert all(_covered(handler) for handler in root.handlers)

    def test_the_backend(self, clean_root):
        root, probe = clean_root
        import main

        uvicorn_logger = logging.getLogger("uvicorn")
        uvicorn_handler = logging.StreamHandler(io.StringIO())
        uvicorn_logger.addHandler(uvicorn_handler)
        try:
            main.configure_logging()

            assert _covered(probe)
            assert _covered(uvicorn_handler), "uvicorn's own handler, which the root never sees"
        finally:
            uvicorn_logger.removeHandler(uvicorn_handler)
