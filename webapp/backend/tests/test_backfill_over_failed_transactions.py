"""The backfill worker walking past transactions that failed on chain.

This is the regression for the outage of 2026-07-28. The worker pages back
through the program's signatures looking for its cursor. One of those rows was
a transaction that failed with `err: {"InstructionError": [1, "BorshIoError"]}`,
a shape `solders` 0.14.4 cannot decode, and because the RPC response is an
untagged enum the failure took the whole page with it. The worker never reached
its cursor, never processed an event, and repeated the same unhelpful line
once a minute for two months.

On the code as it was, `_collect_new_signatures` asked `solana-py` for typed
objects and raised `SerdeJSONError` on the page below. It now reads the rows as
JSON and only touches the fields it uses.

The second thing checked here: a row already carries `err`, so the worker has
no reason to fetch a failed transaction in full just to discard it.
"""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "postgresql://user:pass@127.0.0.1:5432/test")

import backfill_worker as worker  # noqa: E402

PROGRAM = "4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH"

#: The row that stopped the worker, as mainnet returned it on 2026-09-24.
POISON = {
    "signature": "ZFdevNAFxG9sb2C6CiZ3MLP13PJx1LB56idHgU82NeMXL9ErGu5Xg1ggXqFp6kyh62HKih5mMjGQ53pQkeDBD8D",
    "slot": 435753507,
    "err": {"InstructionError": [1, "BorshIoError"]},
    "memo": None,
    "blockTime": 1785246070,
    "confirmationStatus": "finalized",
    "transactionIndex": 537,
}


def row(signature: str, err=None) -> dict:
    return {
        "signature": signature,
        "slot": 449165287,
        "err": err,
        "memo": None,
        "blockTime": 1790023156,
        "confirmationStatus": "finalized",
    }


class FakeRpc:
    """Pages of signatures, and a note of every transaction actually fetched."""

    def __init__(self, pages):
        self._pages = pages
        self.fetched: list[str] = []
        self.asked_before: list = []

    async def get_signatures_for_address(self, address, *, limit, before=None, commitment=None):
        self.asked_before.append(before)
        index = 0 if before is None else self._page_index(before)
        return self._pages[index] if index < len(self._pages) else []

    def _page_index(self, before):
        for i, page in enumerate(self._pages):
            if page and str(page[-1]["signature"]) == str(before):
                return i + 1
        return len(self._pages)

    async def get_transaction(self, signature, **_kwargs):
        self.fetched.append(str(signature))
        return {"meta": {"err": None, "logMessages": [f"Program log: {signature}"]}}


def run(coro):
    return asyncio.run(coro)


class TestPagingPastTheFailedTransaction:
    def test_the_cursor_is_reached_through_a_page_holding_it(self):
        # The cursor sits below the poison row, so the worker has to read past it.
        page = [row("new-1"), POISON, row("new-2"), row("cursor"), row("older")]
        rpc = FakeRpc([page])

        collected = run(worker._collect_new_signatures(rpc, PROGRAM, "cursor"))

        assert [r["signature"] for r in collected] == ["new-1", POISON["signature"], "new-2"]

    def test_it_stops_at_the_cursor_and_does_not_page_on(self):
        page = [row("new-1"), row("cursor"), row("older")]
        rpc = FakeRpc([page, [row("older-still")]])

        run(worker._collect_new_signatures(rpc, PROGRAM, "cursor"))

        # One request, with no `before`: the cursor was on the first page.
        assert rpc.asked_before == [None]

    def test_with_no_cursor_it_pages_until_the_node_runs_out(self):
        rpc = FakeRpc([[row("a"), row("b")], [row("c")], []])

        collected = run(worker._collect_new_signatures(rpc, PROGRAM, None))

        assert [r["signature"] for r in collected] == ["a", "b", "c"]

    def test_the_page_limit_is_respected(self, monkeypatch):
        monkeypatch.setattr(worker, "BACKFILL_MAX_SIGNATURES", 2)
        rpc = FakeRpc([[row("a"), row("b")], [row("c"), row("d")], []])

        collected = run(worker._collect_new_signatures(rpc, PROGRAM, None))

        assert len(collected) == 2


class TestFailedTransactionsAreNotFetched:
    @pytest.fixture
    def no_database(self, monkeypatch):
        saved: list[str] = []
        monkeypatch.setattr(worker, "_load_state", lambda *_a, **_k: None)
        monkeypatch.setattr(worker, "_save_state", lambda _s, _p, sig: saved.append(sig))
        monkeypatch.setattr(worker, "SessionLocal", lambda: _NullSession())
        monkeypatch.setattr(worker.event_worker, "_parse_logs", lambda *_a, **_k: None)
        return saved

    def test_a_row_with_an_error_is_skipped_without_a_round_trip(self, no_database):
        rpc = FakeRpc([[row("good"), POISON], []])

        run(worker._backfill_once(rpc, PROGRAM, parser=None))

        # Only the successful one was fetched.
        assert rpc.fetched == ["good"]

    def test_the_cursor_still_moves_over_the_failed_one(self, no_database):
        rpc = FakeRpc([[row("good"), POISON], []])

        run(worker._backfill_once(rpc, PROGRAM, parser=None))

        # Oldest first, so the cursor ends on the newest row of the batch.
        assert no_database == [POISON["signature"], "good"]

    def test_a_transaction_the_node_cannot_find_is_not_fatal(self, no_database, monkeypatch):
        rpc = FakeRpc([[row("gone")], []])

        async def missing(signature, **_kwargs):
            rpc.fetched.append(str(signature))
            return None

        monkeypatch.setattr(rpc, "get_transaction", missing)

        run(worker._backfill_once(rpc, PROGRAM, parser=None))

        assert no_database == ["gone"]


class _NullSession:
    def close(self):
        pass
