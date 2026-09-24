"""Reading `getSignaturesForAddress` and `getTransaction` as JSON.

The backfill worker was dead from 2026-07-28 to 2026-09-24 and said so once a
minute in a sentence that reads like a network problem:
`data did not match any variant of untagged enum Resp`.

One failed transaction in the program's history carried
`err: {"InstructionError": [1, "BorshIoError"]}`. Solana v3 dropped the string
that variant used to hold; `solders` 0.14.4 still expects it. Because `Resp` is
an untagged enum, a member it cannot read fails the entire response, so the 99
good rows around it were lost with it, every pass, for two months.

The record below is the real one, copied from mainnet on 2026-09-24. It is the
whole point of this module, so it is the thing the tests are built on.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.solana_rpc import (  # noqa: E402
    SolanaJsonRpc,
    SolanaRpcError,
    SolanaRpcTransportError,
    redact,
    signature_failed,
)

PROGRAM = "4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH"
ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=secret-key-value"

#: The transaction that stopped the worker. Verbatim, BorshIoError and all.
POISON = {
    "signature": "ZFdevNAFxG9sb2C6CiZ3MLP13PJx1LB56idHgU82NeMXL9ErGu5Xg1ggXqFp6kyh62HKih5mMjGQ53pQkeDBD8D",
    "slot": 435753507,
    "err": {"InstructionError": [1, "BorshIoError"]},
    "memo": None,
    "blockTime": 1785246070,
    "confirmationStatus": "finalized",
    "transactionIndex": 537,
}


def ok_row(n: int) -> dict:
    return {
        "signature": f"sig{n:02d}",
        "slot": 449165287 - n,
        "err": None,
        "memo": None,
        "blockTime": 1790023156 - n,
        "confirmationStatus": "finalized",
        "transactionIndex": 1000 + n,
    }


def answering(body, *, status: int = 200, text: str | None = None):
    """An RPC that always replies with this, and records what it was asked."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handler), seen


def run(coro):
    return asyncio.run(coro)


async def with_rpc(transport, call):
    async with SolanaJsonRpc(ENDPOINT, transport=transport) as rpc:
        return await call(rpc)


class TestTheTransactionThatStoppedTheWorker:
    def test_a_page_holding_it_still_comes_back_whole(self):
        # 100 rows, the poison one sitting in the middle exactly as on mainnet.
        rows = [ok_row(n) for n in range(52)] + [POISON] + [ok_row(n) for n in range(53, 100)]
        transport, _ = answering({"jsonrpc": "2.0", "id": 1, "result": rows})

        got = run(with_rpc(transport, lambda rpc: rpc.get_signatures_for_address(PROGRAM, limit=100)))

        assert len(got) == 100
        assert got[52]["signature"] == POISON["signature"]
        # The 99 rows around it are what the worker actually needed.
        assert got[0]["signature"] == "sig00"
        assert got[99]["signature"] == "sig99"

    def test_the_error_is_carried_through_untouched(self):
        transport, _ = answering({"jsonrpc": "2.0", "id": 1, "result": [POISON]})

        got = run(with_rpc(transport, lambda rpc: rpc.get_signatures_for_address(PROGRAM, limit=1)))

        # Not decoded into anything. Whatever the validator sends, we keep.
        assert got[0]["err"] == {"InstructionError": [1, "BorshIoError"]}
        assert signature_failed(got[0]) is True

    def test_a_transaction_carrying_it_is_readable_too(self):
        # getTransaction broke on the same record, so the fix has to cover both.
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "slot": 435753507,
                "meta": {
                    "err": {"InstructionError": [1, "BorshIoError"]},
                    "logMessages": ["Program log: boom"],
                },
            },
        }
        transport, _ = answering(body)

        got = run(with_rpc(transport, lambda rpc: rpc.get_transaction(POISON["signature"])))

        assert got["meta"]["err"] == {"InstructionError": [1, "BorshIoError"]}
        assert got["meta"]["logMessages"] == ["Program log: boom"]


class TestTheShapeTheWorkersRead:
    def test_a_successful_row_is_not_marked_failed(self):
        assert signature_failed(ok_row(1)) is False

    def test_the_keys_are_the_wire_keys(self):
        # `_extract_transaction_log_messages` reads `meta.logMessages`, camelCase,
        # which is what the node sends and what the dict branch of that helper
        # was written for.
        body = {"jsonrpc": "2.0", "id": 1, "result": {"meta": {"err": None, "logMessages": ["a", "b"]}}}
        transport, _ = answering(body)

        got = run(with_rpc(transport, lambda rpc: rpc.get_transaction("sig")))

        assert got["meta"]["logMessages"] == ["a", "b"]

    def test_a_missing_transaction_is_none_not_a_crash(self):
        transport, _ = answering({"jsonrpc": "2.0", "id": 1, "result": None})

        got = run(with_rpc(transport, lambda rpc: rpc.get_transaction("sig")))

        assert got is None

    def test_an_empty_listing_is_an_empty_list(self):
        transport, _ = answering({"jsonrpc": "2.0", "id": 1, "result": []})

        got = run(with_rpc(transport, lambda rpc: rpc.get_signatures_for_address(PROGRAM, limit=10)))

        assert got == []


class TestWhatGetsAsked:
    def test_before_and_limit_reach_the_node(self):
        transport, seen = answering({"jsonrpc": "2.0", "id": 1, "result": []})

        run(with_rpc(
            transport,
            lambda rpc: rpc.get_signatures_for_address(PROGRAM, limit=100, before="abc"),
        ))

        assert seen[0]["method"] == "getSignaturesForAddress"
        assert seen[0]["params"][0] == PROGRAM
        assert seen[0]["params"][1] == {"limit": 100, "before": "abc"}

    def test_before_is_left_out_when_there_is_none(self):
        transport, seen = answering({"jsonrpc": "2.0", "id": 1, "result": []})

        run(with_rpc(transport, lambda rpc: rpc.get_signatures_for_address(PROGRAM, limit=20)))

        # Sending `before: null` is not the same request as not sending it.
        assert seen[0]["params"][1] == {"limit": 20}

    def test_the_transaction_options_match_what_the_workers_used(self):
        transport, seen = answering({"jsonrpc": "2.0", "id": 1, "result": None})

        run(with_rpc(transport, lambda rpc: rpc.get_transaction("sig", commitment="confirmed")))

        assert seen[0]["method"] == "getTransaction"
        assert seen[0]["params"][1] == {
            "encoding": "jsonParsed",
            "commitment": "confirmed",
            "maxSupportedTransactionVersion": 0,
        }

    def test_objects_are_stringified(self):
        # Callers pass a Pubkey or a Signature, not a str.
        class Sig:
            def __str__(self):
                return "from-an-object"

        transport, seen = answering({"jsonrpc": "2.0", "id": 1, "result": None})

        run(with_rpc(transport, lambda rpc: rpc.get_transaction(Sig())))

        assert seen[0]["params"][0] == "from-an-object"


class TestFailuresThatUsedToLookAlike:
    """One opaque sentence for every kind of failure is what hid this for months."""

    def test_an_rpc_error_says_the_code_and_the_message(self):
        body = {"jsonrpc": "2.0", "id": 1, "error": {"code": -32429, "message": "max usage reached"}}
        transport, _ = answering(body)

        with pytest.raises(SolanaRpcError) as caught:
            run(with_rpc(transport, lambda rpc: rpc.get_signatures_for_address(PROGRAM, limit=10)))

        assert caught.value.code == -32429
        assert "max usage reached" in caught.value.message
        assert "getSignaturesForAddress" in str(caught.value)

    def test_an_http_error_keeps_the_body(self):
        transport, _ = answering(None, status=429, text="max usage reached")

        with pytest.raises(SolanaRpcTransportError) as caught:
            run(with_rpc(transport, lambda rpc: rpc.get_transaction("sig")))

        assert "429" in str(caught.value)
        assert "max usage reached" in str(caught.value)

    def test_an_html_error_page_is_not_a_json_crash(self):
        transport, _ = answering(None, status=200, text="<html>502 Bad Gateway</html>")

        with pytest.raises(SolanaRpcTransportError):
            run(with_rpc(transport, lambda rpc: rpc.get_transaction("sig")))

    def test_a_dead_host_names_the_host_and_nothing_else(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("nope", request=request)

        with pytest.raises(SolanaRpcTransportError) as caught:
            run(with_rpc(httpx.MockTransport(handler), lambda rpc: rpc.get_transaction("sig")))

        assert "ConnectError" in str(caught.value)


class TestTheKeyStaysOutOfTheLogs:
    """The endpoint carries the Helius key in its query string."""

    def test_redact_drops_the_query(self):
        assert redact(ENDPOINT) == "https://mainnet.helius-rpc.com/"

    def test_redact_leaves_a_plain_url_alone(self):
        assert redact("https://api.mainnet-beta.solana.com") == "https://api.mainnet-beta.solana.com"

    @pytest.mark.parametrize(
        "make_transport",
        [
            lambda: answering(None, status=429, text="slow down")[0],
            lambda: answering({"jsonrpc": "2.0", "id": 1, "error": {"code": -1, "message": "no"}})[0],
        ],
    )
    def test_no_failure_puts_the_key_in_its_message(self, make_transport):
        with pytest.raises((SolanaRpcError, SolanaRpcTransportError)) as caught:
            run(with_rpc(make_transport(), lambda rpc: rpc.get_transaction("sig")))

        assert "secret-key-value" not in str(caught.value)
        assert "api-key" not in str(caught.value)
