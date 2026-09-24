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


def _upstream_urls() -> list[str]:
    """
    The Solana RPC upstreams the proxy forwards to, best first.

    Helius comes first: the public api.mainnet-beta.solana.com endpoint answers
    403 to browser-originated requests, so it cannot be the only one. But it
    cannot be the only one the other way round either. On 2026-09-22 the devnet
    plan ran out of credits and answered `-32429 max usage reached` to every
    method that costs anything. The proxy had no second address to try, so the
    site lost the chain completely: no blockhash, so no transaction to sign, and
    the wallet simply did not work. A working endpoint was configured the whole
    time and nothing looked at it.

    So the configured endpoint is kept as a second entry, and the caller falls
    through to it when the first one says it is out or broken.
    """
    settings = get_settings()
    urls: list[str] = []
    if settings.helius_api_key:
        base = settings.helius_das_base_url.rstrip("/")
        if settings.network == "devnet" and base == "https://mainnet.helius-rpc.com":
            base = "https://devnet.helius-rpc.com"
        urls.append(f"{base}/?api-key={settings.helius_api_key}")
    fallback = (settings.solana_http_endpoint or "").strip()
    if fallback and fallback not in urls:
        urls.append(fallback)
    return urls or [settings.solana_http_endpoint]


# Helius answers 200 with this JSON-RPC code when the plan's credits are spent,
# so the failure never reaches the HTTP error path and has to be read out of the
# body.
_QUOTA_ERROR_CODE = -32429


def _is_exhausted(raw: bytes) -> bool:
    """Whether an upstream answered 200 but said it has nothing left to give."""
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return False
    items = payload if isinstance(payload, list) else [payload]
    for item in items:
        if not isinstance(item, dict):
            continue
        err = item.get("error")
        if isinstance(err, dict) and err.get("code") == _QUOTA_ERROR_CODE:
            return True
    return False


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


def _safe_url(url: str) -> str:
    """The upstream without its key, so a log line can name it."""
    return url.split("?", 1)[0]


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

    urls = _upstream_urls()
    last_status: int | None = None
    last_text = ""
    last_url_error: Exception | None = None

    for index, url in enumerate(urls):
        remaining = len(urls) - index - 1
        try:
            raw = await asyncio.to_thread(
                _forward_rpc_request,
                body,
                url,
                settings.rpc_proxy_timeout_seconds,
            )
        except error.HTTPError as exc:
            try:
                last_text = exc.read().decode("utf-8")
            except Exception:
                last_text = str(exc)
            last_status = exc.code
            # 429 is the plan being spent or the rate being too high, 5xx is the
            # provider having a bad minute. Both are reasons to ask somebody
            # else. A 4xx that is not 429 is our own request being wrong, and
            # the next upstream would reject it the same way.
            if remaining and (exc.code == 429 or exc.code >= 500):
                logger.warning(
                    "RPC upstream %s answered %s; trying the next one", _safe_url(url), exc.code
                )
                continue
            logger.error("RPC proxy upstream error (status=%s, response=%s)", exc.code, last_text)
            # Surface the upstream status so the client can distinguish rate
            # limits from real RPC errors.
            return Response(content=last_text, status_code=exc.code, media_type="application/json")
        except error.URLError as exc:
            last_url_error = exc
            if remaining:
                logger.warning(
                    "RPC upstream %s is unreachable (%s); trying the next one", _safe_url(url), exc
                )
                continue
            logger.error("RPC proxy upstream unavailable (error=%s)", exc)
            raise HTTPException(status_code=502, detail="Solana RPC upstream unavailable") from exc

        # A spent plan answers 200 and puts the refusal in the body, so the
        # status code alone would have called this a success.
        if remaining and _is_exhausted(raw):
            logger.warning(
                "RPC upstream %s has no credits left; trying the next one", _safe_url(url)
            )
            last_status = 200
            last_text = raw.decode("utf-8", "replace")
            continue

        return Response(content=raw, media_type="application/json")

    # Every upstream refused. Hand back the last thing one of them said.
    if last_url_error is not None:
        raise HTTPException(status_code=502, detail="Solana RPC upstream unavailable")
    logger.error("Every RPC upstream refused (last status=%s, response=%s)", last_status, last_text)
    return Response(content=last_text, status_code=last_status or 502, media_type="application/json")
