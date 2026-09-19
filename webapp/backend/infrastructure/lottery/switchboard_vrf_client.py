import json
import logging
from urllib import request, error

from solders.pubkey import Pubkey

from shared.settings import get_settings

logger = logging.getLogger(__name__)


class VrfServiceClient:
    """
    Switchboard VRF client that delegates randomness operations to external Node.js vrf-service.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        settings = get_settings()
        self.base_url = (base_url or settings.vrf_service_base_url).rstrip("/")
        self.api_key = settings.vrf_service_api_key if api_key is None else api_key
        self.timeout_seconds = timeout_seconds or settings.vrf_service_timeout_seconds

    def create_randomness_account(self) -> str:
        logger.info("VRF create_randomness_account started")
        payload = self._post_json("/v1/randomness-accounts", {})
        candidate = str(payload.get("randomness_account", "")).strip()
        if not candidate:
            logger.error("VRF create_randomness_account failed: empty randomness_account in response")
            raise RuntimeError("vrf-service returned empty randomness_account")
        Pubkey.from_string(candidate)
        logger.info("VRF create_randomness_account succeeded (randomness_account=%s)", candidate)
        return candidate

    def request_randomness(self, randomness_account: str) -> str:
        logger.info("VRF request_randomness started (randomness_account=%s)", randomness_account)
        Pubkey.from_string(randomness_account)
        payload = self._post_json(
            "/v1/randomness-requests",
            {"randomness_account": randomness_account},
        )
        request_id = str(payload.get("request_id", "")).strip()
        if not request_id:
            logger.error(
                "VRF request_randomness failed: empty request_id (randomness_account=%s)",
                randomness_account,
            )
            raise RuntimeError("vrf-service returned empty request_id")
        logger.info(
            "VRF request_randomness succeeded (randomness_account=%s, request_id=%s)",
            randomness_account,
            request_id,
        )
        return request_id

    def close_randomness_account(self, randomness_account: str) -> str:
        Pubkey.from_string(randomness_account)
        payload = self._post_json(
            "/v1/randomness-accounts/close",
            {"randomness_account": randomness_account},
        )
        close_signature = str(payload.get("close_signature", "")).strip()
        if not close_signature:
            raise RuntimeError("vrf-service returned empty close_signature")
        return close_signature

    def reveal_randomness(self, randomness_account: str) -> tuple[str, str | None]:
        logger.info("VRF reveal_randomness started (randomness_account=%s)", randomness_account)
        Pubkey.from_string(randomness_account)
        payload = self._post_json(
            "/v1/randomness-reveal",
            {"randomness_account": randomness_account},
        )
        reveal_signature = str(payload.get("reveal_signature", "")).strip()
        if not reveal_signature:
            logger.error(
                "VRF reveal_randomness failed: empty reveal_signature (randomness_account=%s)",
                randomness_account,
            )
            raise RuntimeError("vrf-service returned empty reveal_signature")
        value_hex = payload.get("value_hex")
        value_hex_str = str(value_hex).strip() if value_hex is not None else None
        logger.info(
            "VRF reveal_randomness succeeded (randomness_account=%s, reveal_signature=%s, value_hex=%s)",
            randomness_account,
            reveal_signature,
            value_hex_str,
        )
        return reveal_signature, value_hex_str

    def get_randomness_account_data(self, randomness_account: str) -> dict[str, object]:
        logger.info("VRF get_randomness_account_data started (randomness_account=%s)", randomness_account)
        Pubkey.from_string(randomness_account)
        payload = self._get_json(f"/v1/randomness-accounts/{randomness_account}")
        logger.info("VRF get_randomness_account_data succeeded (randomness_account=%s)", randomness_account)
        return payload

    def _post_json(self, path: str, body: dict[str, object]) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key

        req = request.Request(
            url=url,
            method="POST",
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
        )
        logger.info("VRF HTTP POST started (path=%s, url=%s)", path, url)

        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            response_text = ""
            try:
                response_text = exc.read().decode("utf-8")
            except Exception:
                response_text = str(exc)
            logger.error(
                "VRF HTTP POST failed (path=%s, status=%s, response=%s)",
                path,
                exc.code,
                response_text,
            )
            raise RuntimeError(f"vrf-service HTTP {exc.code}: {response_text}") from exc
        except error.URLError as exc:
            logger.error("VRF HTTP POST unavailable (path=%s, url=%s, error=%s)", path, url, exc)
            raise RuntimeError(f"vrf-service is unavailable at {url}: {exc}") from exc

        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            logger.error("VRF HTTP POST invalid JSON (path=%s, raw=%s)", path, raw)
            raise RuntimeError(f"vrf-service returned invalid JSON: {raw}") from exc

        if not isinstance(parsed, dict):
            logger.error("VRF HTTP POST non-object JSON (path=%s, type=%s)", path, type(parsed).__name__)
            raise RuntimeError("vrf-service returned non-object JSON")
        logger.info("VRF HTTP POST succeeded (path=%s)", path)
        return parsed

    def _get_json(self, path: str) -> dict[str, object]:
        url = f"{self.base_url}{path}"
        headers = {
            "Accept": "application/json",
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key

        req = request.Request(
            url=url,
            method="GET",
            headers=headers,
        )
        logger.info("VRF HTTP GET started (path=%s, url=%s)", path, url)

        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            response_text = ""
            try:
                response_text = exc.read().decode("utf-8")
            except Exception:
                response_text = str(exc)
            logger.error(
                "VRF HTTP GET failed (path=%s, status=%s, response=%s)",
                path,
                exc.code,
                response_text,
            )
            raise RuntimeError(f"vrf-service HTTP {exc.code}: {response_text}") from exc
        except error.URLError as exc:
            logger.error("VRF HTTP GET unavailable (path=%s, url=%s, error=%s)", path, url, exc)
            raise RuntimeError(f"vrf-service is unavailable at {url}: {exc}") from exc

        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError as exc:
            logger.error("VRF HTTP GET invalid JSON (path=%s, raw=%s)", path, raw)
            raise RuntimeError(f"vrf-service returned invalid JSON: {raw}") from exc

        if not isinstance(parsed, dict):
            logger.error("VRF HTTP GET non-object JSON (path=%s, type=%s)", path, type(parsed).__name__)
            raise RuntimeError("vrf-service returned non-object JSON")
        logger.info("VRF HTTP GET succeeded (path=%s)", path)
        return parsed


def build_vrf_service_client() -> VrfServiceClient:
    return VrfServiceClient()
