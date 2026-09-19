import json
import logging
from urllib import request, error

from shared.settings import get_settings

logger = logging.getLogger(__name__)

#: The purchase feed is read from the pool page — no reason to wait long for it.
PURCHASES_TIMEOUT_SECONDS = 4.0


class OffchainApiClient:
    """
    Client for offchain API execute endpoint.
    """

    def execute_lottery(self, payload: dict[str, object]) -> dict[str, object]:
        settings = get_settings()
        url = f"{settings.offchain_api_base_url.rstrip('/')}/execute"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if settings.offchain_api_key:
            headers["x-api-key"] = settings.offchain_api_key

        req = request.Request(
            url=url,
            method="POST",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
        )
        logger.info("Offchain execute started (url=%s, lotteryId=%s)", url, payload.get("lotteryId"))

        try:
            with request.urlopen(req, timeout=settings.offchain_api_timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            response_text = ""
            try:
                response_text = exc.read().decode("utf-8")
            except Exception:
                response_text = str(exc)
            normalized_response = response_text.lower()
            if exc.code == 409 and (
                "already running" in normalized_response
                or "state file already exists" in normalized_response
            ):
                logger.info(
                    "Offchain execute already started or completed (status=%s, response=%s)",
                    exc.code,
                    response_text,
                )
            else:
                logger.error(
                    "Offchain execute failed (status=%s, response=%s)",
                    exc.code,
                    response_text,
                )
            raise RuntimeError(f"offchain-api HTTP {exc.code}: {response_text}") from exc
        except error.URLError as exc:
            logger.error("Offchain execute unavailable (url=%s, error=%s)", url, exc)
            raise RuntimeError(f"offchain-api is unavailable at {url}: {exc}") from exc

        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            logger.error("Offchain execute returned invalid JSON (raw=%s)", raw)
            raise RuntimeError(f"offchain-api returned invalid JSON: {raw}") from exc

        if not isinstance(parsed, dict):
            logger.error("Offchain execute returned non-object JSON (type=%s)", type(parsed).__name__)
            raise RuntimeError("offchain-api returned non-object JSON")
        logger.info("Offchain execute succeeded (lotteryId=%s)", payload.get("lotteryId"))
        return parsed


    def fetch_purchases(self, lottery_id: int | str) -> dict[str, object] | None:
        """What the buyer has bought for this round. None means it is silent or does not know it.

        The pool page needs the answer, so the request is short: better to show
        the feed a second later than to hold somebody's request for a minute.
        """
        settings = get_settings()
        url = f"{settings.offchain_api_base_url.rstrip('/')}/execute/{lottery_id}/purchases"
        headers = {"Accept": "application/json"}
        if settings.offchain_api_key:
            headers["x-api-key"] = settings.offchain_api_key

        req = request.Request(url=url, method="GET", headers=headers)
        try:
            with request.urlopen(req, timeout=PURCHASES_TIMEOUT_SECONDS) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            if exc.code == 404:
                return None
            logger.warning("Offchain purchases failed (status=%s, lotteryId=%s)", exc.code, lottery_id)
            return None
        except error.URLError as exc:
            logger.warning("Offchain purchases unavailable (url=%s, error=%s)", url, exc)
            return None

        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            logger.warning("Offchain purchases returned invalid JSON (lotteryId=%s)", lottery_id)
            return None

        return parsed if isinstance(parsed, dict) else None


def build_offchain_api_client() -> OffchainApiClient:
    return OffchainApiClient()
