"""Two RPC methods read as plain JSON, without the typed response parser.

On 2026-07-28 the backfill worker stopped and nobody noticed for two months.
Its cursor froze at 16:58 UTC that day. Every pass since then logged
`data did not match any variant of untagged enum Resp` and gave up.

The cause was one failed transaction in the program's history, at 13:41 UTC the
same day, carrying `err: {"InstructionError": [1, "BorshIoError"]}`. Solana v3
turned `BorshIoError` from a variant holding a string into a bare one, and
`solders` 0.14.4 only knows the old shape. `Resp` is an untagged enum, so a
member it cannot read does not come back as a null field: the **whole response**
fails to parse. One old transaction the worker did not even want was enough to
hide every new one behind it.

Two things made it expensive. The worker asked the library to decode an error
enum it never reads -- all it wants from `getSignaturesForAddress` is the
signature string. And the failure surfaced as one opaque sentence with no code,
no method and no body, which reads like a network hiccup.

So these two methods are read as JSON here: take the fields we use, leave the
rest alone. The validator's error set keeps growing and a client that decodes
every variant of it breaks again on the next one. A JSON-RPC error is raised as
`SolanaRpcError` with the code and message the node actually sent.

The rest of the RPC surface still goes through `solana-py`. This is not a
replacement for it, it is the tolerant reader for the two calls that walk over
other people's failed transactions.

`webapp/backend/tests/test_solana_rpc.py` pins the behaviour, the real response
from that transaction included.
"""
from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx

DEFAULT_TIMEOUT_SECONDS = 30.0

#: How much of an unexpected body reaches the log. Enough to recognise a rate
#: limit or an HTML error page, not enough to flood it.
_BODY_EXCERPT = 300


def redact(url: str) -> str:
    """The endpoint without its query string.

    The Helius key is a query parameter, so an error message that quotes the
    URL puts the key in the log. Only the host is ever worth reading anyway.
    """
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.scheme else url


class SolanaRpcError(RuntimeError):
    """The node answered, and the answer was a JSON-RPC error.

    Carries the code so a caller can tell "out of credits" (-32429) from
    "bad params" (-32602) without matching on prose.
    """

    def __init__(self, method: str, code: Any, message: str):
        self.method = method
        self.code = code
        self.message = message
        super().__init__(f"{method} failed: [{code}] {message}")


class SolanaRpcTransportError(RuntimeError):
    """The node did not answer, or answered with something that is not JSON."""


class SolanaJsonRpc:
    """A small JSON-RPC reader for the calls whose typed parsing is brittle.

    Used as an async context manager, in place of `solana.rpc.async_api.
    AsyncClient`, for the length of a worker loop::

        async with SolanaJsonRpc(endpoint) as rpc:
            rows = await rpc.get_signatures_for_address(program_id, limit=100)
    """

    def __init__(
        self,
        endpoint: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ):
        self._endpoint = endpoint
        self._safe_endpoint = redact(endpoint)
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)

    async def __aenter__(self) -> "SolanaJsonRpc":
        return self

    async def __aexit__(self, *_exc_info) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    async def _call(self, method: str, params: list[Any]) -> Any:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        try:
            response = await self._client.post(self._endpoint, json=payload)
        except httpx.HTTPError as exc:
            # httpx puts the full URL, key and all, into some of its messages.
            raise SolanaRpcTransportError(
                f"{method} to {self._safe_endpoint} failed: {type(exc).__name__}"
            ) from exc

        if response.status_code >= 400:
            # A rate limit and an exhausted plan both land here, and the body is
            # the only place that says which.
            raise SolanaRpcTransportError(
                f"{method} to {self._safe_endpoint} answered HTTP "
                f"{response.status_code}: {response.text[:_BODY_EXCERPT]}"
            )

        try:
            body = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise SolanaRpcTransportError(
                f"{method} to {self._safe_endpoint} answered non-JSON: "
                f"{response.text[:_BODY_EXCERPT]}"
            ) from exc

        if isinstance(body, dict) and body.get("error") is not None:
            error = body["error"]
            if isinstance(error, dict):
                raise SolanaRpcError(method, error.get("code"), str(error.get("message", "")))
            raise SolanaRpcError(method, None, str(error))

        if not isinstance(body, dict):
            raise SolanaRpcTransportError(
                f"{method} to {self._safe_endpoint} answered {type(body).__name__}, expected an object"
            )

        return body.get("result")

    async def get_signatures_for_address(
        self,
        address: Any,
        *,
        limit: int,
        before: Optional[Any] = None,
        commitment: Optional[str] = None,
    ) -> list[dict]:
        """Newest first, exactly as the node returns them.

        Each row keeps its own keys: `signature`, `err`, `slot`, `blockTime`.
        `err` is `None` for a transaction that succeeded, and any JSON at all
        for one that did not -- that is the field the typed parser choked on,
        and here it is simply carried through.
        """
        options: dict[str, Any] = {"limit": limit}
        if before is not None:
            options["before"] = str(before)
        if commitment is not None:
            options["commitment"] = commitment

        result = await self._call("getSignaturesForAddress", [str(address), options])
        if not isinstance(result, list):
            return []
        return [row for row in result if isinstance(row, dict)]

    async def get_transaction(
        self,
        signature: Any,
        *,
        encoding: str = "jsonParsed",
        commitment: Optional[str] = None,
        max_supported_transaction_version: Optional[int] = 0,
    ) -> Optional[dict]:
        """The transaction, or None when the node does not have it.

        The shape is the node's own, which is what `_extract_transaction_error`
        and `_extract_transaction_log_messages` already read: `meta.err` and
        `meta.logMessages`, in the camelCase the wire uses.
        """
        options: dict[str, Any] = {"encoding": encoding}
        if commitment is not None:
            options["commitment"] = commitment
        if max_supported_transaction_version is not None:
            options["maxSupportedTransactionVersion"] = max_supported_transaction_version

        result = await self._call("getTransaction", [str(signature), options])
        return result if isinstance(result, dict) else None


def signature_failed(row: dict) -> bool:
    """Whether this row of `getSignaturesForAddress` is a failed transaction.

    The listing already says so. Fetching the whole transaction to find out
    costs a round trip on a rate-limited plan and answers the same question.
    """
    return row.get("err") is not None
