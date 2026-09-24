import asyncio
import hashlib
import json
import logging
import os
import signal
import sys
import time
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_BACKEND_DIR = _PROJECT_ROOT / "webapp" / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from anchorpy import Context, Idl, Program, Provider, Wallet
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from sqlalchemy import and_, func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from telegram_error_handler import TelegramLogHandler

# Used to recognise a transport failure by type. Both come with solana-py; if a
# future install drops them, the message markers below still apply.
try:  # pragma: no cover - import guard
    import httpx as _httpx
except ImportError:  # pragma: no cover
    _httpx = None
try:  # pragma: no cover - import guard
    from solana.exceptions import SolanaRpcException as _SolanaRpcException
except ImportError:  # pragma: no cover
    _SolanaRpcException = None

import events_worker
from shared import orao_vrf
from domain.lottery.entities.lottery import LotteryStatus
from infrastructure.database.database import SessionLocal
from infrastructure.database.models.bet_participation_model import BetParticipationModel
from infrastructure.database.models.lottery_model import LotteryModel
from infrastructure.database.models.smart_contract_event_model import SmartContractEventModel
from infrastructure.database.models.user_model import UserModel
from infrastructure.lottery.offchain_api_client import build_offchain_api_client
from domain.auth.entities.user import UserRole
from shared.admin_wallets import configured_admin_pubkeys
from shared.bet_confirmation import active_bet_condition
from shared.lottery_cycle_control import SUPPORTED_LOTTERY_TYPES, is_cycle_enabled, reconcile_hype_countdown
from shared.weights_commitment import build_number_string, build_weights_payload
from shared.purchases_payload import build_run_purchases_payload
from shared.settings import AppSettings, get_settings


# Mirrors EMERGENCY_FULFILL_DELAY_SECONDS in the program. The worker will not
# reach for the emergency path before the program would accept it anyway;
# keeping the two in step just avoids a pointless failing transaction.
EMERGENCY_FULFILL_DELAY_SECONDS = 120

# `Lottery::SPACE` in the program: the Anchor discriminator plus the struct.
# The parser below reads the account by hand, so this is the only thing that
# notices when the struct moves.
LOTTERY_ACCOUNT_SIZE = 349

# How often a round that is already buying is looked at. The draw is polled on
# the loop's own interval; this one is separate because the two are waiting for
# very different things.
def _env_seconds(name: str, default: float) -> float:
    """A positive number of seconds from the environment, or the default."""
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logging.warning("%s is not a number (%r); using %.1fs", name, raw, default)
        return default
    return value if value > 0 else default


POST_VRF_POLL_INTERVAL_SECONDS = _env_seconds("POST_VRF_POLL_INTERVAL_SECONDS", 15.0)

_ROUND_8 = Decimal("0.00000001")
_ZERO = Decimal("0")
_LAMPORTS_PER_SOL = Decimal("1000000000")
_TERMINAL_STATUSES = {
    LotteryStatus.INITIALIZE_ABANDONED,
    LotteryStatus.CLOSED,
    LotteryStatus.COMPLETED,
}
_ABANDONED_INIT_CLEANUP_DELAY_SECONDS = int(
    os.getenv("LOTTERY_ABANDONED_INIT_CLEANUP_DELAY_SECONDS", "300")
)
#: How long a draft may sit unfinished before the cycle gives up on it.
#:
#: A draft is a row with an id and nothing on chain yet. Any status but the
#: terminal ones blocks the next round, so a draft nobody finishes stops the
#: product: no new pools, no explanation on the site, and the only symptom is
#: that nothing happens. Three minutes is far longer than an initialize takes
#: and far shorter than a person noticing.
_STUCK_DRAFT_GRACE_SECONDS = int(os.getenv("LOTTERY_STUCK_DRAFT_GRACE_SECONDS", "180"))
#: A draft whose transaction never landed is not worth re-reading forever. The
#: blockhash it was signed with dies in about a minute, so after this long there
#: is nothing left to wait for and the row can be closed.
_ABANDONED_INIT_GIVE_UP_SECONDS = int(
    os.getenv("LOTTERY_ABANDONED_INIT_GIVE_UP_SECONDS", "900")
)
_AUTOMATION_USER_EMAIL = "automation@qres.local"
_SKIP_LOG_TIMESTAMPS: dict[str, datetime] = {}
_BUYER_START_STATE: dict[int, tuple[int, datetime]] = {}
#: When the buyer stopped answering about a round, and when we last complained out loud.
_BUYER_START_FIRST_FAIL_AT: dict[int, datetime] = {}
_BUYER_START_LAST_LOUD_AT: dict[int, datetime] = {}
#: How many of the first failures are reported at full volume.
_BUYER_START_LOUD_ATTEMPTS = 2
#: How often to remind that the buyer is still down.
_BUYER_START_REMIND_SECONDS = 60 * 60
_BUYER_STARTED_LOTTERY_IDS: set[int] = set()
_VRF_FULFILLED_AT: dict[int, datetime] = {}


@dataclass(frozen=True)
class Phase2Candidate:
    lottery_id: int
    status: LotteryStatus | str
    second_phase_started_at: Optional[datetime]
    randomness_account: Optional[str]


@dataclass(frozen=True)
class PostVrfCandidate:
    lottery_id: int
    status: LotteryStatus | str
    proceeding_purchases_started_at: Optional[datetime]


@dataclass(frozen=True)
class Phase1Candidate:
    lottery_id: int
    status: LotteryStatus | str
    end_date: Optional[datetime]
    max_total: Optional[Decimal]
    total_pool_sol: Decimal
    randomness_account: Optional[str]


@dataclass(frozen=True)
class AbandonedInitializeCandidate:
    lottery_id: int
    created_at: Optional[datetime]


@dataclass(frozen=True)
class OnchainLotteryState:
    status_raw: int
    status: str
    fee_bps: int
    deposits_count: int
    total_deposited_lamports: int
    vrf_requested_ts: int
    vrf_seed_hex: Optional[str]
    vrf_called: bool
    randomness_account: str
    vrf_force: bytes
    vrf_seed_slot: int
    wallet_fee: str
    wallet_keeper: str


@dataclass(frozen=True)
class AdminRuntime:
    signer_pubkey: Pubkey
    program: Program


def _settings() -> AppSettings:
    return get_settings()


def setup_logging(settings: Optional[AppSettings] = None) -> None:
    settings = settings or _settings()
    root_logger = logging.getLogger()
    worker_log_level = getattr(logging, settings.phase2_worker_log_level, logging.INFO)
    root_logger.setLevel(worker_log_level)

    if not any(getattr(handler, "_lottery_phase_console", False) for handler in root_logger.handlers):
        console_handler = logging.StreamHandler()
        console_handler._lottery_phase_console = True
        console_handler.setLevel(worker_log_level)
        console_handler.setFormatter(
            logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")
        )
        root_logger.addHandler(console_handler)

    # Error alerts: the only channel that tells us something broke in the
    # night. With no token and chat the worker just logs it and carries on.
    if settings.telegram_error_bot_token and settings.telegram_error_chat_id:
        if not any(isinstance(handler, TelegramLogHandler) for handler in root_logger.handlers):
            telegram_level = getattr(
                logging,
                settings.telegram_notification_log_level,
                logging.INFO,
            )
            telegram_handler = TelegramLogHandler(
                settings.telegram_error_bot_token,
                settings.telegram_error_chat_id,
                application="lottery-phase-worker",
                level=telegram_level,
                api_base_url=settings.telegram_api_base_url,
            )
            telegram_handler.setFormatter(
                logging.Formatter("%(message)s")
            )
            root_logger.addHandler(telegram_handler)
            logging.info(
                "Telegram worker notifications enabled (level=%s)",
                logging.getLevelName(telegram_level),
            )
    else:
        logging.warning(
            "Telegram worker notifications are disabled. "
            "Set TELEGRAM_ERROR_BOT_TOKEN and TELEGRAM_ERROR_CHAT_ID."
        )


def _install_signal_handlers(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)


def _resolve_idl_path() -> Path:
    program_idl_path = _settings().program_idl_path
    if program_idl_path:
        configured_path = Path(program_idl_path).expanduser()
        if configured_path.is_file():
            return configured_path.resolve()

        local_path = Path(__file__).resolve().parent / "idl" / "lottery.json"
        if local_path.is_file():
            logging.warning(
                "Configured PROGRAM_IDL_PATH does not exist locally (%s); using %s",
                configured_path,
                local_path,
            )
            return local_path

        raise FileNotFoundError(
            f"PROGRAM_IDL_PATH does not exist: {configured_path}; "
            f"local fallback does not exist: {local_path}"
        )
    return events_worker._resolve_idl_path()


def _parse_keypair_payload(raw: str) -> Keypair:
    raw = raw.strip()
    if not raw:
        raise ValueError("empty signer payload")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, str):
        return Keypair.from_base58_string(parsed)

    if isinstance(parsed, dict):
        if isinstance(parsed.get("secretKey"), list):
            return Keypair.from_bytes(bytes(parsed["secretKey"]))
        if isinstance(parsed.get("keypair"), list):
            return Keypair.from_bytes(bytes(parsed["keypair"]))

    if isinstance(parsed, list):
        return Keypair.from_bytes(bytes(parsed))

    return Keypair.from_base58_string(raw)


def _load_signer_keypair() -> Keypair:
    return _load_signer_keypairs()[0]


def _load_signer_keypairs() -> list[Keypair]:
    settings = _settings()
    candidates: list[Keypair] = []

    if settings.lottery_admin_signer_keypairs_json:
        try:
            parsed = json.loads(settings.lottery_admin_signer_keypairs_json)
        except json.JSONDecodeError as exc:
            raise ValueError("LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON must be valid JSON") from exc
        if not isinstance(parsed, list) or not parsed:
            raise ValueError("LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON must be a non-empty JSON array")
        if all(isinstance(value, int) for value in parsed):
            candidates.append(_parse_keypair_payload(json.dumps(parsed)))
        else:
            for item in parsed:
                candidates.append(
                    _parse_keypair_payload(item if isinstance(item, str) else json.dumps(item))
                )

    paths = [
        value.strip()
        for value in settings.lottery_admin_signer_keypair_paths.split(",")
        if value.strip()
    ]
    if settings.lottery_admin_signer_keypair_path:
        paths.append(settings.lottery_admin_signer_keypair_path)
    for raw_path in paths:
        path = Path(raw_path).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Lottery admin signer keypair path does not exist: {path}")
        candidates.append(_parse_keypair_payload(path.read_text(encoding="utf-8")))

    if settings.lottery_admin_signer_keypair_json:
        candidates.append(_parse_keypair_payload(settings.lottery_admin_signer_keypair_json))

    unique: dict[str, Keypair] = {}
    for signer in candidates:
        unique.setdefault(str(signer.pubkey()), signer)
    if not unique:
        raise RuntimeError(
            "Lottery lifecycle automation is enabled but no signer was configured. "
            "Set LOTTERY_ADMIN_SIGNER_KEYPAIR_JSON/PATH or "
            "LOTTERY_ADMIN_SIGNER_KEYPAIRS_JSON/LOTTERY_ADMIN_SIGNER_KEYPAIR_PATHS."
        )
    return list(unique.values())


def _load_program(client: AsyncClient, signer: Keypair) -> Program:
    settings = _settings()
    idl_path = _resolve_idl_path()
    idl_dict = events_worker._load_idl(idl_path)
    idl_dict = dict(idl_dict)
    idl_dict["address"] = settings.lottery_program_id
    idl_json = events_worker._normalize_idl_for_anchorpy(idl_dict)
    idl = Idl.from_json(idl_json)
    provider = Provider(
        client,
        Wallet(signer),
        TxOpts(
            skip_confirmation=False,
            skip_preflight=False,
            preflight_commitment="confirmed",
        ),
    )
    return Program(idl, Pubkey.from_string(settings.lottery_program_id), provider)


def _lottery_pda_for_signer(lottery_id: int, signer_pubkey: Pubkey) -> Pubkey:
    lottery_id_le_bytes = int(lottery_id).to_bytes(8, byteorder="little", signed=False)
    lottery_pda, _ = Pubkey.find_program_address(
        [b"lottery", bytes(signer_pubkey), lottery_id_le_bytes],
        Pubkey.from_string(_settings().lottery_program_id),
    )
    return lottery_pda


def _resolve_admin_runtime(
    lottery_id: int,
    runtimes: list[AdminRuntime],
) -> Optional[AdminRuntime]:
    target_pubkey = (_settings().lottery_admin_pubkey or "").strip()
    if target_pubkey:
        for runtime in runtimes:
            if str(runtime.signer_pubkey) == target_pubkey:
                return runtime
        _throttled_log(
            logging.WARNING,
            f"missing-primary-signer:{target_pubkey}",
            "Lottery lifecycle automation skipped: LOTTERY_ADMIN_PUBKEY signer is not loaded "
            "(lottery_id=%s, admin_pubkey=%s, loaded_signers=%s)",
            lottery_id,
            target_pubkey,
            ",".join(str(runtime.signer_pubkey) for runtime in runtimes),
        )
        return None

    if len(runtimes) == 1:
        return runtimes[0]

    _throttled_log(
        logging.WARNING,
        "ambiguous-runtime-without-primary-admin",
        "Lottery lifecycle automation skipped: multiple signers are loaded but LOTTERY_ADMIN_PUBKEY "
        "is not configured (lottery_id=%s, loaded_signers=%s)",
        lottery_id,
        ",".join(str(runtime.signer_pubkey) for runtime in runtimes),
    )
    return None


def _vault_pda_for_lottery(lottery_pda: Pubkey) -> Pubkey:
    vault_pda, _ = Pubkey.find_program_address(
        [b"vault", bytes(lottery_pda)],
        Pubkey.from_string(_settings().lottery_program_id),
    )
    return vault_pda


def _normalize_decimal(value: Any) -> Decimal:
    if value is None:
        return _ZERO
    return Decimal(str(value))


def _to_utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


"""
The minimum commit, below which the program will not accept a deposit.

`MIN_AMOUNT_LAMPORTS_DEFAULT` in the program is 50_000_000 lamports, and no
path that creates a round — neither autostart nor the admin form — passes
min_amount, so that default is what applies. Checked against the chain: 113
rounds on devnet have min_amount of exactly 0.05 (57 older ones have 0.01, but
the current code no longer creates those).

The value lives only on chain, there is no column for it in the rounds table, so
it is a constant here. If min_amount ever becomes configurable it will have to
be read from the round: an error on the HIGH side only slightly understates the
fill limit, while an error on the LOW side brings back the original bug — a
round with a full vault would hang until the end of the window.
"""
_CONTRACT_MIN_BET_SOL = Decimal("0.05")


def _effective_cap_threshold(max_total: Optional[Decimal]) -> Decimal:
    """
    The threshold above which the vault counts as full.

    This is the cap MINUS the minimum commit, not the cap itself. Exactly at the
    threshold a minimum commit still fits, so the round stays open. As soon as
    the pool exceeds the threshold by even a lamport, the free capacity is less
    than a minimum commit: the program would reject both a commit that is too
    small (`amount >= min_amount`) and one that exceeds the cap
    (`new_total <= max_total`). At that point the pool is frozen and there is
    nothing to wait for.

    This used to be `min(cap_threshold, max_total)` with
    PHASE2_CAP_THRESHOLD_SOL = 221.95 and a cap of 222. It worked not by design
    but because 221.95 = 222 - 0.05 happened to match the formula we needed. The
    moment the cap dropped to 111, the threshold became min(221.95, 111) = 111,
    and the pool never rises above the cap — the condition became unreachable
    and a round with a full vault would hang until the end of the window.

    Now the headroom is computed from the cap, so it survives the next change to it.

    The PHASE2_CAP_THRESHOLD_SOL setting takes NO part when a cap is given, only
    as the fallback for rounds with no cap. The previous version,
    `min(setting, cap - 0.05)`, created the opposite trap: a round with a cap
    above the default would close at the default, far earlier than it filled.
    There is no upper limit on max_total in the admin form, so such a round can
    be created.
    """
    if max_total is None or max_total <= _ZERO:
        return _settings().phase2_cap_threshold_sol
    return max_total - _CONTRACT_MIN_BET_SOL


def _should_trigger_phase2(candidate: Phase1Candidate, now_utc: datetime) -> bool:
    """
    Time to close the first phase: the time ran out OR the vault is full.
    """
    end_date_utc = _to_utc(candidate.end_date)
    if end_date_utc and now_utc >= end_date_utc:
        return True

    # Free capacity is below the minimum commit, so no new one can be placed and
    # the pool will not change. The comparison is strict: exactly at the
    # threshold a minimum commit still fits and the round stays open; we close
    # from the first lamport over.
    cap_threshold = _effective_cap_threshold(candidate.max_total)
    return candidate.total_pool_sol > cap_threshold


def _throttled_log(level: int, key: str, message: str, *args: Any) -> None:
    now = datetime.now(timezone.utc)
    last = _SKIP_LOG_TIMESTAMPS.get(key)
    if last and now - last < timedelta(seconds=_settings().phase2_skip_log_cooldown_seconds):
        return
    _SKIP_LOG_TIMESTAMPS[key] = now
    logging.log(level, message, *args)


def _advisory_lock_key(lottery_id: int) -> int:
    digest = hashlib.sha256(f"phase2-transition:{lottery_id}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=False) & 0x7FFF_FFFF_FFFF_FFFF


def _try_advisory_lock(session: Session, lottery_id: int) -> bool:
    lock_key = _advisory_lock_key(lottery_id)
    return bool(session.execute(text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_key}).scalar())


def _release_advisory_lock(session: Session, lottery_id: int) -> None:
    lock_key = _advisory_lock_key(lottery_id)
    session.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": lock_key})


def _list_phase1_candidates(session: Session) -> list[Phase1Candidate]:
    rows = (
        session.query(
            LotteryModel.id,
            LotteryModel.status,
            LotteryModel.end_date,
            LotteryModel.max_total,
            LotteryModel.randomness_account,
            func.coalesce(func.sum(BetParticipationModel.sol_amount), 0.0).label("total_pool_sol"),
        )
        .outerjoin(
            BetParticipationModel,
            and_(
                BetParticipationModel.lottery_id == LotteryModel.id,
                active_bet_condition(BetParticipationModel),
            ),
        )
        .filter(LotteryModel.status.in_([LotteryStatus.ID_GENERATED, LotteryStatus.CREATED]))
        .group_by(
            LotteryModel.id,
            LotteryModel.status,
            LotteryModel.end_date,
            LotteryModel.max_total,
            LotteryModel.randomness_account,
        )
        .order_by(LotteryModel.created_at.asc())
        .all()
    )
    return [
        Phase1Candidate(
            lottery_id=int(row.id),
            status=row.status,
            end_date=row.end_date,
            max_total=_normalize_decimal(row.max_total) if row.max_total is not None else None,
            total_pool_sol=_normalize_decimal(row.total_pool_sol).quantize(_ROUND_8, rounding=ROUND_HALF_UP),
            randomness_account=(row.randomness_account or "").strip() or None,
        )
        for row in rows
    ]


def _ensure_lottery_still_in_phase1(session: Session, lottery_id: int) -> Optional[LotteryModel]:
    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).with_for_update().first()
    if not lottery:
        return None
    status = lottery.status
    if isinstance(status, str):
        status = LotteryStatus(status)
    if status not in {LotteryStatus.ID_GENERATED, LotteryStatus.CREATED}:
        return None
    return lottery


def _ensure_lottery_in_phase2(session: Session, lottery_id: int) -> Optional[LotteryModel]:
    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).with_for_update().first()
    if not lottery:
        return None
    status = lottery.status
    if isinstance(status, str):
        status = LotteryStatus(status)
    if status not in {LotteryStatus.PHASE2STARTED, LotteryStatus.VRF_BINDED}:
        return None
    return lottery


def _ensure_lottery_post_vrf(session: Session, lottery_id: int) -> Optional[LotteryModel]:
    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).with_for_update().first()
    if not lottery:
        return None
    status = lottery.status
    if isinstance(status, str):
        status = LotteryStatus(status)
    if status not in {LotteryStatus.VRF_FULFILLED, LotteryStatus.PROCEEDING_PURCHASES}:
        return None
    return lottery


#: The rule for formatting a number and building the commitment lives in a
#: shared module: the round verification page hands out the preimage by the same
#: rule, so the two cannot drift apart.
_build_js_number_string = build_number_string


def _vrf_engine_sha256() -> Optional[str]:
    """The sha256 of the shares algorithm, if this process can see the file.

    The worker ships without the backend tree, so more often than not it cannot.
    Where a copy does turn up it may be an old one left by a previous build, so
    a disagreement here is worth a complaint and never worth acting on.
    """
    here = Path(__file__).resolve()
    for root in (here.parent, *here.parents):
        engine = root / "webapp" / "backend" / "application" / "lottery" / "vrf_engine.py"
        try:
            if engine.is_file():
                return hashlib.sha256(engine.read_bytes()).hexdigest()
        except OSError:
            continue
    return None


def _parse_vrf_algorithm_hash(raw_hash: str) -> list[int]:
    normalized = (raw_hash or "").strip()
    if normalized.startswith(("0x", "0X")):
        normalized = normalized[2:]
    if len(normalized) != 64:
        raise ValueError("LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH must be a 32-byte hex string")
    try:
        values = [int(normalized[index:index + 2], 16) for index in range(0, 64, 2)]
    except ValueError as exc:
        raise ValueError("LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH must be valid hex") from exc
    if all(value == 0 for value in values):
        raise ValueError("LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH must be non-zero")

    # The value that goes on chain claims to be the hash of the algorithm that
    # computes the round. A test keeps the checked-in default honest, but the
    # default is only a fallback: an .env on the server overrides it, and then a
    # round declares one algorithm and is computed by another. Nobody would
    # notice until somebody checked a round and found the fingerprint did not
    # match.
    #
    # Complain, do not refuse. A round that opens with a questionable
    # fingerprint is worth arguing about; a cycle that stops opening rounds is
    # the site going quiet, which is how this worker lost a day already.
    actual = _vrf_engine_sha256()
    if actual is not None and normalized.lower() != actual:
        _throttled_log(
            logging.ERROR,
            f"vrf-algorithm-hash-mismatch:{normalized.lower()}:{actual}",
            "LOTTERY_AUTOSTART_VRF_ALGORITHM_HASH does not match the vrf_engine.py this "
            "machine has (configured 0x%s, file 0x%s). Rounds opened now will declare the "
            "configured value. Fix with: python3 scripts/vrf_algorithm_hash.py --write",
            normalized.lower(),
            actual,
        )
    return values


def _decimal_sol_to_lamports(value: Decimal) -> int:
    lamports = (value * _LAMPORTS_PER_SOL).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    if lamports <= 0:
        raise ValueError("SOL amount must be positive")
    return int(lamports)


def _generate_lottery_id(session: Session) -> int:
    candidate = int(datetime.now(timezone.utc).timestamp() * 1000)
    while session.query(LotteryModel).filter(LotteryModel.id == candidate).first():
        candidate += 1
    return candidate


def _ensure_automation_user(session: Session) -> int:
    user = session.query(UserModel).filter(UserModel.email == _AUTOMATION_USER_EMAIL).first()
    if user is not None:
        if user.role != UserRole.ADMIN:
            user.role = UserRole.ADMIN
            session.commit()
            session.refresh(user)
        return int(user.id)

    user = UserModel(
        email=_AUTOMATION_USER_EMAIL,
        hashed_password="automation-disabled",
        is_active=True,
        role=UserRole.ADMIN,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return int(user.id)


def _release_stuck_drafts(session: Session, lottery_type: str, now_utc: datetime) -> int:
    """Lets the cycle go on when a draft was left unfinished.

    An autostart that fails before it submits anything leaves the row in
    `id_generated`. That status is not terminal, so the next round never starts.
    Until now the only way out was a person noticing and editing the database.

    The row moves to `initialize_abandoned`, which is terminal and is also the
    status the cleanup pass already knows how to reconcile: if the transaction
    did land after all, that pass finds the account on chain and closes it
    properly. Logged at error level so it reaches the alert channel: a stuck
    draft is a symptom, not a routine.
    """
    cutoff = now_utc - timedelta(seconds=max(0, _STUCK_DRAFT_GRACE_SECONDS))
    stuck = (
        session.query(LotteryModel)
        .filter(
            LotteryModel.lottery_type == lottery_type,
            LotteryModel.status == LotteryStatus.ID_GENERATED,
            LotteryModel.created_at < cutoff,
        )
        .all()
    )
    if not stuck:
        return 0
    for draft in stuck:
        draft.status = LotteryStatus.INITIALIZE_ABANDONED
        draft.close_reason = "initialize_stuck"
        if getattr(draft, "initialize_abandoned_at", None) is None:
            draft.initialize_abandoned_at = now_utc
        if not getattr(draft, "initialize_abandoned_error", None):
            draft.initialize_abandoned_error = (
                "draft never reached the chain and blocked the cycle"
            )
    session.commit()
    logging.error(
        "Released %s stuck draft(s) so the cycle can start again "
        "(lottery_type=%s, lottery_ids=%s)",
        len(stuck),
        lottery_type,
        ", ".join(str(draft.id) for draft in stuck),
    )
    return len(stuck)


def _has_non_terminal_lottery(session: Session, lottery_type: str) -> bool:
    terminal_values = [status.value for status in _TERMINAL_STATUSES]
    return session.query(LotteryModel.id).filter(
        LotteryModel.lottery_type == lottery_type,
        LotteryModel.status.notin_(terminal_values),
    ).first() is not None


def _has_active_execution_window(session: Session, lottery_type: str, now_utc: datetime) -> bool:
    settings = _settings()
    # The buying window plus the "done" pause: the next pool does not open
    # until people have had time to see how the last one ended.
    execution_seconds = max(0, settings.execution_countdown_seconds) + max(
        0, settings.lottery_autostart_gap_seconds
    )
    if execution_seconds <= 0:
        return False

    terminal_values = [status.value for status in _TERMINAL_STATUSES]
    latest_execution_lottery = (
        session.query(LotteryModel.id, LotteryModel.proceeding_purchases_started_at)
        .filter(
            LotteryModel.lottery_type == lottery_type,
            LotteryModel.status.in_(terminal_values),
            LotteryModel.proceeding_purchases_started_at.isnot(None),
        )
        .order_by(LotteryModel.proceeding_purchases_started_at.desc())
        .first()
    )
    if latest_execution_lottery is None:
        return False

    proceeding_started_at = _to_utc(latest_execution_lottery.proceeding_purchases_started_at)
    if proceeding_started_at is None:
        return False

    execution_ends_at = proceeding_started_at + timedelta(seconds=execution_seconds)
    if now_utc >= execution_ends_at:
        return False

    _throttled_log(
        logging.INFO,
        f"autostart-execution-window:{lottery_type}:{latest_execution_lottery.id}",
        "Lottery autostart delayed until execution window ends "
        "(lottery_id=%s, lottery_type=%s, execution_ends_at=%s)",
        latest_execution_lottery.id,
        lottery_type,
        execution_ends_at.isoformat(),
    )
    return True


def _select_autostart_runtime(runtimes: list[AdminRuntime], settings: AppSettings) -> Optional[AdminRuntime]:
    target_pubkey = (settings.lottery_admin_pubkey or "").strip()
    if not target_pubkey:
        return None
    for runtime in runtimes:
        if str(runtime.signer_pubkey) == target_pubkey:
            return runtime
    return None


def _build_weights_hash(session: Session, lottery_id: int) -> Optional[bytes]:
    rows = (
        session.query(
            BetParticipationModel.meme_coin_address,
            func.sum(BetParticipationModel.sol_amount).label("total_sol"),
        )
        .filter(BetParticipationModel.lottery_id == lottery_id)
        .filter(active_bet_condition(BetParticipationModel))
        .group_by(BetParticipationModel.meme_coin_address)
        .all()
    )
    if not rows:
        return None

    pairs: list[tuple[str, Decimal]] = []
    for mint, total_sol in rows:
        amount = _normalize_decimal(total_sol).quantize(_ROUND_8, rounding=ROUND_HALF_UP)
        if amount <= _ZERO:
            continue
        pairs.append((str(mint), amount))

    if not pairs:
        return None

    payload = build_weights_payload(pairs)
    if payload is None:
        return None
    return hashlib.sha256(payload.encode("utf-8")).digest()


def _active_deposits_match_onchain(
    session: Session,
    lottery_id: int,
    onchain: OnchainLotteryState,
    *,
    log_key_prefix: str,
) -> bool:
    db_deposits_count = int(
        session.query(func.count(BetParticipationModel.id))
        .filter(
            BetParticipationModel.lottery_id == lottery_id,
            active_bet_condition(BetParticipationModel),
        )
        .scalar()
        or 0
    )
    db_total_sol = _normalize_decimal(
        session.query(func.coalesce(func.sum(BetParticipationModel.sol_amount), 0.0))
        .filter(
            BetParticipationModel.lottery_id == lottery_id,
            active_bet_condition(BetParticipationModel),
        )
        .scalar()
    ).quantize(_ROUND_8, rounding=ROUND_HALF_UP)
    db_total_lamports = int(db_total_sol * Decimal("1000000000"))
    rounding_tolerance_lamports = db_deposits_count * 10
    total_difference_lamports = abs(db_total_lamports - onchain.total_deposited_lamports)
    if db_deposits_count == onchain.deposits_count and total_difference_lamports <= rounding_tolerance_lamports:
        return True

    _throttled_log(
        logging.ERROR,
        f"{log_key_prefix}:{lottery_id}:{db_deposits_count}:{onchain.deposits_count}:"
        f"{db_total_lamports}:{onchain.total_deposited_lamports}",
        "Lottery automation blocked: DB/on-chain active deposit mismatch "
        "(lottery_id=%s, db_deposits_count=%s, onchain_deposits_count=%s, "
        "db_total_lamports=%s, onchain_total_lamports=%s, difference_lamports=%s, "
        "rounding_tolerance_lamports=%s). Waiting for event/finalizer reconciliation.",
        lottery_id,
        db_deposits_count,
        onchain.deposits_count,
        db_total_lamports,
        onchain.total_deposited_lamports,
        total_difference_lamports,
        rounding_tolerance_lamports,
    )
    return False


def _mark_phase2_started(session: Session, lottery: LotteryModel) -> None:
    lottery.status = LotteryStatus.PHASE2STARTED
    lottery.second_phase_started_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(lottery)


def _mark_vrf_fulfilled(
    session: Session,
    lottery: LotteryModel,
    seed_hex: Optional[str] = None,
    *,
    offchain: bool = False,
) -> None:
    changed = False
    if lottery.status != LotteryStatus.VRF_FULFILLED:
        lottery.status = LotteryStatus.VRF_FULFILLED
        changed = True
    if seed_hex and lottery.vrf_seed != seed_hex:
        lottery.vrf_seed = seed_hex
        changed = True
    if offchain and not bool(getattr(lottery, "is_offchain_vrf", False)):
        lottery.is_offchain_vrf = True
        changed = True
    if changed:
        session.commit()
        session.refresh(lottery)
    _VRF_FULFILLED_AT[lottery.id] = datetime.now(timezone.utc)


def _mark_proceeding_purchases(session: Session, lottery: LotteryModel) -> None:
    changed = False
    if lottery.status != LotteryStatus.PROCEEDING_PURCHASES:
        lottery.status = LotteryStatus.PROCEEDING_PURCHASES
        changed = True
    if lottery.proceeding_purchases_started_at is None:
        lottery.proceeding_purchases_started_at = datetime.now(timezone.utc)
        changed = True
    if changed:
        session.commit()
        session.refresh(lottery)


def _mark_closed(
    session: Session,
    lottery: LotteryModel,
    *,
    close_reason: Optional[str] = None,
) -> None:
    changed = False
    if close_reason and getattr(lottery, "close_reason", None) != close_reason:
        lottery.close_reason = close_reason
        changed = True
    if lottery.status == LotteryStatus.CLOSED:
        if changed:
            session.commit()
            session.refresh(lottery)
        return
    lottery.status = LotteryStatus.CLOSED
    changed = True
    session.commit()
    session.refresh(lottery)


async def _close_empty_lottery(
    session: Session,
    lottery: LotteryModel,
    program: Program,
    lottery_pda: Pubkey,
    signer_pubkey: Pubkey,
) -> None:
    signature = await _close_lottery_onchain(
        program=program,
        lottery_pda=lottery_pda,
        vault_pda=_vault_pda_for_lottery(lottery_pda),
        signer_pubkey=signer_pubkey,
    )

    # Nothing to close on the ORAO side: a request account is theirs, it is not
    # closable, and the rent above the fulfilled size comes back by itself.
    randomness_account = (lottery.randomness_account or "").strip()
    if randomness_account:
        try:
            lottery.randomness_account = None
            lottery.vrf_seed = None
        except Exception:
            logging.exception(
                "Randomness account cleanup failed after empty lottery close "
                "(lottery_id=%s, randomness_account=%s)",
                lottery.id,
                randomness_account,
            )

    lottery.status = LotteryStatus.CLOSED
    session.commit()
    session.refresh(lottery)
    logging.info("Empty lottery on-chain close succeeded (lottery_id=%s, tx=%s)", lottery.id, signature)


async def _lottery_account_exists(client: AsyncClient, lottery_pda: Pubkey) -> bool:
    response = await client.get_account_info(lottery_pda, commitment="confirmed")
    return response.value is not None


async def _initialize_lottery_onchain(
    program: Program,
    lottery_pda: Pubkey,
    vault_pda: Pubkey,
    signer_pubkey: Pubkey,
    lottery_id: int,
    start_ts: int,
    end_ts: int,
    fee_bps: int,
    max_total_lamports: int,
    vrf_algorithm_hash: list[int],
    wallet_fee: str,
    wallet_keeper: str,
) -> str:
    signature = await program.rpc["initialize"](
        int(lottery_id),
        int(start_ts),
        int(end_ts),
        int(fee_bps),
        None,
        None,
        int(max_total_lamports),
        vrf_algorithm_hash,
        ctx=Context(
            accounts={
                "lottery": lottery_pda,
                "vault": vault_pda,
                "wallet_fee": Pubkey.from_string(wallet_fee),
                "wallet_keeper": Pubkey.from_string(wallet_keeper),
                "admin": signer_pubkey,
                "system_program": Pubkey.from_string("11111111111111111111111111111111"),
            }
        ),
    )
    return str(signature)


def _generate_emergency_seed() -> tuple[list[int], str]:
    seed = bytearray(os.urandom(32))
    seed[0] |= 0xF0
    seed_hex = bytes(seed).hex()
    return list(seed), seed_hex


async def _wait_for_lottery_account(
    client: AsyncClient,
    lottery_pda: Pubkey,
    timeout_seconds: float = 20.0,
    poll_seconds: float = 0.5,
) -> None:
    """Waits until the round account is readable after initialize.

    The transaction is confirmed by then, but a read against another node can
    still miss it, and the caller goes straight on to write the round into the
    database as if it were there.
    """
    deadline = time.monotonic() + timeout_seconds
    while True:
        response = await client.get_account_info(lottery_pda, commitment="confirmed")
        if response.value is not None:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Lottery PDA {lottery_pda} did not appear within {timeout_seconds}s")
        await asyncio.sleep(poll_seconds)


async def _orao_treasury(client: AsyncClient) -> Pubkey:
    """Where ORAO wants its fee paid.

    Read from their network configuration each time rather than pinned here:
    ORAO can move the treasury with `update_network`, and a stale constant would
    fail every request from the moment they did.
    """
    response = await client.get_account_info(orao_vrf.network_state_address(), commitment="confirmed")
    if response.value is None or response.value.data is None:
        raise RuntimeError("ORAO network state account is missing; is the cluster right?")
    return orao_vrf.parse_treasury(bytes(response.value.data))


async def _recent_slot_entry(client: AsyncClient, back: int = 2) -> orao_vrf.SlotHashEntry:
    """A slot and its hash, read from the same sysvar the program reads."""
    response = await client.get_account_info(orao_vrf.SLOT_HASHES_SYSVAR, commitment="confirmed")
    if response.value is None or response.value.data is None:
        raise RuntimeError("SlotHashes sysvar is unreadable")
    return orao_vrf.parse_slot_hashes(bytes(response.value.data), back=back)


async def _read_orao_request(client: AsyncClient, request: Pubkey) -> Optional[orao_vrf.RequestState]:
    """The state of a randomness request, or None while the account is absent."""
    response = await client.get_account_info(request, commitment="confirmed")
    if response.value is None or response.value.data is None:
        return None
    return orao_vrf.parse_request(bytes(response.value.data))


async def _start_second_phase(
    program: Program,
    client: AsyncClient,
    lottery_pda: Pubkey,
    signer_pubkey: Pubkey,
    weights_hash: bytes,
) -> tuple[str, Pubkey, int]:
    """Closes deposits and files the randomness request, in one transaction.

    The seed is derived here only so the request account can be named in the
    transaction. The program derives it again from the same three values and
    refuses anything else, so a disagreement fails the round rather than
    quietly using ours.
    """
    entry = await _recent_slot_entry(client)
    force = orao_vrf.derive_force(lottery_pda, weights_hash, entry.hash)
    request = orao_vrf.request_address(force)
    treasury = await _orao_treasury(client)

    signature = await program.rpc["start_second_phase"](
        list(weights_hash),
        entry.slot,
        ctx=Context(
            accounts={
                "lottery": lottery_pda,
                "admin": signer_pubkey,
                "vrf_request": request,
                "vrf_network_state": orao_vrf.network_state_address(),
                "vrf_treasury": treasury,
                "vrf_program": orao_vrf.ORAO_PROGRAM_ID,
                "recent_slothashes": orao_vrf.SLOT_HASHES_SYSVAR,
                "system_program": SYSTEM_PROGRAM_ID,
            }
        ),
    )
    return str(signature), request, entry.slot


async def _fulfill_randomness(
    program: Program,
    lottery_pda: Pubkey,
    vrf_request: Pubkey,
) -> str:
    """Takes the randomness into the round. Needs no admin signature."""
    signature = await program.rpc["fulfill_randomness"](
        ctx=Context(
            accounts={
                "lottery": lottery_pda,
                "vrf_request": vrf_request,
            }
        ),
    )
    return str(signature)


async def _emergency_fulfill_randomness(
    program: Program,
    lottery_pda: Pubkey,
    signer_pubkey: Pubkey,
    vrf_request: Pubkey,
) -> tuple[str, str]:
    """The way out when ORAO has stopped answering.

    The request account goes in because the program reads it and refuses the
    moment randomness is there. So this cannot turn into a second draw even if
    the worker asked for one by mistake.
    """
    seed_bytes, seed_hex = _generate_emergency_seed()
    signature = await program.rpc["emergency_fulfill_randomness"](
        seed_bytes,
        ctx=Context(
            accounts={
                "lottery": lottery_pda,
                "admin": signer_pubkey,
                "vrf_request": vrf_request,
            }
        ),
    )
    return str(signature), seed_hex


async def _start_purchases_phase(
    program: Program,
    lottery_pda: Pubkey,
    vault_pda: Pubkey,
    signer_pubkey: Pubkey,
    wallet_fee: str,
    wallet_keeper: str,
) -> str:
    signature = await program.rpc["start_purchases_phase"](
        ctx=Context(
            accounts={
                "lottery": lottery_pda,
                "vault": vault_pda,
                "wallet_fee": Pubkey.from_string(wallet_fee),
                "wallet_keeper": Pubkey.from_string(wallet_keeper),
                "admin": signer_pubkey,
                "system_program": Pubkey.from_string("11111111111111111111111111111111"),
            }
        ),
    )
    return str(signature)


async def _close_lottery_onchain(
    program: Program,
    lottery_pda: Pubkey,
    vault_pda: Pubkey,
    signer_pubkey: Pubkey,
) -> str:
    signature = await program.rpc["close_lottery"](
        ctx=Context(
            accounts={
                "lottery": lottery_pda,
                "vault": vault_pda,
                "admin": signer_pubkey,
                "system_program": Pubkey.from_string("11111111111111111111111111111111"),
            }
        ),
    )
    return str(signature)


_POST_VRF_LAST_POLL: dict[int, float] = {}


def _post_vrf_poll_due(lottery_id: int, now: float | None = None) -> bool:
    """Whether a round in the buying phase is due another look.

    Keyed per round rather than globally: two rounds run side by side and one
    of them arriving must not push the other's turn away.
    """
    moment = time.monotonic() if now is None else now
    previous = _POST_VRF_LAST_POLL.get(lottery_id)
    if previous is not None and moment - previous < POST_VRF_POLL_INTERVAL_SECONDS:
        return False
    _POST_VRF_LAST_POLL[lottery_id] = moment
    return True


def _parse_onchain_lottery_account(raw_data: bytes) -> OnchainLotteryState:
    # Exactly the size, not at least it. The pre-ORAO account was nine bytes
    # longer and differed from `vrf_force` onwards, so it reads cleanly under
    # these offsets and hands back a request seed the round never asked for.
    # Both layouts carry the same Anchor discriminator, since that is a hash of
    # the type name, so the length is the only thing that separates them.
    if len(raw_data) != LOTTERY_ACCOUNT_SIZE:
        raise RuntimeError(
            f"Lottery account is {len(raw_data)} bytes, expected {LOTTERY_ACCOUNT_SIZE}. "
            "Either the program was redeployed with a different layout or this is an "
            "account from before the ORAO migration."
        )

    status_map = {
        0: "Open",
        1: "PendingVrf",
        2: "ReadyToDraw",
        3: "ProceedingPurchases",
        4: "Closed",
    }

    offset = 8

    def take(size: int) -> bytes:
        nonlocal offset
        chunk = raw_data[offset:offset + size]
        if len(chunk) != size:
            raise RuntimeError(f"Lottery account data ended unexpectedly at offset={offset} size={size}")
        offset += size
        return chunk

    take(32)  # admin
    take(8)   # start_ts
    take(8)   # end_ts
    fee_bps = int.from_bytes(take(2), byteorder="little", signed=False)
    wallet_fee = str(Pubkey.from_bytes(take(32)))
    wallet_keeper = str(Pubkey.from_bytes(take(32)))
    take(8)   # min_amount
    take(8)   # max_amount
    take(8)   # max_total
    status_raw = int.from_bytes(take(1), byteorder="little", signed=False)
    take(1)   # paused
    deposits_count = int.from_bytes(take(8), byteorder="little", signed=False)
    total_deposited_lamports = int.from_bytes(take(16), byteorder="little", signed=False)
    take(32)  # weights_hash
    vrf_requested_ts = int.from_bytes(take(8), byteorder="little", signed=True)
    vrf_seed = take(32)
    vrf_seed_hex = vrf_seed.hex() if vrf_seed != bytes(32) else None
    vrf_called = bool(int.from_bytes(take(1), byteorder="little", signed=False))
    randomness_account = str(Pubkey.from_bytes(take(32)))
    vrf_force = take(32)
    vrf_seed_slot = int.from_bytes(take(8), byteorder="little", signed=False)
    take(32)  # vrf_algorithm_hash

    return OnchainLotteryState(
        status_raw=status_raw,
        status=status_map.get(status_raw, f"Unknown({status_raw})"),
        fee_bps=fee_bps,
        deposits_count=deposits_count,
        total_deposited_lamports=total_deposited_lamports,
        vrf_requested_ts=vrf_requested_ts,
        vrf_seed_hex=vrf_seed_hex,
        vrf_called=vrf_called,
        randomness_account=randomness_account,
        vrf_force=vrf_force,
        vrf_seed_slot=vrf_seed_slot,
        wallet_fee=wallet_fee,
        wallet_keeper=wallet_keeper,
    )


async def _fetch_onchain_lottery_state(client: AsyncClient, lottery_pda: Pubkey) -> OnchainLotteryState:
    response = await client.get_account_info(lottery_pda, commitment="confirmed")
    if response.value is None or response.value.data is None:
        raise RuntimeError(f"Lottery PDA {lottery_pda} is missing on chain")
    raw_data = bytes(response.value.data)
    return _parse_onchain_lottery_account(raw_data)


def _exception_chain(exc: BaseException) -> list[BaseException]:
    """The exception and everything it was raised from.

    solana-py wraps the real failure and its own `str()` is empty, so looking at
    the outermost message alone tells you nothing. The cause carries the HTTP
    status.
    """
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: Optional[BaseException] = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _is_transport_exception(exc: BaseException) -> bool:
    """A failure of the connection rather than of the round, by type.

    A 429 from the RPC provider arrives as an empty SolanaRpcException wrapping
    an httpx error. A classifier reading the message saw an empty string, called
    it unknown, and the draft was left blocked for a human — which on the devnet
    stand meant no new rounds at all until somebody noticed hours later.
    """
    if _httpx is not None and isinstance(exc, _httpx.TransportError):
        return True
    if _SolanaRpcException is not None and isinstance(exc, _SolanaRpcException):
        return True
    return isinstance(exc, (asyncio.TimeoutError, ConnectionError, OSError))


def _phase2_error_kind(exc: Exception) -> str:
    chain = _exception_chain(exc)
    # When the provider answered at all, its status decides: 429 and the 5xx
    # family are the connection, everything else is us or the program and
    # deserves to be read rather than retried blindly.
    statuses = [
        item.response.status_code
        for item in chain
        if _httpx is not None and isinstance(item, _httpx.HTTPStatusError)
    ]
    if statuses:
        if any(status == 429 or status >= 500 for status in statuses):
            return "transport"
    elif any(_is_transport_exception(item) for item in chain):
        return "transport"
    message = " ".join(str(item) for item in chain).lower()

    transport_markers = (
        "timeout",
        "timed out",
        "temporarily unavailable",
        "connection reset",
        "connection aborted",
        "connection refused",
        "server disconnected",
        "429",
        "502",
        "503",
        "504",
        "gateway",
        "rpc",
        "network",
        "urlopen error",
        "failed to fetch",
    )
    if any(marker in message for marker in transport_markers):
        return "transport"

    if any(marker in message for marker in _STATE_MARKERS):
        return "state"

    return "unknown"


# Every error the program can return about the draw, as the error name appears
# in the message with the case taken out. They all mean "this round is not in
# the state you thought", which is worth reading rather than retrying blindly.
#
# Kept in step with `LotteryError` in the program, and checked against the IDL
# by `tests/test_phase_error_kinds.py`: after the ORAO migration this list still
# held six Switchboard names that no longer exist, and missed the renamed
# `RandomnessAlreadyResolved` entirely.
_STATE_MARKERS = (
    "wrongphase",
    "vrfnotready",
    "vrfalreadycalled",
    "randomnessnotresolved",
    "randomnessalreadyresolved",
    "randomnessaccountmismatch",
    "randomnessrequestmismatch",
    "invalidrandomnessaccountowner",
    "invalidrandomnessaccountdata",
    "invalidslothashessysvar",
    "seedslotnotfound",
    "seedslottooold",
    "weightshashalreadyset",
    "invalidweightshash",
    "invalidvrfseed",
)


def _attempt_slot_open(
    *,
    window_start: datetime,
    now_utc: datetime,
    spacing_seconds: int,
    max_attempts: int,
) -> bool:
    if now_utc < window_start:
        return False
    elapsed_seconds = int((now_utc - window_start).total_seconds())
    if elapsed_seconds < 0:
        return False
    if elapsed_seconds >= spacing_seconds * max_attempts:
        return False
    return elapsed_seconds % spacing_seconds == 0


def _buyer_start_due(lottery_id: int, now_utc: datetime) -> bool:
    if lottery_id in _BUYER_STARTED_LOTTERY_IDS:
        return False
    state = _BUYER_START_STATE.get(lottery_id)
    if not state:
        return True

    attempt_count, last_attempt = state
    backoff_seconds = min(60, 5 * (2 ** max(0, attempt_count - 1)))
    return (now_utc - last_attempt).total_seconds() >= backoff_seconds


def _record_buyer_start_failure(lottery_id: int, now_utc: datetime) -> None:
    previous_count = _BUYER_START_STATE.get(lottery_id, (0, now_utc))[0]
    _BUYER_START_STATE[lottery_id] = (previous_count + 1, now_utc)
    _BUYER_START_FIRST_FAIL_AT.setdefault(lottery_id, now_utc)


def _log_buyer_start_failure(lottery_id: int, now_utc: datetime, message: str) -> None:
    """Complains about an unreachable buyer without turning the alert channel into a feed.

    Retries back off to a minute, so without this caveat a night would send
    several hundred identical messages to the chat and a real incident would
    drown among them. We speak at full volume the first few times and then once
    an hour; the rest goes to the log as a warning.
    """
    attempts = _BUYER_START_STATE.get(lottery_id, (1, now_utc))[0]
    first_at = _BUYER_START_FIRST_FAIL_AT.get(lottery_id, now_utc)
    minutes = int((now_utc - first_at).total_seconds() // 60)
    last_loud = _BUYER_START_LAST_LOUD_AT.get(lottery_id)
    loud = (
        attempts <= _BUYER_START_LOUD_ATTEMPTS
        or last_loud is None
        or (now_utc - last_loud).total_seconds() >= _BUYER_START_REMIND_SECONDS
    )

    if loud:
        _BUYER_START_LAST_LOUD_AT[lottery_id] = now_utc
        logging.error(
            "%s (lottery_id=%s, attempts=%s, minutes=%s)",
            message,
            lottery_id,
            attempts,
            minutes,
            exc_info=True,
        )
    else:
        logging.warning(
            "%s, still retrying (lottery_id=%s, attempts=%s, minutes=%s)",
            message,
            lottery_id,
            attempts,
            minutes,
        )


def _mark_buyer_started(lottery_id: int) -> None:
    _BUYER_STARTED_LOTTERY_IDS.add(lottery_id)
    _BUYER_START_STATE.pop(lottery_id, None)
    _BUYER_START_FIRST_FAIL_AT.pop(lottery_id, None)
    _BUYER_START_LAST_LOUD_AT.pop(lottery_id, None)


def _is_buyer_idempotent_conflict(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "offchain-api http 409" in message
        and (
            "already running" in message
            or "state file already exists" in message
        )
    )


async def _start_buyer_if_due(
    session: Session,
    lottery: LotteryModel,
    now_utc: datetime,
    *,
    fee_bps: int = 300,
) -> None:
    lottery_id = int(lottery.id)
    if not _buyer_start_due(lottery_id, now_utc):
        return

    try:
        payload = build_run_purchases_payload(session, lottery, fee_bps=fee_bps)
    except Exception:
        _record_buyer_start_failure(lottery_id, now_utc)
        _log_buyer_start_failure(lottery_id, now_utc, "Buyer payload build failed")
        return

    token_count = len(payload.get("tokens", []))
    if token_count <= 0:
        _mark_buyer_started(lottery_id)
        logging.warning("Buyer start skipped: no purchase tokens in payload (lottery_id=%s)", lottery_id)
        return

    try:
        response = await asyncio.to_thread(build_offchain_api_client().execute_lottery, payload)
    except RuntimeError as exc:
        if _is_buyer_idempotent_conflict(exc):
            _mark_buyer_started(lottery_id)
            logging.info("Buyer already started or completed (lottery_id=%s)", lottery_id)
            return
        _record_buyer_start_failure(lottery_id, now_utc)
        _log_buyer_start_failure(lottery_id, now_utc, "Buyer start failed")
        return
    except Exception:
        _record_buyer_start_failure(lottery_id, now_utc)
        _log_buyer_start_failure(lottery_id, now_utc, "Buyer start failed unexpectedly")
        return

    _mark_buyer_started(lottery_id)
    logging.info(
        "Buyer start accepted (lottery_id=%s, token_count=%s, response=%s)",
        lottery_id,
        token_count,
        response,
    )


def _latest_event_created_at(
    session: Session,
    event_names: tuple[str, ...],
    lottery_pubkey: str,
) -> Optional[datetime]:
    events = (
        session.query(SmartContractEventModel)
        .filter(SmartContractEventModel.event_name.in_(event_names))
        .order_by(SmartContractEventModel.created_at.desc())
        .limit(64)
        .all()
    )
    for event in events:
        data = event.data
        if not isinstance(data, dict):
            continue
        if str(data.get("lottery") or "").strip() != lottery_pubkey:
            continue
        created_at = event.created_at
        if created_at is None:
            return None
        if created_at.tzinfo is None:
            return created_at.replace(tzinfo=timezone.utc)
        return created_at.astimezone(timezone.utc)
    return None


def _normalize_seed_hex(seed_hex: Optional[str]) -> Optional[str]:
    if not seed_hex:
        return None
    normalized = seed_hex[2:] if seed_hex.startswith("0x") else seed_hex
    normalized = normalized.strip().lower()
    return normalized or None


def _sync_phase2_metadata_from_onchain(
    session: Session,
    lottery: LotteryModel,
    onchain: OnchainLotteryState,
) -> None:
    changed = False
    if onchain.randomness_account and lottery.randomness_account != onchain.randomness_account:
        lottery.randomness_account = onchain.randomness_account
        changed = True
    if onchain.vrf_seed_hex and lottery.vrf_seed != onchain.vrf_seed_hex:
        lottery.vrf_seed = onchain.vrf_seed_hex
        changed = True
    if onchain.status == "ReadyToDraw" and lottery.status != LotteryStatus.VRF_FULFILLED:
        lottery.status = LotteryStatus.VRF_FULFILLED
        changed = True
    if onchain.status == "ProceedingPurchases" and lottery.status != LotteryStatus.PROCEEDING_PURCHASES:
        lottery.status = LotteryStatus.PROCEEDING_PURCHASES
        if lottery.proceeding_purchases_started_at is None:
            lottery.proceeding_purchases_started_at = datetime.now(timezone.utc)
        changed = True
    if changed:
        session.commit()
        session.refresh(lottery)


def _list_phase2_candidates(session: Session) -> list[Phase2Candidate]:
    rows = (
        session.query(
            LotteryModel.id,
            LotteryModel.status,
            LotteryModel.second_phase_started_at,
            LotteryModel.randomness_account,
        )
        .filter(LotteryModel.status.in_([LotteryStatus.PHASE2STARTED, LotteryStatus.VRF_BINDED]))
        .order_by(LotteryModel.created_at.asc())
        .all()
    )
    return [
        Phase2Candidate(
            lottery_id=int(row.id),
            status=row.status,
            second_phase_started_at=row.second_phase_started_at,
            randomness_account=(row.randomness_account or "").strip() or None,
        )
        for row in rows
    ]


def _list_post_vrf_candidates(session: Session) -> list[PostVrfCandidate]:
    rows = (
        session.query(
            LotteryModel.id,
            LotteryModel.status,
            LotteryModel.proceeding_purchases_started_at,
        )
        .filter(LotteryModel.status.in_([LotteryStatus.VRF_FULFILLED, LotteryStatus.PROCEEDING_PURCHASES]))
        .order_by(LotteryModel.created_at.asc())
        .all()
    )
    return [
        PostVrfCandidate(
            lottery_id=int(row.id),
            status=row.status,
            proceeding_purchases_started_at=row.proceeding_purchases_started_at,
        )
        for row in rows
    ]


def _list_abandoned_initialize_candidates(session: Session) -> list[AbandonedInitializeCandidate]:
    cleanup_delay = max(0, _ABANDONED_INIT_CLEANUP_DELAY_SECONDS)
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=cleanup_delay)
    rows = (
        session.query(
            LotteryModel.id,
            LotteryModel.created_at,
        )
        .filter(LotteryModel.status == LotteryStatus.INITIALIZE_ABANDONED)
        .filter(LotteryModel.created_at <= cutoff)
        .order_by(LotteryModel.created_at.asc())
        .all()
    )
    return [
        AbandonedInitializeCandidate(
            lottery_id=int(row.id),
            created_at=row.created_at,
        )
        for row in rows
    ]


async def _execute_emergency_fulfill(
    session: Session,
    lottery: LotteryModel,
    program: Program,
    lottery_pda: Pubkey,
    signer_pubkey: Pubkey,
) -> None:
    signature, seed_hex = await _emergency_fulfill_randomness(program, lottery_pda, signer_pubkey)
    _mark_vrf_fulfilled(session, lottery, seed_hex, offchain=True)
    # Error level rather than warning, and that is not a formality: the coin
    # shares in such a round were set by our seed, not by Switchboard. The team
    # has to hear about a round where we rolled the dice ourselves at once, not
    # from the logs a week later.
    logging.error(
        "Emergency fulfill used (lottery_id=%s, tx=%s, seed_hex=%s)",
        lottery.id,
        signature,
        seed_hex,
    )


async def _process_abandoned_initialize_candidate(
    candidate: AbandonedInitializeCandidate,
    client: AsyncClient,
    program: Program,
    signer_pubkey: Pubkey,
) -> None:
    session = SessionLocal()
    lock_acquired = False
    try:
        lock_acquired = _try_advisory_lock(session, candidate.lottery_id)
        if not lock_acquired:
            return

        lottery = (
            session.query(LotteryModel)
            .filter(LotteryModel.id == candidate.lottery_id)
            .with_for_update()
            .first()
        )
        if not lottery:
            return
        status_value = getattr(lottery.status, "value", lottery.status)
        if status_value != LotteryStatus.INITIALIZE_ABANDONED.value:
            return

        lottery_pda = _lottery_pda_for_signer(candidate.lottery_id, signer_pubkey)
        if not await _lottery_account_exists(client, lottery_pda):
            # After a while there is nothing left to wait for: the blockhash the
            # initialize was signed with is long dead, so the transaction can no
            # longer land. Closing the row stops a read of the chain per row per
            # cycle, forever. A dozen of them on the devnet stand was a steady
            # drip into the rate limit we then ran out of.
            reference = (
                getattr(lottery, "initialize_abandoned_at", None)
                or getattr(lottery, "created_at", None)
            )
            age_seconds = None
            if reference is not None:
                if reference.tzinfo is None:
                    reference = reference.replace(tzinfo=timezone.utc)
                age_seconds = (datetime.now(timezone.utc) - reference).total_seconds()
            if age_seconds is not None and age_seconds > _ABANDONED_INIT_GIVE_UP_SECONDS:
                _mark_closed(session, lottery, close_reason="initialize_never_landed")
                logging.info(
                    "Abandoned initialize cleanup gave up: the transaction never reached the chain "
                    "(lottery_id=%s, pda=%s, age_minutes=%s)",
                    candidate.lottery_id,
                    lottery_pda,
                    int(age_seconds // 60),
                )
                return
            _throttled_log(
                logging.INFO,
                f"abandoned-init-missing-pda:{candidate.lottery_id}",
                "Abandoned initialize cleanup skipped: lottery PDA is not on-chain yet "
                "(lottery_id=%s, signer=%s, pda=%s)",
                candidate.lottery_id,
                signer_pubkey,
                lottery_pda,
            )
            return

        onchain = await _fetch_onchain_lottery_state(client, lottery_pda)
        if onchain.status == "Closed":
            _mark_closed(session, lottery, close_reason="initialize_abandoned")
            logging.info(
                "Abandoned initialize cleanup marked already-closed on-chain lottery as closed "
                "(lottery_id=%s, pda=%s)",
                candidate.lottery_id,
                lottery_pda,
            )
            return

        if onchain.status != "Open":
            _throttled_log(
                logging.WARNING,
                f"abandoned-init-unexpected-status:{candidate.lottery_id}:{onchain.status}",
                "Abandoned initialize cleanup skipped: unexpected on-chain status "
                "(lottery_id=%s, pda=%s, status=%s)",
                candidate.lottery_id,
                lottery_pda,
                onchain.status,
            )
            return

        if onchain.deposits_count != 0 or onchain.total_deposited_lamports != 0:
            _throttled_log(
                logging.ERROR,
                f"abandoned-init-has-deposits:{candidate.lottery_id}:{onchain.deposits_count}:"
                f"{onchain.total_deposited_lamports}",
                "Abandoned initialize cleanup blocked: on-chain lottery has deposits "
                "(lottery_id=%s, pda=%s, deposits_count=%s, total_deposited_lamports=%s)",
                candidate.lottery_id,
                lottery_pda,
                onchain.deposits_count,
                onchain.total_deposited_lamports,
            )
            return

        signature = await _close_lottery_onchain(
            program=program,
            lottery_pda=lottery_pda,
            vault_pda=_vault_pda_for_lottery(lottery_pda),
            signer_pubkey=signer_pubkey,
        )
        _mark_closed(session, lottery, close_reason="initialize_abandoned")
        logging.warning(
            "Abandoned initialize cleanup closed empty on-chain lottery "
            "(lottery_id=%s, pda=%s, tx=%s)",
            candidate.lottery_id,
            lottery_pda,
            signature,
        )
    except Exception:
        session.rollback()
        raise
    finally:
        if lock_acquired:
            try:
                _release_advisory_lock(session, candidate.lottery_id)
                session.commit()
            except Exception:
                session.rollback()
        session.close()


async def _process_phase1_candidate(
    candidate: Phase1Candidate,
    client: AsyncClient,
    program: Program,
    signer_pubkey: Pubkey,
) -> None:
    session = SessionLocal()
    lock_acquired = False
    try:
        lock_acquired = _try_advisory_lock(session, candidate.lottery_id)
        if not lock_acquired:
            return

        lottery = _ensure_lottery_still_in_phase1(session, candidate.lottery_id)
        if not lottery:
            return

        total_pool_sol = _normalize_decimal(
            session.query(func.coalesce(func.sum(BetParticipationModel.sol_amount), 0.0))
            .filter(
                BetParticipationModel.lottery_id == candidate.lottery_id,
                active_bet_condition(BetParticipationModel),
            )
            .scalar()
        ).quantize(_ROUND_8, rounding=ROUND_HALF_UP)
        live_candidate = Phase1Candidate(
            lottery_id=candidate.lottery_id,
            status=lottery.status,
            end_date=lottery.end_date,
            max_total=_normalize_decimal(lottery.max_total) if lottery.max_total is not None else None,
            total_pool_sol=total_pool_sol,
            randomness_account=(lottery.randomness_account or "").strip() or None,
        )
        if not _should_trigger_phase2(live_candidate, datetime.now(timezone.utc)):
            return

        lottery_pda = _lottery_pda_for_signer(candidate.lottery_id, signer_pubkey)
        if not await _lottery_account_exists(client, lottery_pda):
            _throttled_log(
                logging.WARNING,
                f"missing-pda:{candidate.lottery_id}",
                "Phase transition skipped: signer %s is not the on-chain admin for lottery_id=%s",
                str(signer_pubkey),
                candidate.lottery_id,
            )
            return

        onchain = await _fetch_onchain_lottery_state(client, lottery_pda)
        if onchain.status == "Closed":
            _mark_closed(session, lottery)
            logging.info(
                "Phase 1 reconciliation marked on-chain closed lottery as closed (lottery_id=%s)",
                candidate.lottery_id,
            )
            return
        if onchain.status != "Open":
            _throttled_log(
                logging.WARNING,
                f"phase1-onchain-status:{candidate.lottery_id}:{onchain.status}",
                "Phase 1 transition skipped: unexpected on-chain status %s for lottery_id=%s",
                onchain.status,
                candidate.lottery_id,
            )
            return
        if lottery.status == LotteryStatus.ID_GENERATED:
            lottery.status = LotteryStatus.CREATED
            session.commit()
            session.refresh(lottery)
            logging.info(
                "Phase 1 reconciliation recovered missed initialize event (lottery_id=%s)",
                candidate.lottery_id,
            )

        weights_hash = _build_weights_hash(session, candidate.lottery_id)
        onchain_is_empty = onchain.deposits_count == 0 and onchain.total_deposited_lamports == 0
        db_deposits_count = int(
            session.query(func.count(BetParticipationModel.id))
            .filter(
                BetParticipationModel.lottery_id == candidate.lottery_id,
                active_bet_condition(BetParticipationModel),
            )
            .scalar()
            or 0
        )
        db_total_lamports = int(total_pool_sol * Decimal("1000000000"))
        # Weight generation normalizes DB SOL totals to 8 decimal places, while on-chain
        # amounts use 9-decimal lamports. Equal deposit counts keep the small rounding
        # tolerance from hiding a missing event.
        rounding_tolerance_lamports = db_deposits_count * 10
        total_difference_lamports = abs(db_total_lamports - onchain.total_deposited_lamports)
        if onchain_is_empty and not weights_hash:
            await _close_empty_lottery(
                session=session,
                lottery=lottery,
                program=program,
                lottery_pda=lottery_pda,
                signer_pubkey=signer_pubkey,
            )
            logging.info(
                "Lottery auto-closed: phase 1 ended with no eligible bets (lottery_id=%s)",
                candidate.lottery_id,
            )
            return
        if (
            onchain_is_empty != (not weights_hash)
            or db_deposits_count != onchain.deposits_count
            or total_difference_lamports > rounding_tolerance_lamports
        ):
            _throttled_log(
                logging.ERROR,
                f"deposit-mismatch:{candidate.lottery_id}:{db_deposits_count}:{onchain.deposits_count}:"
                f"{db_total_lamports}:{onchain.total_deposited_lamports}",
                "Phase 1 transition blocked: DB/on-chain deposit mismatch "
                "(lottery_id=%s, db_deposits_count=%s, onchain_deposits_count=%s, "
                "db_total_lamports=%s, onchain_total_lamports=%s, difference_lamports=%s, "
                "rounding_tolerance_lamports=%s, weights_hash_present=%s). Waiting for event backfill.",
                candidate.lottery_id,
                db_deposits_count,
                onchain.deposits_count,
                db_total_lamports,
                onchain.total_deposited_lamports,
                total_difference_lamports,
                rounding_tolerance_lamports,
                bool(weights_hash),
            )
            return

        # One transaction: the round closes and the randomness is asked for
        # together, so there is no window where deposits are shut and nothing
        # has been requested.
        signature, request, seed_slot = await _start_second_phase(
            program=program,
            client=client,
            lottery_pda=lottery_pda,
            signer_pubkey=signer_pubkey,
            weights_hash=weights_hash,
        )
        randomness_account = str(request)
        lottery.randomness_account = randomness_account
        _mark_phase2_started(session, lottery)
        logging.info(
            "Phase 2 auto-start succeeded (lottery_id=%s, tx=%s, randomness_account=%s, second_phase_started_at=%s)",
            candidate.lottery_id,
            signature,
            randomness_account,
            lottery.second_phase_started_at,
        )
    except Exception:
        session.rollback()
        raise
    finally:
        if lock_acquired:
            try:
                _release_advisory_lock(session, candidate.lottery_id)
                session.commit()
            except Exception:
                session.rollback()
        session.close()


async def _process_phase2_candidate(
    candidate: Phase2Candidate,
    client: AsyncClient,
    program: Program,
    signer_pubkey: Pubkey,
) -> None:
    settings = _settings()
    session = SessionLocal()
    lock_acquired = False
    try:
        lock_acquired = _try_advisory_lock(session, candidate.lottery_id)
        if not lock_acquired:
            return

        lottery = _ensure_lottery_in_phase2(session, candidate.lottery_id)
        if not lottery:
            return

        lottery_pda = _lottery_pda_for_signer(candidate.lottery_id, signer_pubkey)
        if not await _lottery_account_exists(client, lottery_pda):
            _throttled_log(
                logging.WARNING,
                f"missing-phase2-pda:{candidate.lottery_id}",
                "Phase 2 automation skipped: signer %s is not the on-chain admin for lottery_id=%s",
                str(signer_pubkey),
                candidate.lottery_id,
            )
            return

        onchain = await _fetch_onchain_lottery_state(client, lottery_pda)
        _sync_phase2_metadata_from_onchain(session, lottery, onchain)

        if onchain.status == "ReadyToDraw":
            _mark_vrf_fulfilled(
                session,
                lottery,
                onchain.vrf_seed_hex or _normalize_seed_hex(lottery.vrf_seed),
                offchain=bool(lottery.is_offchain_vrf),
            )
            return

        if onchain.status != "PendingVrf" or onchain.vrf_called:
            return

        request = Pubkey.from_string(onchain.randomness_account.strip())
        if lottery.randomness_account != str(request):
            lottery.randomness_account = str(request)
            session.commit()
            session.refresh(lottery)

        state = await _read_orao_request(client, request)
        if state is not None and state.seed != onchain.vrf_force:
            # The request account is a PDA of the seed, so this cannot happen
            # by accident. If it ever did, drawing from it would be drawing
            # from somebody else's randomness.
            raise RuntimeError(
                f"ORAO request {request} carries a seed this round did not ask for "
                f"(lottery_id={candidate.lottery_id})"
            )

        if state is not None and state.fulfilled:
            signature = await _fulfill_randomness(program, lottery_pda, request)
            seed_hex = orao_vrf.fold_randomness(state.randomness).hex()
            _mark_vrf_fulfilled(session, lottery, seed_hex, offchain=False)
            logging.info(
                "Draw taken from ORAO (lottery_id=%s, tx=%s, request=%s, seed=%s)",
                candidate.lottery_id,
                signature,
                request,
                seed_hex,
            )
            return

        # Still waiting. ORAO answers in about a second, so anything past the
        # delay means the network is down rather than busy.
        now_utc = datetime.now(timezone.utc)
        requested_at = datetime.fromtimestamp(onchain.vrf_requested_ts, tz=timezone.utc)
        waited = (now_utc - requested_at).total_seconds()
        if waited < EMERGENCY_FULFILL_DELAY_SECONDS:
            _throttled_log(
                logging.INFO,
                f"vrf-waiting:{candidate.lottery_id}",
                "Waiting for ORAO (lottery_id=%s, request=%s, waited=%ss)",
                candidate.lottery_id,
                request,
                int(waited),
            )
            return

        # The program checks this again and refuses if randomness has arrived
        # in the meantime, so the worst this can do is fail.
        signature, seed_hex = await _emergency_fulfill_randomness(
            program, lottery_pda, signer_pubkey, request
        )
        _mark_vrf_fulfilled(session, lottery, seed_hex, offchain=True)
        logging.error(
            "ORAO did not answer within %ss; the round was drawn with a local seed "
            "(lottery_id=%s, tx=%s, request=%s). This is visible on the verification "
            "page as randomness_source=emergency.",
            EMERGENCY_FULFILL_DELAY_SECONDS,
            candidate.lottery_id,
            signature,
            request,
        )
    except Exception:
        session.rollback()
        raise
    finally:
        if lock_acquired:
            try:
                _release_advisory_lock(session, candidate.lottery_id)
                session.commit()
            except Exception:
                session.rollback()
        session.close()


async def _process_post_vrf_candidate(
    candidate: PostVrfCandidate,
    client: AsyncClient,
    program: Program,
    signer_pubkey: Pubkey,
) -> None:
    settings = _settings()
    session = SessionLocal()
    lock_acquired = False
    try:
        lock_acquired = _try_advisory_lock(session, candidate.lottery_id)
        if not lock_acquired:
            return

        lottery = _ensure_lottery_post_vrf(session, candidate.lottery_id)
        if not lottery:
            return

        lottery_pda = _lottery_pda_for_signer(candidate.lottery_id, signer_pubkey)
        if not await _lottery_account_exists(client, lottery_pda):
            _throttled_log(
                logging.WARNING,
                f"missing-post-vrf-pda:{candidate.lottery_id}",
                "Post-VRF automation skipped: signer %s is not the on-chain admin for lottery_id=%s",
                str(signer_pubkey),
                candidate.lottery_id,
            )
            return

        vault_pda = _vault_pda_for_lottery(lottery_pda)
        onchain = await _fetch_onchain_lottery_state(client, lottery_pda)

        if onchain.status == "Closed":
            _mark_closed(session, lottery)
            return
        _sync_phase2_metadata_from_onchain(session, lottery, onchain)

        if lottery.status == LotteryStatus.VRF_FULFILLED:
            if onchain.status == "ProceedingPurchases":
                # After start_purchases_phase the on-chain program may no longer expose
                # prediction deposit counters. The last valid deposit consistency gate is
                # immediately before start_purchases_phase while status is ReadyToDraw.
                _mark_proceeding_purchases(session, lottery)
                await _start_buyer_if_due(
                    session,
                    lottery,
                    datetime.now(timezone.utc),
                    fee_bps=onchain.fee_bps,
                )
                return

            if onchain.status != "ReadyToDraw":
                return

            now_utc = datetime.now(timezone.utc)
            fulfilled_at = _latest_event_created_at(
                session,
                ("VrfFulfilled", "EmergencySeedUsed"),
                str(lottery_pda),
            )
            if fulfilled_at is None:
                fulfilled_at = _VRF_FULFILLED_AT.get(candidate.lottery_id)
            if fulfilled_at is not None and now_utc < fulfilled_at + timedelta(
                seconds=settings.start_purchases_delay_seconds
            ):
                return

            if not _active_deposits_match_onchain(
                session,
                candidate.lottery_id,
                onchain,
                log_key_prefix="pre-purchases-deposit-mismatch",
            ):
                return

            signature = await _start_purchases_phase(
                program=program,
                lottery_pda=lottery_pda,
                vault_pda=vault_pda,
                signer_pubkey=signer_pubkey,
                wallet_fee=onchain.wallet_fee,
                wallet_keeper=onchain.wallet_keeper,
            )
            _mark_proceeding_purchases(session, lottery)
            logging.info(
                "Start purchases phase succeeded (lottery_id=%s, tx=%s, wallet_fee=%s, wallet_keeper=%s)",
                lottery.id,
                signature,
                onchain.wallet_fee,
                onchain.wallet_keeper,
            )
            await _start_buyer_if_due(
                session,
                lottery,
                datetime.now(timezone.utc),
                fee_bps=onchain.fee_bps,
            )
            return

        if lottery.status != LotteryStatus.PROCEEDING_PURCHASES:
            return

        if onchain.status == "Closed":
            _mark_closed(session, lottery)
            return
        if onchain.status != "ProceedingPurchases":
            return

        await _start_buyer_if_due(
            session,
            lottery,
            datetime.now(timezone.utc),
            fee_bps=onchain.fee_bps,
        )

        proceeding_started_at = _to_utc(lottery.proceeding_purchases_started_at)
        if proceeding_started_at is None:
            return

        close_at = proceeding_started_at + timedelta(
            seconds=max(0, settings.execution_countdown_seconds - settings.close_lottery_buffer_seconds)
        )
        if datetime.now(timezone.utc) < close_at:
            return

        signature = await _close_lottery_onchain(
            program=program,
            lottery_pda=lottery_pda,
            vault_pda=vault_pda,
            signer_pubkey=signer_pubkey,
        )
        _mark_closed(session, lottery)
        logging.info("Close lottery succeeded (lottery_id=%s, tx=%s)", lottery.id, signature)
    except Exception:
        session.rollback()
        raise
    finally:
        if lock_acquired:
            try:
                _release_advisory_lock(session, candidate.lottery_id)
                session.commit()
            except Exception:
                session.rollback()
        session.close()


async def _autostart_lottery_type(
    lottery_type: str,
    client: AsyncClient,
    runtime: AdminRuntime,
) -> None:
    settings = _settings()
    session = SessionLocal()
    lottery_id: Optional[int] = None
    transaction_submitted = False
    try:
        _release_stuck_drafts(session, lottery_type, datetime.now(timezone.utc))
        was_cycle_enabled = is_cycle_enabled(session, lottery_type)
        has_blocking_lottery = _has_non_terminal_lottery(session, lottery_type)
        cycle_control = reconcile_hype_countdown(
            session,
            lottery_type,
            settings.lottery_hype_countdown_seconds,
            has_blocking_lottery,
        )
        resumed_from_hype_countdown = not was_cycle_enabled and cycle_control.enabled
        if not cycle_control.enabled:
            return
        if has_blocking_lottery:
            return

        created_by_user_id = _ensure_automation_user(session)
        now_utc = datetime.now(timezone.utc)
        if not resumed_from_hype_countdown and _has_active_execution_window(session, lottery_type, now_utc):
            return

        start_ts = int(now_utc.timestamp())
        end_utc = now_utc + timedelta(seconds=settings.lottery_autostart_prediction_seconds)
        end_ts = int(end_utc.timestamp())
        lottery_id = _generate_lottery_id(session)

        fee_bps = int(settings.lottery_autostart_fee_bps)
        if fee_bps < 0 or fee_bps > 65535:
            raise ValueError("LOTTERY_AUTOSTART_FEE_BPS must fit into u16")

        wallet_fee = str(Pubkey.from_string(settings.lottery_autostart_fee_wallet))
        wallet_keeper = str(Pubkey.from_string(settings.lottery_autostart_keeper_wallet))
        if wallet_fee == wallet_keeper:
            raise ValueError("LOTTERY_AUTOSTART_FEE_WALLET and LOTTERY_AUTOSTART_KEEPER_WALLET must differ")

        max_total_sol = settings.lottery_autostart_max_total_sol
        max_total_lamports = _decimal_sol_to_lamports(max_total_sol)
        vrf_algorithm_hash = _parse_vrf_algorithm_hash(settings.lottery_autostart_vrf_algorithm_hash)
        lottery_pda = _lottery_pda_for_signer(lottery_id, runtime.signer_pubkey)
        vault_pda = _vault_pda_for_lottery(lottery_pda)

        if await _lottery_account_exists(client, lottery_pda):
            logging.warning(
                "Lottery autostart skipped: generated lottery PDA already exists "
                "(lottery_id=%s, lottery_type=%s, signer=%s)",
                lottery_id,
                lottery_type,
                runtime.signer_pubkey,
            )
            return

        display_type = lottery_type.upper()
        lottery = LotteryModel(
            id=lottery_id,
            name=f"{display_type} Lottery {now_utc.strftime('%Y-%m-%d %H:%M:%S')} UTC",
            created_by_user_id=created_by_user_id,
            created_at=now_utc,
            end_date=end_utc,
            max_total=max_total_sol,
            lottery_pda=str(lottery_pda),
            lottery_type=lottery_type,
            status=LotteryStatus.ID_GENERATED,
        )
        session.add(lottery)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            logging.info(
                "Lottery autostart skipped: another open lottery already exists (lottery_type=%s)",
                lottery_type,
            )
            return

        signature = await _initialize_lottery_onchain(
            program=runtime.program,
            lottery_pda=lottery_pda,
            vault_pda=vault_pda,
            signer_pubkey=runtime.signer_pubkey,
            lottery_id=lottery_id,
            start_ts=start_ts,
            end_ts=end_ts,
            fee_bps=fee_bps,
            max_total_lamports=max_total_lamports,
            vrf_algorithm_hash=vrf_algorithm_hash,
            wallet_fee=wallet_fee,
            wallet_keeper=wallet_keeper,
        )
        transaction_submitted = True
        await _wait_for_lottery_account(client, lottery_pda)

        lottery.status = LotteryStatus.CREATED
        session.commit()
        logging.info(
            "Lottery autostart succeeded (lottery_id=%s, lottery_type=%s, tx=%s, signer=%s, "
            "max_total=%s SOL, prediction_seconds=%s)",
            lottery_id,
            lottery_type,
            signature,
            runtime.signer_pubkey,
            max_total_sol,
            settings.lottery_autostart_prediction_seconds,
        )
    except Exception as exc:
        session.rollback()
        if lottery_id is not None and not transaction_submitted:
            draft = session.query(LotteryModel).filter(
                LotteryModel.id == lottery_id,
                LotteryModel.status == LotteryStatus.ID_GENERATED,
            ).first()
            if draft is not None:
                kind = _phase2_error_kind(exc)
                # The draft is released whatever went wrong. Nothing was
                # submitted, so there is nothing to protect, and a draft left in
                # place stops every following round: the status is not terminal
                # and the cycle reads it as a round in progress. Keeping one for
                # a human to look at cost the devnet stand a day of silence.
                now_utc = datetime.now(timezone.utc)
                draft.status = LotteryStatus.INITIALIZE_ABANDONED
                draft.close_reason = "initialize_abandoned"
                draft.initialize_abandoned_at = now_utc
                # The type, not only the message: solana-py wrappers print as an
                # empty string and the log said `error=` and nothing else.
                draft.initialize_abandoned_error = f"{type(exc).__name__}: {exc}".strip()[:1000]
                session.commit()
                # A connection that blinked is routine and goes out as a warning.
                # Anything else is worth waking someone for, and error level is
                # what reaches the alert channel.
                logging.log(
                    logging.WARNING if kind == "transport" else logging.ERROR,
                    "Lottery autostart failed before submission; draft abandoned so the next cycle "
                    "can start (lottery_id=%s, lottery_type=%s, kind=%s, error=%s: %s)",
                    lottery_id,
                    lottery_type,
                    kind,
                    type(exc).__name__,
                    exc,
                )
        raise
    finally:
        session.close()


async def _process_lottery_autostart(
    client: AsyncClient,
    runtimes: list[AdminRuntime],
) -> None:
    settings = _settings()
    if not settings.lottery_autostart_enabled:
        return

    runtime = _select_autostart_runtime(runtimes, settings)
    if runtime is None:
        _throttled_log(
            logging.WARNING,
            "autostart-missing-signer",
            "Lottery autostart skipped: signer %s is not configured in LOTTERY_ADMIN_SIGNER_*",
            settings.lottery_admin_pubkey,
        )
        return

    for lottery_type in SUPPORTED_LOTTERY_TYPES:
        try:
            await _autostart_lottery_type(lottery_type, client, runtime)
        except Exception as exc:  # noqa: BLE001
            logging.exception("Lottery autostart failed (lottery_type=%s): %s", lottery_type, exc)


# ---------------------------------------------------------------- heartbeat

#: How long a round may legitimately spend in each phase before it becomes a
#: reason to wake people up. Measured from different starting points: an open
#: pool from its own closing time, the buying from its window.
_STUCK_AFTER_SECONDS = {
    "id_generated": 15 * 60,
    "created": 20 * 60,
    "phase2started": 30 * 60,
    "vrf_binded": 30 * 60,
    "vrf_fulfilled": 30 * 60,
}
#: How often to repeat a complaint about the same stuck round.
_STUCK_REPEAT_SECONDS = 60 * 60
_stuck_reported_at: dict[int, float] = {}

#: How often to write the heartbeat. A loop pass takes seconds, and a line per
#: pass clogs Loki and makes the logs unreadable. The "worker silent" alert
#: waits fifteen minutes, so a one minute step is plenty for it.
_HEARTBEAT_EVERY_SECONDS = 60
_heartbeat_logged_at: Optional[float] = None


def _phase_reference(lottery: LotteryModel, now: datetime) -> tuple[datetime, int]:
    """Where to measure the phase age from, and how long it may be."""
    status = lottery.status.value if hasattr(lottery.status, "value") else str(lottery.status)
    settings = _settings()

    if status == "created":
        # An open pool lives until its closing time plus headroom for closing.
        started = lottery.end_date or lottery.created_at
        return started, _STUCK_AFTER_SECONDS["created"]
    if status == "proceeding_purchases":
        started = lottery.proceeding_purchases_started_at or lottery.created_at
        # The buying window plus half an hour: the buyer honestly spends an hour, longer is worth a look.
        return started, int(settings.execution_countdown_seconds) + 30 * 60
    if status in ("phase2started", "vrf_binded", "vrf_fulfilled"):
        started = lottery.second_phase_started_at or lottery.created_at
        return started, _STUCK_AFTER_SECONDS[status]
    return lottery.created_at, _STUCK_AFTER_SECONDS.get(status, 30 * 60)


def _log_lifecycle_heartbeat(session: Session) -> None:
    """One log line per pass: it shows the worker is alive and what it is doing.

    This is also where a stuck round is caught. There is nowhere outside to
    check it from: the status lives in the database, not in the logs, so the
    worker has to say it is stuck itself. The complaint goes out at error level,
    so it reaches both the alerts and Grafana.

    The step is a minute rather than a loop pass: there can be twenty passes a
    minute, and a heartbeat on each turns the log into noise where real events
    are invisible.
    """
    global _heartbeat_logged_at

    monotonic_now = time.monotonic()
    if (
        _heartbeat_logged_at is not None
        and monotonic_now - _heartbeat_logged_at < _HEARTBEAT_EVERY_SECONDS
    ):
        return
    _heartbeat_logged_at = monotonic_now

    now = datetime.now(timezone.utc)
    active = (
        session.query(LotteryModel)
        .filter(
            LotteryModel.status.notin_(
                [
                    LotteryStatus.COMPLETED,
                    LotteryStatus.CLOSED,
                    LotteryStatus.INITIALIZE_ABANDONED,
                ]
            )
        )
        .all()
    )

    stuck = []
    oldest_status = "none"
    oldest_age = 0
    for lottery in active:
        started, limit_seconds = _phase_reference(lottery, now)
        started_utc = started if started.tzinfo else started.replace(tzinfo=timezone.utc)
        age = int((now - started_utc).total_seconds())
        status = lottery.status.value if hasattr(lottery.status, "value") else str(lottery.status)
        if age > oldest_age:
            oldest_age = age
            oldest_status = status
        if age > limit_seconds:
            stuck.append((lottery.id, status, age, limit_seconds))

    logging.info(
        "lifecycle-heartbeat active=%s stuck=%s oldest_status=%s oldest_age_seconds=%s",
        len(active),
        len(stuck),
        oldest_status,
        oldest_age,
    )

    for lottery_id, status, age, limit_seconds in stuck:
        # No record at all and "complained at second zero" are different things:
        # the monotonic clock starts at zero with the process, and through
        # `get(..., 0)` the first complaint would silently vanish for the whole
        # first hour of the worker's life.
        last = _stuck_reported_at.get(lottery_id)
        if last is not None and monotonic_now - last < _STUCK_REPEAT_SECONDS:
            continue
        _stuck_reported_at[lottery_id] = monotonic_now
        logging.error(
            "lifecycle-stuck lottery_id=%s status=%s age_seconds=%s limit_seconds=%s",
            lottery_id,
            status,
            age,
            limit_seconds,
        )

    # Forget the ones that have arrived: the dictionary must not grow forever.
    live_ids = {lottery.id for lottery in active}
    for lottery_id in list(_stuck_reported_at):
        if lottery_id not in live_ids:
            _stuck_reported_at.pop(lottery_id, None)


async def _run_iteration(
    client: AsyncClient,
    runtimes: list[AdminRuntime],
) -> None:
    session = SessionLocal()
    try:
        abandoned_initialize_candidates = _list_abandoned_initialize_candidates(session)
        phase1_candidates = _list_phase1_candidates(session)
        phase2_candidates = _list_phase2_candidates(session)
        post_vrf_candidates = _list_post_vrf_candidates(session)
        _log_lifecycle_heartbeat(session)
    finally:
        session.close()

    for candidate in abandoned_initialize_candidates:
        try:
            runtime = _resolve_admin_runtime(candidate.lottery_id, runtimes)
            if runtime:
                await _process_abandoned_initialize_candidate(
                    candidate,
                    client,
                    runtime.program,
                    runtime.signer_pubkey,
                )
        except Exception as exc:  # noqa: BLE001
            logging.exception("Abandoned initialize cleanup failed (lottery_id=%s): %s", candidate.lottery_id, exc)

    now_utc = datetime.now(timezone.utc)
    ready = [candidate for candidate in phase1_candidates if _should_trigger_phase2(candidate, now_utc)]
    for candidate in ready:
        try:
            runtime = _resolve_admin_runtime(candidate.lottery_id, runtimes)
            if runtime:
                await _process_phase1_candidate(
                    candidate,
                    client,
                    runtime.program,
                    runtime.signer_pubkey,
                )
        except Exception as exc:  # noqa: BLE001
            logging.exception("Phase 2 auto-start failed (lottery_id=%s): %s", candidate.lottery_id, exc)

    for candidate in phase2_candidates:
        try:
            runtime = _resolve_admin_runtime(candidate.lottery_id, runtimes)
            if runtime:
                await _process_phase2_candidate(
                    candidate,
                    client,
                    runtime.program,
                    runtime.signer_pubkey,
                )
        except Exception as exc:  # noqa: BLE001
            logging.exception("Phase 2 automation failed (lottery_id=%s): %s", candidate.lottery_id, exc)

    for candidate in post_vrf_candidates:
        # Slower once the buying is under way, and only then.
        #
        # A round in `PROCEEDING_PURCHASES` is waiting for its window to run
        # out, fifty-five minutes of it on mainnet, and nothing on chain changes
        # in that window more than twice. Asking every second was the same
        # question three thousand times for the same answer.
        #
        # `VRF_FULFILLED` is not that. It is the gap between the draw landing
        # and `start_purchases_phase`, the transaction that releases the pool
        # and starts the buying. Holding it back fifteen seconds would delay the
        # thing the round exists to do, on the one page where a countdown is
        # already running. It stays on the fast loop.
        if candidate.status == LotteryStatus.PROCEEDING_PURCHASES and not _post_vrf_poll_due(
            candidate.lottery_id
        ):
            continue
        try:
            runtime = _resolve_admin_runtime(candidate.lottery_id, runtimes)
            if runtime:
                await _process_post_vrf_candidate(
                    candidate,
                    client,
                    runtime.program,
                    runtime.signer_pubkey,
                )
        except Exception as exc:  # noqa: BLE001
            # The type is logged separately: solana-py wrappers have empty text,
            # and the alert used to go out without a single word about what happened.
            logging.exception(
                "Post-VRF automation failed (lottery_id=%s): %s: %s",
                candidate.lottery_id,
                type(exc).__name__,
                exc,
            )

    await _process_lottery_autostart(client, runtimes)


async def main() -> None:
    settings = _settings()
    setup_logging(settings)

    if not settings.phase2_automation_enabled:
        logging.info("Lottery phase worker is disabled. Set PHASE2_AUTOMATION_ENABLED=true to enable it.")
        return

    signers = _load_signer_keypairs()
    signer_pubkeys = [signer.pubkey() for signer in signers]
    signer_pubkey_strings = {str(pubkey) for pubkey in signer_pubkeys}
    configured_pubkeys = set(configured_admin_pubkeys(settings))
    missing_admin_signers = [
        pubkey
        for pubkey in configured_pubkeys
        if pubkey not in signer_pubkey_strings
    ]
    if missing_admin_signers:
        logging.warning(
            "Lifecycle automation has no private key for configured admins: %s. "
            "Lotteries owned by those admins will be detected but cannot be automated.",
            ",".join(missing_admin_signers),
        )
    unlisted_signers = sorted(signer_pubkey_strings - configured_pubkeys)
    if unlisted_signers:
        logging.warning(
            "Lifecycle signer pubkeys are missing from LOTTERY_ADMIN_PUBKEYS: %s. "
            "Add them so backend and event reconciliation can resolve their lotteries.",
            ",".join(unlisted_signers),
        )
    stop_event = asyncio.Event()
    _install_signal_handlers(stop_event)

    logging.info(
        "Starting lottery lifecycle worker (signers=%s, rpc=%s, interval=%ss, cap_threshold=%s, emergency_delay=%ss, start_purchases_delay=%ss, execution_countdown=%ss, close_buffer=%ss)",
        ",".join(str(pubkey) for pubkey in signer_pubkeys),
        settings.solana_http_endpoint,
        settings.phase2_poll_interval_seconds,
        settings.phase2_cap_threshold_sol,
        EMERGENCY_FULFILL_DELAY_SECONDS,
        settings.start_purchases_delay_seconds,
        settings.execution_countdown_seconds,
        settings.close_lottery_buffer_seconds,
    )

    async with AsyncClient(settings.solana_http_endpoint) as client:
        runtimes = [
            AdminRuntime(
                signer_pubkey=signer.pubkey(),
                program=_load_program(client, signer),
            )
            for signer in signers
        ]
        for runtime in runtimes:
            logging.info("Lifecycle admin runtime ready (signer=%s)", runtime.signer_pubkey)
        while not stop_event.is_set():
            try:
                await _run_iteration(client, runtimes)
            except Exception as exc:  # noqa: BLE001
                logging.exception("Lottery phase worker iteration failed: %s", exc)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=settings.phase2_poll_interval_seconds)
            except asyncio.TimeoutError:
                pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        logging.exception("Lottery phase worker terminated unexpectedly: %s", exc)
        sys.exit(1)
