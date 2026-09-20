from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class AppSettings:
    network: str
    lottery_program_id: str
    lottery_admin_pubkey: str
    lottery_admin_pubkeys: str
    program_idl_path: str
    solana_http_endpoint: str
    phase2_worker_log_level: str
    phase2_automation_enabled: bool
    phase2_poll_interval_seconds: float
    phase2_cap_threshold_sol: Decimal
    phase2_skip_log_cooldown_seconds: float
    start_purchases_delay_seconds: int
    execution_countdown_seconds: int
    close_lottery_buffer_seconds: int
    lottery_admin_signer_keypair_json: str
    lottery_admin_signer_keypair_path: str
    lottery_admin_signer_keypairs_json: str
    lottery_admin_signer_keypair_paths: str
    telegram_error_bot_token: str
    telegram_error_chat_id: str
    telegram_notification_log_level: str
    telegram_api_base_url: str
    offchain_api_base_url: str
    offchain_api_key: str
    offchain_api_timeout_seconds: float
    helius_das_base_url: str
    helius_api_key: str
    dexscreener_user_agent: str
    wallet_auth_domain: str
    wallet_auth_uri: str
    wallet_auth_chain: str
    wallet_auth_nonce_ttl_seconds: int
    smtp_enabled: bool
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    smtp_from_email: str
    smtp_from_name: str
    smtp_use_tls: bool
    smtp_use_ssl: bool
    smtp_timeout_seconds: float
    registration_email_subject: str
    password_reset_email_subject: str
    public_app_base_url: str
    lottery_autostart_enabled: bool
    lottery_autostart_fee_wallet: str
    lottery_autostart_keeper_wallet: str
    lottery_autostart_max_total_sol: Decimal
    lottery_autostart_prediction_seconds: int
    #: The pause between the end of the buying and the next pool opening.
    lottery_autostart_gap_seconds: int
    lottery_hype_countdown_seconds: int
    lottery_autostart_fee_bps: int
    lottery_autostart_vrf_algorithm_hash: str
    rpc_proxy_rate_limit_per_minute: int
    rpc_proxy_max_batch_size: int
    #: How long to wait for the Solana RPC in the proxy. Separate from the
    #: buyer's timeout: the buyer works for an hour, while a wallet request must
    #: either go through or fail.
    rpc_proxy_timeout_seconds: float
    #: The shared ceiling for reference lookups (DexScreener, Helius DAS,
    #: Jupiter). They sit on the path of a live human request, and it is better
    #: to show a coin without market numbers than to hold someone for half a minute.
    external_lookup_timeout_seconds: float


def _env_str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a valid float") from exc
    if value <= 0:
        raise ValueError(f"{name} must be > 0")
    return value


def _env_float_non_negative(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a valid float") from exc
    if value < 0:
        raise ValueError(f"{name} must be >= 0")
    return value


def _env_decimal_positive(name: str, default: str) -> Decimal:
    raw = os.getenv(name, "").strip()
    if not raw:
        raw = default
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError(f"{name} must be a valid decimal") from exc
    if value <= 0:
        raise ValueError(f"{name} must be > 0")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a valid boolean")


def _env_int_non_negative(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a valid integer") from exc
    if value < 0:
        raise ValueError(f"{name} must be >= 0")
    return value


def _resolve_network() -> str:
    raw = (
        _env_str("NETWORK")
        or _env_str("SOLANA_NETWORK")
        or _env_str("WALLET_AUTH_CHAIN")
        or _env_str("SOLANA_HTTP_ENDPOINT")
        or _env_str("SOLANA_RPC_URL")
    ).lower()
    if "mainnet" in raw:
        return "mainnet"
    if "devnet" in raw:
        return "devnet"
    if "testnet" in raw:
        return "testnet"
    return "devnet"


def _default_execution_countdown_seconds(network: str) -> int:
    """The buying window: how long a round counts as "buying".

    55 minutes, not 65. The buyer spends 50 minutes on the main pass by default
    (`BUY_WINDOW_MINUTES`), leaving five on top for retries. It used to be 65,
    and the page promised an hour of buying where the buyer finished in fifty.

    After that comes the `lottery_autostart_gap_seconds` pause: the round sits
    at "done" with a countdown to the next pool. A full cycle on mainnet is 111
    minutes of commits, a couple of minutes of the draw, 55 of buying and 5 of pause.
    """
    if network == "devnet":
        return 15 * 60
    return 55 * 60


def _default_autostart_max_total_sol(network: str) -> str:
    # 111 SOL on both mainnet and devnet: an identical cap means a devnet run
    # reproduces a real round rather than a shrunken copy of it.
    # It used to be 222 and 2 respectively. The cap came down because the
    # pump.fun bonding curve holds ~85 real SOL before graduation: a pool of 222
    # tipped a coin onto a DEX irreversibly.
    return "111"


def _default_autostart_prediction_seconds(network: str) -> int:
    """
    The length of the first phase, the window for taking commits.

    It goes straight into the program: the autostart worker computes
    `end_ts = start_ts + this value` and passes both marks to `initialize`.

    111 minutes on mainnet and devnet alike (it was 125, before that 170, 105 and
    30). The same number as the pool cap: 111 SOL and 111 minutes are easier to
    hold in your head. To a person it is still "about two hours", which is what
    the site promises (the 0h / 2h / 3h scale in How it works).
    The same value on both networks means a devnet run reproduces a real round
    in time rather than a shortened version of it.

    This is an upper bound, not a fixed length: the phase closes early as soon as
    the vault reaches max_total.
    """
    return 111 * 60


def _default_solana_http_endpoint(network: str) -> str:
    if network == "mainnet":
        return "https://api.mainnet-beta.solana.com/"
    return "https://api.devnet.solana.com/"


def _default_wallet_auth_chain(network: str) -> str:
    if network == "mainnet":
        return "solana/mainnet"
    return "solana/devnet"


def _load_env_file(path: Path) -> None:
    if not path.exists() or not path.is_file():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def _load_env_defaults() -> None:
    # Support both layouts:
    # 1) local:   .../lottery/webapp/backend/shared/settings.py
    # 2) docker:  /app/shared/settings.py
    settings_path = Path(__file__).resolve()
    backend_dir = settings_path.parent.parent

    # Priority: already exported env vars > local overrides > project-level .env > backend-level .env
    # Try /app/.env in docker and .../lottery/.env in local layout.
    candidate_project_env = backend_dir.parent.parent / ".env"
    if not candidate_project_env.exists():
        candidate_project_env = backend_dir.parent / ".env"

    _load_env_file(candidate_project_env.with_name(".env.local"))
    _load_env_file(backend_dir / ".env.local")
    _load_env_file(candidate_project_env)
    _load_env_file(backend_dir / ".env")


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    _load_env_defaults()
    default_program_id = "4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH"
    default_admin_pubkey = "4TJdM678kP4hS6KMEoh79T3tANUNctHs7bE62MQSz72F"
    lottery_admin_pubkey = (
        _env_str("LOTTERY_ADMIN_PUBKEY")
        or _env_str("ADMIN_PUBKEY")
        or default_admin_pubkey
    )
    network = _resolve_network()
    return AppSettings(
        network=network,
        lottery_program_id=_env_str("LOTTERY_PROGRAM_ID") or _env_str("PROGRAM_ID") or default_program_id,
        lottery_admin_pubkey=lottery_admin_pubkey,
        lottery_admin_pubkeys=(
            _env_str("LOTTERY_ADMIN_PUBKEYS")
            or _env_str("ADMIN_PUBKEYS")
            or "4TJdM678kP4hS6KMEoh79T3tANUNctHs7bE62MQSz72F,CVsNzQNYgiebatxi2a8tBAvkFSXshg3seXgPR7DAziLq,EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ"
        ),
        program_idl_path=_env_str("PROGRAM_IDL_PATH"),
        solana_http_endpoint=_env_str("SOLANA_HTTP_ENDPOINT", _default_solana_http_endpoint(network)),
        phase2_worker_log_level=_env_str("PHASE2_WORKER_LOG_LEVEL", _env_str("WORKER_LOG_LEVEL", "INFO")).upper(),
        phase2_automation_enabled=_env_bool("PHASE2_AUTOMATION_ENABLED", True),
        phase2_poll_interval_seconds=_env_float("PHASE2_POLL_INTERVAL_SECONDS", 1.0),
        phase2_cap_threshold_sol=_env_decimal_positive("PHASE2_CAP_THRESHOLD_SOL", "110.95"),
        phase2_skip_log_cooldown_seconds=_env_float_non_negative("PHASE2_SKIP_LOG_COOLDOWN_SECONDS", 60.0),
        start_purchases_delay_seconds=_env_int_non_negative("START_PURCHASES_DELAY_SECONDS", 5),
        execution_countdown_seconds=_env_int_non_negative(
            "EXECUTION_COUNTDOWN_SECONDS",
            _default_execution_countdown_seconds(network),
        ),
        # A round is closed on chain five minutes before the end of the buying
        # window — exactly when the buyer finishes its main pass.
        close_lottery_buffer_seconds=_env_int_non_negative("CLOSE_LOTTERY_BUFFER_SECONDS", 5 * 60),
        lottery_admin_signer_keypair_json=_env_str("LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON"),
        lottery_admin_signer_keypair_path=_env_str("LOTTERY_ADMIN_SIGNER_KEYPAIR_PATH"),
        lottery_admin_signer_keypairs_json=_env_str("LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON"),
        lottery_admin_signer_keypair_paths=_env_str("LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS"),
        # The fallback names BOT_TOKEN/TARGET_CHAT_ID are left over from the old
        # production setup: if only those are set, the alerts must not vanish silently.
        telegram_error_bot_token=_env_str("TELEGRAM_ERROR_BOT_TOKEN") or _env_str("BOT_TOKEN"),
        telegram_error_chat_id=_env_str("TELEGRAM_ERROR_CHAT_ID") or _env_str("TARGET_CHAT_ID"),
        telegram_notification_log_level=_env_str("TELEGRAM_NOTIFICATION_LOG_LEVEL", "INFO").upper(),
        telegram_api_base_url=_env_str("TELEGRAM_API_BASE_URL", "https://api.telegram.org"),
        offchain_api_base_url=_env_str("OFFCHAIN_API_BASE_URL", "http://localhost:7657"),
        offchain_api_key=_env_str("OFFCHAIN_API_KEY"),
        offchain_api_timeout_seconds=_env_float("OFFCHAIN_API_TIMEOUT_SECONDS", 60.0),
        helius_das_base_url=_env_str("HELIUS_DAS_BASE_URL", "https://mainnet.helius-rpc.com"),
        helius_api_key=_env_str("HELIUS_API_KEY"),
        dexscreener_user_agent=_env_str(
            "DEXSCREENER_USER_AGENT",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        ),
        wallet_auth_domain=_env_str("WALLET_AUTH_DOMAIN", "pumpling.xyz"),
        wallet_auth_uri=_env_str("WALLET_AUTH_URI", "https://pumpling.xyz"),
        wallet_auth_chain=_env_str("WALLET_AUTH_CHAIN", _default_wallet_auth_chain(network)),
        wallet_auth_nonce_ttl_seconds=_env_int_non_negative("WALLET_AUTH_NONCE_TTL_SECONDS", 300),
        smtp_enabled=_env_bool("SMTP_ENABLED", True),
        smtp_host=_env_str("SMTP_HOST", "localhost"),
        smtp_port=_env_int_non_negative("SMTP_PORT", 2525),
        smtp_username=_env_str("SMTP_USERNAME"),
        smtp_password=_env_str("SMTP_PASSWORD"),
        smtp_from_email=_env_str("SMTP_FROM_EMAIL", "noreply@qrescrypto.local"),
        smtp_from_name=_env_str("SMTP_FROM_NAME", "Pumpling"),
        smtp_use_tls=_env_bool("SMTP_USE_TLS", False),
        smtp_use_ssl=_env_bool("SMTP_USE_SSL", False),
        smtp_timeout_seconds=_env_float("SMTP_TIMEOUT_SECONDS", 10.0),
        registration_email_subject=_env_str("REGISTRATION_EMAIL_SUBJECT", "Confirm your Pumpling account"),
        password_reset_email_subject=_env_str("PASSWORD_RESET_EMAIL_SUBJECT", "Reset your Pumpling password"),
        public_app_base_url=_env_str("PUBLIC_APP_BASE_URL", "http://localhost:3200"),
        lottery_autostart_enabled=_env_bool("LOTTERY_AUTOSTART_ENABLED", True),
        lottery_autostart_fee_wallet=_env_str(
            "LOTTERY_AUTOSTART_FEE_WALLET",
            "EGDo2JhA2c3QPDQLKV9Umgfn3srkYvRKmfXPAYasDLeJ",
        ),
        lottery_autostart_keeper_wallet=_env_str(
            "LOTTERY_AUTOSTART_KEEPER_WALLET",
            "6iBJFCS4jMKD8xTj78axawb6r8UASRJaDBz6cKSXx1a9",
        ),
        lottery_autostart_max_total_sol=_env_decimal_positive(
            "LOTTERY_AUTOSTART_MAX_TOTAL_SOL",
            _default_autostart_max_total_sol(network),
        ),
        lottery_autostart_prediction_seconds=_env_int_non_negative(
            "LOTTERY_AUTOSTART_PREDICTION_SECONDS",
            _default_autostart_prediction_seconds(network),
        ),
        # Five minutes between rounds. The next pool used to open the same
        # second the buying window ended, and the "done" page flashed by in two
        # seconds: there was nowhere to look at the result.
        lottery_autostart_gap_seconds=_env_int_non_negative("LOTTERY_AUTOSTART_GAP_SECONDS", 5 * 60),
        lottery_hype_countdown_seconds=_env_int_non_negative("LOTTERY_HYPE_COUNTDOWN_SECONDS", 0),
        lottery_autostart_fee_bps=_env_int_non_negative("LOTTERY_AUTOSTART_FEE_BPS", 300),
        lottery_autostart_vrf_algorithm_hash=_env_str(
            "LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH",
            "0x00a9da1268f2d909dbf6700a15ec3f902630c5194306bfffcf713150279d831b",
        ),
        rpc_proxy_rate_limit_per_minute=_env_int_non_negative("RPC_PROXY_RATE_LIMIT_PER_MINUTE", 240),
        rpc_proxy_max_batch_size=_env_int_non_negative("RPC_PROXY_MAX_BATCH_SIZE", 10),
        rpc_proxy_timeout_seconds=_env_float("RPC_PROXY_TIMEOUT_SECONDS", 15.0),
        external_lookup_timeout_seconds=_env_float("EXTERNAL_LOOKUP_TIMEOUT_SECONDS", 6.0),
    )
