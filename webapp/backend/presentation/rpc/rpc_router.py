import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from typing import Any
from urllib import request, error

from fastapi import APIRouter, Request, Response, HTTPException

from shared.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/rpc", tags=["rpc"])

# Reject oversized payloads early. Solana JSON-RPC requests are tiny; large
# bodies are almost certainly abuse.
_MAX_BODY_BYTES = 256 * 1024
_RATE_LIMIT_WINDOW_SECONDS = 60
_RATE_LIMIT_BUCKETS: dict[str, deque[float]] = defaultdict(deque)

# Keep the public proxy narrowly scoped to the methods needed by web3.js,
# Anchor transaction flows, and the existing admin read screens.
_ALLOWED_METHODS = frozenset({
    "getAccountInfo",
    "getBalance",
    "getBlockHeight",
    "getEpochInfo",
    "getFeeForMessage",
    "getHealth",
    "getLatestBlockhash",
    "getMinimumBalanceForRentExemption",
    "getMultipleAccounts",
    # What people are paying for queue position right now. The page offers a
    # commit priority fee from these samples: without one a transaction may not
    # arrive during a busy hour, and taking the price from the ceiling means overpaying.
    "getRecentPrioritizationFees",
    "getSignatureStatuses",
    "getSignaturesForAddress",
    "getTokenAccountBalance",
    "getTransaction",
    "getVersion",
    "isBlockhashValid",
    "sendTransaction",
    "simulateTransaction",
})


def _upstream_url() -> str:
    """
    Build the Solana RPC upstream the proxy forwards to.

    Prefers Helius (the public api.mainnet-beta.solana.com endpoint returns 403
    for browser-originated requests). Falls back to the configured public
    endpoint when no Helius key is set.
    """
    settings = get_settings()
    if settings.helius_api_key:
        base = settings.helius_das_base_url.rstrip("/")
        if settings.network == "devnet" and base == "https://mainnet.helius-rpc.com":
            base = "https://devnet.helius-rpc.com"
        return f"{base}/?api-key={settings.helius_api_key}"
    return settings.solana_http_endpoint


def _client_ip(http_request: Request) -> str:
    forwarded_for = http_request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip() or "unknown"
    if http_request.client and http_request.client.host:
        return http_request.client.host
    return "unknown"


def _prune_rate_limit_buckets(now: float) -> None:
    """Throw out the counters of anyone long gone: otherwise the dictionary grows forever."""
    stale = [ip for ip, bucket in _RATE_LIMIT_BUCKETS.items() if not bucket or now - bucket[-1] >= _RATE_LIMIT_WINDOW_SECONDS]
    for ip in stale:
        _RATE_LIMIT_BUCKETS.pop(ip, None)


def _enforce_rate_limit(client_ip: str, max_requests_per_minute: int) -> None:
    if max_requests_per_minute <= 0:
        return

    now = time.monotonic()
    if len(_RATE_LIMIT_BUCKETS) > 1024:
        _prune_rate_limit_buckets(now)
    bucket = _RATE_LIMIT_BUCKETS[client_ip]
    while bucket and now - bucket[0] >= _RATE_LIMIT_WINDOW_SECONDS:
        bucket.popleft()

    if len(bucket) >= max_requests_per_minute:
        raise HTTPException(status_code=429, detail="RPC rate limit exceeded")

    bucket.append(now)


def _parse_rpc_payload(body: bytes) -> list[dict[str, Any]]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON-RPC payload") from exc

    if isinstance(payload, list):
        requests = payload
    else:
        requests = [payload]

    if not requests or not all(isinstance(item, dict) for item in requests):
        raise HTTPException(status_code=400, detail="Invalid JSON-RPC request")

    return requests


def _validate_rpc_payload(body: bytes, max_batch_size: int) -> None:
    requests = _parse_rpc_payload(body)
    if max_batch_size > 0 and len(requests) > max_batch_size:
        raise HTTPException(status_code=413, detail="RPC batch too large")

    for item in requests:
        method = item.get("method")
        if not isinstance(method, str) or not method:
            raise HTTPException(status_code=400, detail="JSON-RPC method is required")
        if method not in _ALLOWED_METHODS:
            raise HTTPException(status_code=403, detail=f"RPC method not allowed: {method}")


def _forward_rpc_request(body: bytes, url: str, timeout_seconds: float) -> bytes:
    req = request.Request(
        url=url,
        method="POST",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        return response.read()


@router.post("")
async def proxy_rpc(http_request: Request) -> Response:
    body = await http_request.body()
    if len(body) > _MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="RPC payload too large")

    settings = get_settings()
    _enforce_rate_limit(_client_ip(http_request), settings.rpc_proxy_rate_limit_per_minute)
    _validate_rpc_payload(body, settings.rpc_proxy_max_batch_size)

    url = _upstream_url()

    try:
        raw = await asyncio.to_thread(
            _forward_rpc_request,
            body,
            url,
            settings.rpc_proxy_timeout_seconds,
        )
    except error.HTTPError as exc:
        response_text = ""
        try:
            response_text = exc.read().decode("utf-8")
        except Exception:
            response_text = str(exc)
        logger.error("RPC proxy upstream error (status=%s, response=%s)", exc.code, response_text)
        # Surface the upstream status so the client can distinguish rate limits
        # from real RPC errors.
        return Response(content=response_text, status_code=exc.code, media_type="application/json")
    except error.URLError as exc:
        logger.error("RPC proxy upstream unavailable (error=%s)", exc)
        raise HTTPException(status_code=502, detail="Solana RPC upstream unavailable") from exc

    return Response(content=raw, media_type="application/json")
