from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import JSONResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from solders.pubkey import Pubkey
from solders.signature import Signature
from solana.rpc.api import Client
from solana.rpc.async_api import AsyncClient
from domain.lottery.services.lottery_service import LotteryService
from domain.lottery.repositories.lottery_repository import LotteryRepository
from infrastructure.lottery.database_lottery_repository import DatabaseLotteryRepository
from infrastructure.lottery.offchain_api_client import OffchainApiClient, build_offchain_api_client
from infrastructure.database.database import SessionLocal, get_db
from infrastructure.database.models.user_model import UserModel
from infrastructure.database.models.allowed_mint_model import AllowedMintModel
from infrastructure.database.models.token_metadata_model import TokenMetadataModel
from infrastructure.database.models.lottery_model import LotteryModel
from infrastructure.database.models.smart_contract_event_model import SmartContractEventModel
from application.lottery.schemas import LotteryListResponse, LotteryEntryResponse, PricePointResponse, CoinResponse, CreateLotteryRequest, LotteryResponse, PagedLotteryResponse, ProblemDetails, CreateBetRequest, BetParticipationResponse, VrfPreviewResponse, MintAllowTokenRequest, MintAllowTokenResponse, Phase2AccountsResponse, RunPurchasesPayload, RunPurchasesResponse, OffchainVrfRequest, ActiveLotterySummaryResponse, LotteryWinnerResultResponse, LotteryArchiveListResponse, LotteryArchiveItemResponse, LotteryArchiveEntryResponse, LotteryCycleControlResponse, LotteryCycleControlsResponse, HypeCountdownResponse
from application.lottery.schemas import PurchaseFeedResponse, PurchaseFeedCoinResponse, PurchaseFeedItemResponse
from application.lottery.schemas import CoinChartResponse, CoinChartPointResponse
from application.lottery.schemas import MyCommitsResponse, MyCommitRoundResponse, MyCommitCoinResponse
from application.lottery.schemas import LotteryVerificationResponse
from application.lottery.vrf_engine import VrfEngine
from domain.lottery.entities.lottery import Lottery, LotteryStatus, LotteryType
from domain.lottery.entities.allowed_mint import NetworkType
from domain.auth.entities.user import UserRole
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import asyncio
import os
import threading
import time
import secrets
import base64
import logging
import json
import ssl
from urllib import request as urllib_request, error as urllib_error
import certifi
from tenacity import Retrying, stop_after_attempt, wait_fixed, retry_if_exception_type, before_sleep_log
from shared.admin_wallets import configured_admin_pubkeys
from shared.weights_commitment import build_weights_commitment
from shared.bet_confirmation import (
    BET_STATUS_CONFIRMED,
    active_bet_condition,
    is_orphaned_bet,
)
from shared.deposit_event_decoder import DepositEvent, decode_deposit_events_from_logs
from shared.jwt_handler import JWTHandler
from shared import token_metadata_queue
from shared.coin_chart import coin_chart
from shared.wallet_owner import LINKED_VIA_DEPOSIT, LINKED_VIA_SIGNATURE, find_wallet_owner_id, link_wallet
from shared.settings import get_settings
from shared.lottery_cycle_control import list_cycle_controls, normalize_lottery_type, set_cycle_enabled
from shared.blocked_bet_mints import BLOCKED_BET_MINT_ERROR, WSOL_MINT, is_blocked_bet_mint
from shared.purchases_payload import (
    build_run_purchases_payload as _shared_build_run_purchases_payload,
    collect_lottery_weights as _shared_collect_lottery_weights,
    normalize_seed_hex as _shared_normalize_seed_hex,
    run_vrf_for_lottery as _shared_run_vrf_for_lottery,
)
from mint_validator import (
    NATIVE_SOL_QUOTE,
    get_pumpfun_curve_info,
    has_live_pumpswap_pool,
)

router = APIRouter(prefix="/lottery", tags=["lottery"])

# Unknown mints are loaded in the background, not inside a pool page request.
token_metadata_queue.configure(lambda mint: _fill_token_metadata_in_background(mint))
security = HTTPBearer()
jwt_handler = JWTHandler("your-secret-key-here")
logger = logging.getLogger(__name__)
MAX_VRF_RETRIES_ONCHAIN = 2  # Must match MAX_VRF_RETRIES in lottery contract.
ARCHIVE_WINDOW_DAYS = 7
#: How many rounds the archive returns at a time: the page shows history, not everything.
ARCHIVE_MAX_ITEMS = 50
#: How many recent rounds a person sees in their own history.
MY_COMMITS_MAX_ROUNDS = 20
_HTTPS_CONTEXT = ssl.create_default_context(cafile=certifi.where())

TOKEN_METADATA = {
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': {
        'name': 'Bonk',
        'symbol': 'BONK',
        'logo_url': 'https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I'
    },
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': {
        'name': 'dogwifhat',
        'symbol': 'WIF',
        'logo_url': 'https://bafkreicrxfxw7jzkmlbog3pjbgz55hwqr37zmhqrmajf4xwhcfdsdlhmxe.ipfs.nftstorage.link/'
    },
    'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4': {
        'name': 'MYRO',
        'symbol': 'MYRO',
        'logo_url': 'https://arweave.net/h_zZp8xQ8BI9FMZGYqiP4KXG6bKd4F_W7KqKKXKQoKs'
    },
    'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82': {
        'name': 'Bome',
        'symbol': 'BOME',
        'logo_url': 'https://bafkreie4px4iwqbq6qj6jxqk34xkjrqfdqvk66ptsxw3hvcmqfuanq2ski.ipfs.nftstorage.link/'
    },
    'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5': {
        'name': 'cat in a dogs world',
        'symbol': 'MEW',
        'logo_url': 'https://bafkreiewfqgzwmhqqwmzhqatyxyhzsrwch2tnnr5f5tphwfcv6cjq43p2e.ipfs.nftstorage.link'
    },
    'Ed4LDDQfJsqmNK9TBfF7UxGvN3i4yKaXEzMXbnKxWH1N': {
        'name': 'Popcat',
        'symbol': 'POPCAT',
        'logo_url': 'https://bafkreidmfbuv3ufvvbjkkgvkjolqtc2a6p2g4fxzpwnpllxltkv3qotzau.ipfs.nftstorage.link/'
    }
}


class DexLiquidityCheckUnavailable(RuntimeError):
    """Raised when DEX liquidity provider is temporarily unavailable."""


def _collect_lottery_weights(db: Session, lottery_id: int) -> dict[str, int]:
    return _shared_collect_lottery_weights(db, lottery_id)


def _normalize_seed_hex(seed_hex: str | None) -> str | None:
    return _shared_normalize_seed_hex(seed_hex)


def _to_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _datetime_from_epoch_ms(value: int | str | None) -> datetime | None:
    if value is None:
        return None

    try:
        timestamp_ms = int(value)
    except (TypeError, ValueError):
        return None

    # Lottery ids are generated from epoch milliseconds. Keep this guarded so
    # unrelated numeric ids never become timestamps accidentally.
    if timestamp_ms < 946684800000 or timestamp_ms > 4102444800000:
        return None

    return datetime.fromtimestamp(timestamp_ms / 1000, timezone.utc)


def _resolve_archive_started_at(lottery: Lottery) -> datetime | None:
    id_started_at = _datetime_from_epoch_ms(lottery.id)
    created_at = _to_utc_datetime(lottery.created_at)
    return id_started_at or created_at


def _run_vrf_for_lottery(weights: dict[str, int], lottery: Lottery) -> dict[str, object]:
    return _shared_run_vrf_for_lottery(weights, lottery)


def _build_lottery_winner_results(db: Session, lottery: Lottery) -> list[LotteryWinnerResultResponse]:
    if lottery.id is None:
        return []
    if lottery.status not in {
        LotteryStatus.VRF_FULFILLED,
        LotteryStatus.PROCEEDING_PURCHASES,
        LotteryStatus.COMPLETED,
        LotteryStatus.CLOSED,
    }:
        return []
    if not lottery.vrf_seed:
        return []

    weights = _collect_lottery_weights(db, lottery.id)
    if not weights:
        return []

    try:
        vrf_result = _run_vrf_for_lottery(weights, lottery)
    except Exception:
        logger.exception("Failed to build winner results for lottery_id=%s", lottery.id)
        return []
    wins_raw = vrf_result.get("wins", {}) if isinstance(vrf_result, dict) else {}
    targets_raw = vrf_result.get("targets", {}) if isinstance(vrf_result, dict) else {}

    winner_results: list[LotteryWinnerResultResponse] = []
    for mint, win_count in wins_raw.items():
        wins = int(win_count or 0)
        if wins <= 0:
            continue
        target_lamports = int(targets_raw.get(mint, 0) or 0)
        winner_results.append(
            LotteryWinnerResultResponse(
                mint=str(mint),
                wins=wins,
                target_lamports=target_lamports,
                target_sol=round(target_lamports / 1_000_000_000, 8),
            )
        )

    winner_results.sort(key=lambda item: (-item.target_lamports, item.mint))
    return winner_results


def _clean_token_metadata_value(value: object, max_length: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return cleaned[:max_length]


def _build_fallback_coin_metadata(mint: str) -> tuple[str, str, str]:
    if len(mint) >= 12:
        shortened_address = f"{mint[:6]}...{mint[-6:]}"
        fallback_symbol = f"{mint[:4]}".upper()
    else:
        shortened_address = mint or "Token"
        fallback_symbol = "TOKEN"
    return f"Token {shortened_address}", fallback_symbol, ""


def _persist_token_metadata(
    db: Session,
    mint: str,
    *,
    name: str | None = None,
    symbol: str | None = None,
    logo_url: str | None = None,
    commit: bool = True,
) -> TokenMetadataModel | None:
    canonical_mint = str(mint or "").strip()
    if not canonical_mint:
        return None

    cleaned_name = _clean_token_metadata_value(name, 255)
    cleaned_symbol = _clean_token_metadata_value(symbol, 64)
    cleaned_logo_url = _clean_token_metadata_value(logo_url, 1024)
    if not cleaned_name and not cleaned_symbol and not cleaned_logo_url:
        return None

    row = db.query(TokenMetadataModel).filter(TokenMetadataModel.mint == canonical_mint).first()
    if row is None:
        row = TokenMetadataModel(mint=canonical_mint)
        db.add(row)

    if cleaned_name:
        row.name = cleaned_name
    if cleaned_symbol:
        row.symbol = cleaned_symbol
    if cleaned_logo_url:
        row.logo_url = cleaned_logo_url
    row.updated_at = datetime.now(timezone.utc)

    if commit:
        db.commit()
    return row


def _persist_helius_metadata(db: Session, mint: str, metadata: dict[str, str | None], *, commit: bool = True) -> None:
    _persist_token_metadata(
        db,
        mint,
        name=metadata.get("token_name"),
        symbol=metadata.get("token_symbol"),
        logo_url=metadata.get("token_image_url"),
        commit=commit,
    )



#: The buyer's purchase response: held for a few seconds so that ten open pages
#: do not become ten reads of its state from disk.
PURCHASE_FEED_CACHE_SECONDS = 5.0
_PURCHASE_FEED_CACHE: dict[int, tuple[float, dict[str, object] | None]] = {}
_PURCHASE_FEED_LOCK = threading.Lock()


def _cached_purchase_feed(lottery_id: int) -> dict[str, object] | None:
    now = time.monotonic()
    with _PURCHASE_FEED_LOCK:
        cached = _PURCHASE_FEED_CACHE.get(lottery_id)
        if cached and now - cached[0] < PURCHASE_FEED_CACHE_SECONDS:
            return cached[1]

    payload = build_offchain_api_client().fetch_purchases(lottery_id)
    with _PURCHASE_FEED_LOCK:
        _PURCHASE_FEED_CACHE[lottery_id] = (time.monotonic(), payload)
        # There are not many rounds in a day, but the cache still must not grow forever.
        if len(_PURCHASE_FEED_CACHE) > 32:
            oldest = sorted(_PURCHASE_FEED_CACHE.items(), key=lambda item: item[1][0])[:8]
            for key, _ in oldest:
                _PURCHASE_FEED_CACHE.pop(key, None)
    return payload


def _purchase_time(raw_value: object) -> datetime:
    """The purchase time from the buyer's milliseconds; junk becomes "now"."""
    try:
        return datetime.fromtimestamp(int(raw_value) / 1000, tz=timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def _get_coin_metadata(db: Session, mint: str) -> tuple[str, str, str]:
    """A coin's name, ticker and picture, from whatever is already at hand.

    We do not go out for them from here: this path sits in `/lottery/current`,
    which the pool page polls every few seconds, and a trip to Helius blocks the
    response for seconds. An unknown mint goes into the background queue and
    turns up with a name on the next poll.
    """
    metadata = TOKEN_METADATA.get(mint)
    if metadata:
        return metadata['name'], metadata['symbol'], metadata['logo_url']

    row = db.query(TokenMetadataModel).filter(TokenMetadataModel.mint == mint).first()
    if row and (row.name or row.symbol or row.logo_url):
        fallback_name, fallback_symbol, fallback_logo = _build_fallback_coin_metadata(mint)
        return row.name or fallback_name, row.symbol or fallback_symbol, row.logo_url or fallback_logo

    token_metadata_queue.request_fill(mint)
    return _build_fallback_coin_metadata(mint)


def _fill_token_metadata_in_background(mint: str) -> bool:
    """Download the metadata and store it. Called by the background queue thread."""
    fetched_metadata = _fetch_token_metadata(mint)
    if not any(fetched_metadata.values()):
        return False

    session = SessionLocal()
    try:
        _persist_helius_metadata(session, mint, fetched_metadata, commit=True)
        return True
    except Exception:
        session.rollback()
        logger.exception("failed to persist token metadata (mint=%s)", mint)
        return False
    finally:
        session.close()


def _build_archive_close_event_map(
    db: Session,
    lotteries: list[Lottery],
) -> dict[int, datetime]:
    if not lotteries:
        return {}

    admin_pubkeys = _configured_admin_pubkeys(get_settings())
    if not admin_pubkeys:
        return {}

    lottery_pubkey_to_id: dict[str, int] = {}
    for lottery in lotteries:
        if lottery.id is None:
            continue
        for admin_pubkey in admin_pubkeys:
            try:
                lottery_pda = _derive_lottery_pda(
                    lottery_id=int(lottery.id),
                    program_id_raw=get_settings().lottery_program_id,
                    admin_pubkey_raw=admin_pubkey,
                )
            except Exception:
                continue
            lottery_pubkey_to_id[str(lottery_pda)] = int(lottery.id)

    if not lottery_pubkey_to_id:
        return {}

    events = db.query(SmartContractEventModel).filter(
        SmartContractEventModel.event_name == "PhaseChanged"
    ).order_by(SmartContractEventModel.created_at.desc()).all()

    close_event_map: dict[int, datetime] = {}
    for event in events:
        payload = event.data if isinstance(event.data, dict) else {}
        if str(payload.get("status", "")).lower() != "closed":
            continue
        lottery_pubkey = str(payload.get("lottery", "")).strip()
        lottery_id = lottery_pubkey_to_id.get(lottery_pubkey)
        if lottery_id is None or lottery_id in close_event_map:
            continue
        close_event_map[lottery_id] = _to_utc_datetime(event.created_at) or datetime.now(timezone.utc)

    return close_event_map


def _resolve_archive_ended_at(
    lottery: Lottery,
    close_event_map: dict[int, datetime],
) -> tuple[datetime | None, str | None]:
    if lottery.id is None:
        return None, None

    close_event_at = close_event_map.get(int(lottery.id))
    proceeding_started_at = _to_utc_datetime(lottery.proceeding_purchases_started_at)
    if proceeding_started_at is not None:
        execution_window_end = proceeding_started_at + timedelta(seconds=get_settings().execution_countdown_seconds)
        if close_event_at is not None and close_event_at > execution_window_end:
            return close_event_at, "close_event"
        return execution_window_end, "execution_window"

    if close_event_at is not None:
        return close_event_at, "close_event"

    if (
        lottery.status == LotteryStatus.CLOSED
        and lottery.close_reason == "initialize_abandoned"
        and lottery.initialize_abandoned_at is not None
    ):
        return _to_utc_datetime(lottery.initialize_abandoned_at), "initialize_abandoned"

    second_phase_started_at = _to_utc_datetime(lottery.second_phase_started_at)
    if lottery.status in {LotteryStatus.CLOSED, LotteryStatus.COMPLETED} and second_phase_started_at is not None:
        return second_phase_started_at, "phase2_fallback"

    end_date = _to_utc_datetime(lottery.end_date)
    if lottery.status in {LotteryStatus.CLOSED, LotteryStatus.COMPLETED} and end_date is not None:
        return end_date, "end_date_fallback"

    return None, None


def _build_lottery_archive_entries(
    db: Session,
    lottery: Lottery,
    winner_results: list[LotteryWinnerResultResponse],
) -> list[LotteryArchiveEntryResponse]:
    if lottery.id is None:
        return []

    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    bet_stats = db.query(
        BetParticipationModel.meme_coin_address,
        func.sum(BetParticipationModel.sol_amount).label('total_solana_bet'),
    ).filter(
        BetParticipationModel.lottery_id == lottery.id,
        active_bet_condition(BetParticipationModel),
    ).group_by(
        BetParticipationModel.meme_coin_address
    ).order_by(
        func.sum(BetParticipationModel.sol_amount).desc()
    ).all()

    winners_by_mint = {item.mint: item.target_sol for item in winner_results}
    rows: list[LotteryArchiveEntryResponse] = []
    for rank, (meme_coin_address, total_bet) in enumerate(bet_stats, 1):
        mint = str(meme_coin_address)
        coin_name, coin_symbol, _ = _get_coin_metadata(db, mint)
        rows.append(
            LotteryArchiveEntryResponse(
                rank=rank,
                mint=mint,
                name=coin_name,
                ticker=coin_symbol,
                total_solana_bet=round(float(total_bet or 0.0), 8),
                won_sol=winners_by_mint.get(mint),
            )
        )

    return rows


def _build_run_purchases_payload(db: Session, lottery: Lottery) -> dict[str, object]:
    return _shared_build_run_purchases_payload(db, lottery)

def get_lottery_repository(db: Session = Depends(get_db)) -> LotteryRepository:
    return DatabaseLotteryRepository(db)


def get_lottery_service(lottery_repository: LotteryRepository = Depends(get_lottery_repository)) -> LotteryService:
    return LotteryService(lottery_repository)


def get_offchain_api_client() -> OffchainApiClient:
    return build_offchain_api_client()


def _parse_lottery_type(raw_value: str | None) -> LotteryType:
    value = (raw_value or "pumpfun").strip().lower()
    if value in {"dex"}:
        return LotteryType.DEX
    if value in {"pumpfun", "pump", "pump_fun"}:
        return LotteryType.PUMPFUN
    raise HTTPException(status_code=400, detail="lottery_type must be 'dex' or 'pumpfun'")


def _to_lottery_response(lottery: Lottery) -> LotteryResponse:
    return LotteryResponse(
        id=lottery.id,
        name=lottery.name,
        lottery_type=lottery.lottery_type.value,
        created_by_user_id=lottery.created_by_user_id,
        created_at=lottery.created_at,
        end_date=lottery.end_date,
        second_phase_started_at=lottery.second_phase_started_at,
        proceeding_purchases_started_at=lottery.proceeding_purchases_started_at,
        is_offchain_vrf=lottery.is_offchain_vrf,
        status=lottery.status.value,
        close_reason=lottery.close_reason,
        initialize_abandoned_at=lottery.initialize_abandoned_at,
        initialize_abandoned_error=lottery.initialize_abandoned_error,
        max_total=lottery.max_total,
        vrf_seed=lottery.vrf_seed,
        randomness_account=lottery.randomness_account,
    )


def _to_int(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except Exception:
        return None


def _derive_lottery_pda(lottery_id: int, program_id_raw: str, admin_pubkey_raw: str) -> Pubkey:
    program_id = Pubkey.from_string(program_id_raw)
    admin_pubkey = Pubkey.from_string(admin_pubkey_raw)
    lottery_id_le_bytes = int(lottery_id).to_bytes(8, byteorder="little", signed=False)
    lottery_pda, _ = Pubkey.find_program_address(
        [b"lottery", bytes(admin_pubkey), lottery_id_le_bytes],
        program_id,
    )
    return lottery_pda


def _configured_admin_pubkeys(settings) -> list[str]:
    return configured_admin_pubkeys(settings)


def _derive_existing_lottery_pda(
    lottery_id: int,
    program_id_raw: str,
    admin_pubkeys_raw: list[str],
    rpc_endpoint: str,
) -> tuple[Pubkey, bytes, str]:
    last_error: Exception | None = None
    for admin_pubkey_raw in admin_pubkeys_raw:
        try:
            lottery_pda = _derive_lottery_pda(
                lottery_id=lottery_id,
                program_id_raw=program_id_raw,
                admin_pubkey_raw=admin_pubkey_raw,
            )
            raw = _rpc_get_account_data(rpc_endpoint, str(lottery_pda))
            return lottery_pda, raw, admin_pubkey_raw
        except Exception as exc:
            last_error = exc
            continue

    raise RuntimeError(
        f"Lottery PDA was not found for lottery_id={lottery_id} with configured admin pubkeys"
    ) from last_error


#: A pool's addresses by its number. The derivation is deterministic, and the
#: RPC call is only needed to tell which admin key created this pool, an answer
#: that does not change while the pool exists. Without the cache
#: `/lottery/current` hit RPC on every poll of every visitor: a hundred open
#: tabs became thousands of requests a minute and ate the provider's monthly
#: limit in a couple of days.
ACCOUNT_SUMMARY_TTL_SECONDS = 15 * 60
ACCOUNT_SUMMARY_MISS_TTL_SECONDS = 20
_ACCOUNT_SUMMARY_CACHE: dict[int, tuple[float, tuple[str | None, str | None, str | None]]] = {}
_ACCOUNT_SUMMARY_LOCK = threading.Lock()


def _derive_lottery_account_summary(
    lottery_id: int,
    settings,
) -> tuple[str | None, str | None, str | None]:
    now = time.monotonic()
    with _ACCOUNT_SUMMARY_LOCK:
        cached = _ACCOUNT_SUMMARY_CACHE.get(lottery_id)
        if cached and now < cached[0]:
            return cached[1]

    summary = _derive_lottery_account_summary_uncached(lottery_id, settings)
    # A miss is cached briefly: the pool may not have appeared on the network yet.
    ttl = ACCOUNT_SUMMARY_TTL_SECONDS if summary[0] else ACCOUNT_SUMMARY_MISS_TTL_SECONDS
    with _ACCOUNT_SUMMARY_LOCK:
        _ACCOUNT_SUMMARY_CACHE[lottery_id] = (time.monotonic() + ttl, summary)
        if len(_ACCOUNT_SUMMARY_CACHE) > 256:
            for key, _ in sorted(_ACCOUNT_SUMMARY_CACHE.items(), key=lambda item: item[1][0])[:64]:
                _ACCOUNT_SUMMARY_CACHE.pop(key, None)
    return summary


def _derive_lottery_account_summary_uncached(
    lottery_id: int,
    settings,
) -> tuple[str | None, str | None, str | None]:
    try:
        lottery_pda, _, admin_pubkey = _derive_existing_lottery_pda(
            lottery_id=lottery_id,
            program_id_raw=settings.lottery_program_id,
            admin_pubkeys_raw=_configured_admin_pubkeys(settings),
            rpc_endpoint=settings.solana_http_endpoint,
        )
        program_id = Pubkey.from_string(settings.lottery_program_id)
        vault_pda, _ = Pubkey.find_program_address(
            [b"vault", bytes(lottery_pda)],
            program_id,
        )
        return str(lottery_pda), str(vault_pda), admin_pubkey
    except Exception:
        logger.debug(
            "failed to derive lottery account summary for lottery_id=%s",
            lottery_id,
            exc_info=True,
        )
        return None, None, None


def _rpc_get_account_data(endpoint: str, account: str) -> bytes:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [account, {"encoding": "base64", "commitment": "confirmed"}],
    }
    req = urllib_request.Request(
        url=endpoint,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib_request.urlopen(req, timeout=get_settings().external_lookup_timeout_seconds, context=_HTTPS_CONTEXT) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = str(exc)
        raise RuntimeError(f"Solana RPC HTTP {exc.code}: {detail}") from exc
    except urllib_error.URLError as exc:
        raise RuntimeError(f"Solana RPC is unavailable at {endpoint}: {exc}") from exc

    parsed = json.loads(raw) if raw else {}
    result = parsed.get("result", {}) if isinstance(parsed, dict) else {}
    value = result.get("value") if isinstance(result, dict) else None
    if not value:
        raise RuntimeError(f"Account {account} not found on Solana RPC")

    data = value.get("data") if isinstance(value, dict) else None
    if not isinstance(data, list) or len(data) < 1:
        raise RuntimeError(f"Invalid account data format for {account}")
    encoded = data[0]
    if not isinstance(encoded, str):
        raise RuntimeError(f"Invalid account data type for {account}")
    return base64.b64decode(encoded)


def _fetch_helius_token_metadata(mint_address: str) -> dict[str, str | None]:
    settings = get_settings()
    api_key = settings.helius_api_key.strip()
    if not api_key:
        return {"token_name": None, "token_symbol": None, "token_image_url": None}

    base_url = settings.helius_das_base_url.rstrip("/")
    url = f"{base_url}/?api-key={api_key}"
    payload = {
        "jsonrpc": "2.0",
        "id": "qres-check-mint",
        "method": "getAsset",
        "params": {"id": mint_address},
    }
    req = urllib_request.Request(
        url=url,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )

    try:
        with urllib_request.urlopen(req, timeout=settings.external_lookup_timeout_seconds, context=_HTTPS_CONTEXT) as response:
            raw = response.read().decode("utf-8")
            data = json.loads(raw or "{}")
    except Exception as exc:
        logger.warning("check-mint metadata fetch failed (mint=%s, error=%s)", mint_address, exc)
        return {"token_name": None, "token_symbol": None, "token_image_url": None}

    result = data.get("result") or {}
    content = result.get("content") or {}
    metadata = content.get("metadata") or {}
    links = content.get("links") or {}
    files = content.get("files") or []

    token_name = metadata.get("name")
    token_symbol = metadata.get("symbol")

    token_image_url = links.get("image")
    if not token_image_url and isinstance(files, list) and files:
        first_file = files[0] if isinstance(files[0], dict) else {}
        token_image_url = first_file.get("uri")
    if not token_image_url:
        token_image_url = metadata.get("image")

    return {
        "token_name": token_name if isinstance(token_name, str) else None,
        "token_symbol": token_symbol if isinstance(token_symbol, str) else None,
        "token_image_url": token_image_url if isinstance(token_image_url, str) else None,
    }


def _fetch_pumpfun_token_metadata(mint_address: str) -> dict[str, str | None]:
    if not mint_address.endswith("pump"):
        return {"token_name": None, "token_symbol": None, "token_image_url": None}

    url = f"https://frontend-api-v3.pump.fun/coins/{mint_address}?sync=true"
    req = urllib_request.Request(
        url=url,
        method="GET",
        headers={"Accept": "application/json", **_build_dexscreener_headers()},
    )

    try:
        with urllib_request.urlopen(req, timeout=get_settings().external_lookup_timeout_seconds, context=_HTTPS_CONTEXT) as response:
            raw = response.read().decode("utf-8")
            data = json.loads(raw or "{}")
    except urllib_error.HTTPError as exc:
        if exc.code != 404:
            logger.warning("pump.fun metadata fetch failed (mint=%s, status=%s)", mint_address, exc.code)
        return {"token_name": None, "token_symbol": None, "token_image_url": None}
    except Exception as exc:
        logger.warning("pump.fun metadata fetch failed (mint=%s, error=%s)", mint_address, exc)
        return {"token_name": None, "token_symbol": None, "token_image_url": None}

    if not isinstance(data, dict):
        return {"token_name": None, "token_symbol": None, "token_image_url": None}

    token_name = data.get("name")
    token_symbol = data.get("symbol")
    token_image_url = data.get("image_uri") or data.get("image")
    return {
        "token_name": token_name if isinstance(token_name, str) else None,
        "token_symbol": token_symbol if isinstance(token_symbol, str) else None,
        "token_image_url": token_image_url if isinstance(token_image_url, str) else None,
    }


def _fetch_dexscreener_token_metadata(mint_address: str) -> dict[str, str | None]:
    try:
        pools = _fetch_dex_pools_for_mint(mint_address)
    except Exception as exc:
        logger.warning("DexScreener metadata fetch failed (mint=%s, error=%s)", mint_address, exc)
        return {"token_name": None, "token_symbol": None, "token_image_url": None}

    for pool in pools:
        base_token = pool.get("baseToken")
        quote_token = pool.get("quoteToken")
        token = None
        if isinstance(base_token, dict) and str(base_token.get("address") or "").strip() == mint_address:
            token = base_token
        elif isinstance(quote_token, dict) and str(quote_token.get("address") or "").strip() == mint_address:
            token = quote_token
        if not token:
            continue

        info = pool.get("info") if isinstance(pool.get("info"), dict) else {}
        token_name = token.get("name")
        token_symbol = token.get("symbol")
        token_image_url = info.get("imageUrl")
        return {
            "token_name": token_name if isinstance(token_name, str) else None,
            "token_symbol": token_symbol if isinstance(token_symbol, str) else None,
            "token_image_url": token_image_url if isinstance(token_image_url, str) else None,
        }

    return {"token_name": None, "token_symbol": None, "token_image_url": None}


def _fetch_token_metadata(mint_address: str) -> dict[str, str | None]:
    fetchers = (
        _fetch_pumpfun_token_metadata,
        _fetch_helius_token_metadata,
        _fetch_dexscreener_token_metadata,
    )
    for fetcher in fetchers:
        metadata = fetcher(mint_address)
        if metadata.get("token_name") or metadata.get("token_symbol") or metadata.get("token_image_url"):
            return metadata
    return {"token_name": None, "token_symbol": None, "token_image_url": None}


def _to_float(value: object) -> float:
    try:
        parsed = float(str(value).strip())
        return parsed if parsed > 0 else 0.0
    except Exception:
        return 0.0


def _build_dexscreener_headers() -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": (
            "pumpling/1.0 "
            "(contact: pumpling.xyz@gmail.com)"
        ),
    }


def _fetch_dex_pools_for_mint_once(mint_address: str) -> list[dict[str, object]]:
    urls = [
        f"https://api.dexscreener.com/token-pairs/v1/solana/{mint_address}",
        f"https://api.dexscreener.com/tokens/v1/solana/{mint_address}",
    ]
    # A reference lookup: someone is waiting on screen, so the timeout is short.
    timeout_seconds = get_settings().external_lookup_timeout_seconds
    headers = _build_dexscreener_headers()
    errors: list[str] = []

    for url in urls:
        req = urllib_request.Request(
            url=url,
            method="GET",
            headers=headers,
        )
        try:
            with urllib_request.urlopen(req, timeout=timeout_seconds, context=_HTTPS_CONTEXT) as response:
                raw = response.read().decode("utf-8")
            parsed = json.loads(raw or "[]")
            if isinstance(parsed, list):
                return [item for item in parsed if isinstance(item, dict)]
            if isinstance(parsed, dict):
                pairs = parsed.get("pairs")
                if isinstance(pairs, list):
                    return [item for item in pairs if isinstance(item, dict)]
            return []
        except urllib_error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8")
            except Exception:
                detail = str(exc)
            if exc.code == 404:
                return []
            errors.append(f"{url} -> HTTP {exc.code}: {detail}")
            continue
        except urllib_error.URLError as exc:
            errors.append(f"{url} -> URLError: {exc}")
            continue

    raise DexLiquidityCheckUnavailable("DexScreener request failed; " + " | ".join(errors))


#: A coin's DEX pools are held for a minute: validating a coin and drawing its
#: market card ask the same question, and the provider rate limits us.
DEX_POOLS_CACHE_SECONDS = 60.0
_DEX_POOLS_CACHE: dict[str, tuple[float, list[dict[str, object]]]] = {}


def _cached_dex_pools(mint_address: str) -> list[dict[str, object]]:
    now = time.monotonic()
    cached = _DEX_POOLS_CACHE.get(mint_address)
    if cached and now - cached[0] < DEX_POOLS_CACHE_SECONDS:
        return cached[1]
    pools = _fetch_dex_pools_for_mint(mint_address)
    _DEX_POOLS_CACHE[mint_address] = (now, pools)
    if len(_DEX_POOLS_CACHE) > 256:
        for key, _ in sorted(_DEX_POOLS_CACHE.items(), key=lambda item: item[1][0])[:64]:
            _DEX_POOLS_CACHE.pop(key, None)
    return pools


def _best_dex_pair(mint_address: str, pools: list[dict[str, object]]) -> dict[str, object] | None:
    """The coin's deepest pool: the one we price and size it by.

    A coin can have several pools, and in the small ones the price jumps around.
    We take the one with more liquidity: that is the market for this coin.
    """
    best: dict[str, object] | None = None
    best_usd = -1.0
    for pool in pools:
        base_token = pool.get("baseToken")
        if not isinstance(base_token, dict) or str(base_token.get("address") or "").strip() != mint_address:
            continue
        liquidity = pool.get("liquidity")
        usd = _to_float(liquidity.get("usd")) if isinstance(liquidity, dict) else 0.0
        if usd > best_usd:
            best_usd = usd
            best = pool
    return best


def _dex_market_info(mint_address: str, pools: list[dict[str, object]]) -> dict[str, object]:
    """Price, market cap and liquidity — what a person recognises a coin by."""
    pair = _best_dex_pair(mint_address, pools)
    if not pair:
        return {}

    liquidity = pair.get("liquidity") if isinstance(pair.get("liquidity"), dict) else {}
    price_change = pair.get("priceChange") if isinstance(pair.get("priceChange"), dict) else {}
    volume = pair.get("volume") if isinstance(pair.get("volume"), dict) else {}
    market_cap = _to_float(pair.get("marketCap")) or _to_float(pair.get("fdv"))

    info: dict[str, object] = {}
    price_usd = _to_float(pair.get("priceUsd"))
    if price_usd > 0:
        info["price_usd"] = price_usd
    if market_cap > 0:
        info["market_cap_usd"] = market_cap
    liquidity_usd = _to_float(liquidity.get("usd")) if isinstance(liquidity, dict) else 0.0
    if liquidity_usd > 0:
        info["liquidity_usd"] = liquidity_usd
    volume_24h = _to_float(volume.get("h24")) if isinstance(volume, dict) else 0.0
    if volume_24h > 0:
        info["volume_24h_usd"] = volume_24h
    if isinstance(price_change, dict) and price_change.get("h24") is not None:
        info["price_change_24h"] = _to_float(price_change.get("h24"))
    dex_id = str(pair.get("dexId") or "").strip()
    if dex_id:
        info["dex_id"] = dex_id
    pair_url = str(pair.get("url") or "").strip()
    if pair_url.startswith("http"):
        info["pair_url"] = pair_url
    return info


def _fetch_dex_pools_for_mint(mint_address: str) -> list[dict[str, object]]:
    retryer = Retrying(
        reraise=True,
        # Two attempts rather than three: on a live request path every extra
        # one is another six seconds of somebody waiting on screen.
        stop=stop_after_attempt(2),
        wait=wait_fixed(1),
        retry=retry_if_exception_type(DexLiquidityCheckUnavailable),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
    for attempt in retryer:
        with attempt:
            return _fetch_dex_pools_for_mint_once(mint_address)
    return []


def _count_direct_liquidity_pools(mint_address: str, pools: list[dict[str, object]]) -> int:
    count = 0
    for pool in pools:
        base_token = pool.get("baseToken")
        quote_token = pool.get("quoteToken")
        if not isinstance(base_token, dict) or not isinstance(quote_token, dict):
            continue
        base_address = str(base_token.get("address") or "").strip()
        quote_address = str(quote_token.get("address") or "").strip()
        is_direct_wsol_pair = (
            (base_address == mint_address and quote_address == WSOL_MINT)
            or (base_address == WSOL_MINT and quote_address == mint_address)
        )
        if not is_direct_wsol_pair:
            continue

        liquidity = pool.get("liquidity")
        if not isinstance(liquidity, dict):
            continue
        usd = _to_float(liquidity.get("usd"))
        base = _to_float(liquidity.get("base"))
        quote = _to_float(liquidity.get("quote"))
        if usd > 0 or base > 0 or quote > 0:
            count += 1
    return count


_JUPITER_QUOTE_URL = os.getenv("JUPITER_BASE_URL", "https://lite-api.jup.ag") + "/swap/v1/quote"
_JUPITER_PROBE_LAMPORTS = 1_000_000  # 0.001 SOL — enough for a route probe, amount is never spent
_LAMPORTS_PER_SOL = Decimal("1000000000")
_JUPITER_NO_ROUTE_ERROR_CODES = {
    "NO_ROUTES_FOUND",
    "COULD_NOT_FIND_ANY_ROUTE",
    "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT",
    "TOKEN_NOT_TRADABLE",
    "MARKET_NOT_FOUND",
}


def _sol_to_lamports(amount_sol: float) -> int:
    try:
        value = Decimal(str(amount_sol))
    except Exception:
        return 0
    if value <= 0:
        return 0
    return max(1, int((value * _LAMPORTS_PER_SOL).to_integral_value(rounding=ROUND_HALF_UP)))


def _is_jupiter_no_route_error_body(body: str) -> bool:
    fields = [body or ""]
    try:
        parsed = json.loads(body or "{}")
    except Exception:
        parsed = {}
    if isinstance(parsed, dict):
        for key in ("error", "errorCode", "message", "code"):
            value = parsed.get(key)
            if isinstance(value, str):
                fields.append(value)

    upper_fields = [field.upper() for field in fields]
    if any(code in field for code in _JUPITER_NO_ROUTE_ERROR_CODES for field in upper_fields):
        return True
    return any(
        "NO ROUTE" in field
        or "NO ROUTES" in field
        or "COULD NOT FIND ANY ROUTE" in field
        or "TOKEN_NOT_TRADABLE" in field
        or "NOT TRADABLE" in field
        or "MARKET NOT FOUND" in field
        or "ROUTE PLAN DOES NOT CONSUME" in field
        for field in upper_fields
    )


def _is_jupiter_tradable(mint_address: str) -> bool:
    """
    Probe Jupiter for a WSOL -> mint route. Graduated pump.fun tokens are bought
    through Jupiter by the offchain buyer first; if Jupiter has no route the buyer
    falls back to the canonical PumpSwap pool (see has_live_pumpswap_pool), so a
    missing route alone is not fatal — the caller also checks the pool.
    Provider outage is treated as tradable (allow at user risk, same policy as DEX check).
    """
    url = (
        f"{_JUPITER_QUOTE_URL}?inputMint={WSOL_MINT}&outputMint={mint_address}"
        f"&amount={_JUPITER_PROBE_LAMPORTS}&slippageBps=100"
    )
    req = urllib_request.Request(url=url, method="GET", headers={"Accept": "application/json"})
    try:
        with urllib_request.urlopen(req, timeout=get_settings().external_lookup_timeout_seconds, context=_HTTPS_CONTEXT) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = str(exc)
        if _is_jupiter_no_route_error_body(detail):
            logger.info("jupiter route probe rejected mint=%s: %s", mint_address, detail[:300])
            return False
        logger.warning("jupiter route probe unavailable (HTTP %s) mint=%s; allowing at user risk", exc.code, mint_address)
        return True
    except Exception as exc:
        logger.warning("jupiter route probe failed mint=%s; allowing at user risk. error=%s", mint_address, exc)
        return True

    try:
        parsed = json.loads(raw or "{}")
    except Exception:
        return True
    if isinstance(parsed, dict) and parsed.get("error") and _is_jupiter_no_route_error_body(raw):
        logger.info("jupiter route probe rejected mint=%s: %s", mint_address, str(parsed.get("errorCode") or parsed.get("error"))[:300])
        return False
    return True


def _validate_mint_by_lottery_type(
    mint_address: str,
    lottery_type: LotteryType,
    min_pumpswap_quote_lamports: int | None = None,
) -> tuple[str, NetworkType, bool, bool, int, bool]:
    try:
        mint_pubkey = Pubkey.from_string(mint_address.strip())
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid mint pubkey in request") from exc

    canonical_mint = str(mint_pubkey)
    if is_blocked_bet_mint(canonical_mint):
        raise HTTPException(status_code=400, detail=BLOCKED_BET_MINT_ERROR)

    settings = get_settings()
    rpc_url = settings.solana_http_endpoint or "https://api.mainnet-beta.solana.com"
    network_type = NetworkType.DEVNET if "devnet" in rpc_url else NetworkType.MAINNET

    if lottery_type == LotteryType.PUMPFUN:
        is_pumpfun, graduated, quote_mint = get_pumpfun_curve_info(canonical_mint, rpc_url=rpc_url)
        if not is_pumpfun:
            raise HTTPException(status_code=400, detail="Mint is not a valid pump.fun token")
        if not graduated and quote_mint != NATIVE_SOL_QUOTE:
            # Custom Pairs (pump.fun, 2026-09-09): the curve is denominated in USDC, WBTC or a
            # tokenized stock. buy_exact_sol_in cannot touch it (the program answers
            # UnsupportedQuoteMint), and while the coin is still ON the curve the only route from
            # SOL runs through the quote asset and then the curve itself - two hops that do not
            # fit in a transaction. Measured live on 2026-09-10: such swaps come back 1246-1402
            # bytes against the 1232 limit, and lowering maxAccounts or forcing direct routes just
            # loses the route entirely. Probing the quote is NOT enough to tell these apart - the
            # quote succeeds and only the build fails - so reject outright rather than accept a bet
            # we cannot fill.
            #
            # Once such a coin graduates it trades in an ordinary pool and routes fine (measured:
            # 7 of 8 graduated non-SOL coins fit, 546-1130 bytes), so this only blocks the curve
            # phase - the `graduated` branch below keeps handling them.
            raise HTTPException(
                status_code=400,
                detail="Token's bonding curve is not denominated in SOL: it cannot be bought until it graduates",
            )
        if graduated:
            # Bonding curve complete: the buyer purchases via Jupiter, else falls back to the
            # canonical PumpSwap pool. Reject only if BOTH are dead — then the purchase would be
            # abandoned and winners would get nothing.
            buyable = _is_jupiter_tradable(canonical_mint) or has_live_pumpswap_pool(
                canonical_mint,
                rpc_url=rpc_url,
                min_quote_lamports=min_pumpswap_quote_lamports or 1,
            )
            if not buyable:
                raise HTTPException(
                    status_code=400,
                    detail="Token graduated from pump.fun and has no tradable liquidity",
                )
        return canonical_mint, network_type, True, False, 0, False

    try:
        pools = _cached_dex_pools(canonical_mint)
    except DexLiquidityCheckUnavailable as exc:
        logger.warning(
            "dex mint check unavailable after retries (mint=%s). allowing at user risk. error=%s",
            canonical_mint,
            exc,
        )
        # DEX check failed due to provider availability.
        # Product policy: allow at user's risk, but mark as unverified.
        if _has_live_pumpfun_curve(canonical_mint, rpc_url):
            return canonical_mint, network_type, True, False, 0, False
        return canonical_mint, network_type, False, False, 0, True

    positive_pool_count = _count_direct_liquidity_pools(canonical_mint, pools)
    if positive_pool_count <= 0:
        # A missing pool does not only mean a dead coin: a young one is still on
        # the pump.fun curve, and there is somewhere to buy it. The buyer's
        # router looks at the curve first and sends such a coin to pump.fun
        # rather than the aggregator, so there is nothing to warn about here.
        if _has_live_pumpfun_curve(canonical_mint, rpc_url):
            return canonical_mint, network_type, True, False, 0, False
        # Product policy: allow at user's risk when mint didn't pass DEX pool check.
        return canonical_mint, network_type, False, False, 0, False
    return canonical_mint, network_type, False, True, positive_pool_count, False


def _has_live_pumpfun_curve(mint_address: str, rpc_url: str) -> bool:
    """The coin is still on the pump.fun curve and trades for SOL.

    The check goes straight to the network, so we only call it when no pool was
    found: an extra RPC on every coin check is not needed.
    """
    try:
        is_pumpfun, graduated, quote_mint = get_pumpfun_curve_info(mint_address, rpc_url=rpc_url)
    except Exception:
        logger.warning("pumpfun curve probe failed (mint=%s)", mint_address)
        return False
    return bool(is_pumpfun and not graduated and quote_mint == NATIVE_SOL_QUOTE)


def _parse_lottery_account(raw_data: bytes) -> dict[str, object]:
    if len(raw_data) < 8 + 260:
        raise RuntimeError(f"Lottery account data is too short: {len(raw_data)} bytes")

    status_map = {
        0: "Open",
        1: "PendingVrf",
        2: "ReadyToDraw",
        3: "ProceedingPurchases",
        4: "Closed",
    }

    offset = 8  # Anchor discriminator

    def take(size: int) -> bytes:
        nonlocal offset
        chunk = raw_data[offset:offset + size]
        offset += size
        return chunk

    take(32)  # admin
    take(8)   # start_ts
    take(8)   # end_ts
    take(2)   # fee_bps
    take(32)  # wallet_fee
    take(32)  # wallet_keeper
    take(8)   # min_amount
    take(8)   # max_amount
    take(8)   # max_total

    status_raw = int.from_bytes(take(1), byteorder="little", signed=False)
    take(1)   # paused
    take(8)   # deposits_count
    take(16)  # total_deposited
    weights_hash = take(32)
    vrf_requested_ts = int.from_bytes(take(8), byteorder="little", signed=True)
    vrf_seed = take(32)
    vrf_seed_hex = vrf_seed.hex() if vrf_seed != bytes(32) else None
    vrf_called = bool(int.from_bytes(take(1), byteorder="little", signed=False))
    vrf_randomness_account = str(Pubkey.from_bytes(take(32)))
    # The request seed the program derived, the slot whose hash went into it,
    # and the shares algorithm fingerprint. All three belong on the
    # verification page: without the seed and the slot the choice of randomness
    # account cannot be rechecked. Older rounds have a shorter account, so the
    # tail is read carefully.
    try:
        vrf_force = take(32)
        vrf_seed_slot = int.from_bytes(take(8), byteorder="little", signed=False)
        algorithm_hash = take(32)
    except Exception:  # noqa: BLE001
        vrf_force, vrf_seed_slot, algorithm_hash = b"", 0, b""

    return {
        "status_raw": status_raw,
        "status": status_map.get(status_raw, f"Unknown({status_raw})"),
        "vrf_called": vrf_called,
        "vrf_seed": vrf_seed_hex,
        "vrf_requested_ts": vrf_requested_ts,
        "vrf_force": vrf_force.hex() if len(vrf_force) == 32 and vrf_force != bytes(32) else None,
        "vrf_seed_slot": vrf_seed_slot or None,
        "vrf_randomness_account": vrf_randomness_account,
        "weights_hash": weights_hash.hex() if weights_hash and weights_hash != bytes(32) else None,
        "vrf_algorithm_hash": algorithm_hash.hex() if len(algorithm_hash) == 32 and algorithm_hash != bytes(32) else None,
    }


def _sol_to_lamports(value: float) -> int:
    lamports = (Decimal(str(value)) * Decimal("1000000000")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(lamports)


def _extract_transaction_log_messages(tx: object) -> list[str]:
    if tx is None:
        return []

    transaction = getattr(tx, "transaction", None)
    meta = getattr(transaction, "meta", None)
    log_messages = getattr(meta, "log_messages", None)
    if isinstance(log_messages, list):
        return [str(message) for message in log_messages]

    if isinstance(tx, dict):
        meta_dict = tx.get("meta")
        if isinstance(meta_dict, dict):
            raw_logs = meta_dict.get("logMessages") or meta_dict.get("log_messages")
            if isinstance(raw_logs, list):
                return [str(message) for message in raw_logs]

    return []


def _transaction_error(tx: object) -> object | None:
    if tx is None:
        return None

    transaction = getattr(tx, "transaction", None)
    meta = getattr(transaction, "meta", None)
    err = getattr(meta, "err", None)
    if err is not None:
        return err

    if isinstance(tx, dict):
        meta_dict = tx.get("meta")
        if isinstance(meta_dict, dict):
            return meta_dict.get("err")

    return None


async def _fetch_confirmed_deposit_event(signature: str) -> DepositEvent | None:
    try:
        parsed_signature = Signature.from_string(signature)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid transaction signature")

    async with AsyncClient(get_settings().solana_http_endpoint) as client:
        response = await client.get_transaction(
            parsed_signature,
            encoding="jsonParsed",
            commitment="confirmed",
            max_supported_transaction_version=0,
        )

    transaction_error = _transaction_error(response.value)
    if transaction_error is not None:
        raise HTTPException(status_code=400, detail=f"Transaction failed on-chain: {transaction_error}")

    logs = _extract_transaction_log_messages(response.value)
    events = decode_deposit_events_from_logs(logs)
    return events[0] if events else None


def _validate_deposit_event_matches_request(
    *,
    event: DepositEvent,
    lottery_id: int,
    canonical_mint: str,
    wallet_address: str,
    sol_amount: float,
) -> None:
    settings = get_settings()
    expected_lottery_pda, _, _ = _derive_lottery_account_summary(lottery_id, settings)
    if not expected_lottery_pda or event.lottery != expected_lottery_pda:
        raise HTTPException(status_code=400, detail="Transaction does not belong to this lottery")

    if event.mint != canonical_mint:
        raise HTTPException(status_code=400, detail="Transaction mint does not match request")

    if event.user != wallet_address.strip():
        raise HTTPException(status_code=400, detail="Transaction wallet does not match request")

    if event.amount_lamports != _sol_to_lamports(sol_amount):
        raise HTTPException(status_code=400, detail="Transaction amount does not match request")


# What ORAO takes to answer, allowing for a slow moment. Their own figure is
# under a second; this is the number the countdown is built on, not a timeout.
_ORAO_FULFILMENT_SECONDS = 5


def _expected_draw_seconds() -> int:
    """Roughly how long the draw takes: from the pool closing to the buying starting.

    Under Switchboard this was a couple of minutes, most of it a mandatory
    pause before the randomness could be revealed and two retries on top.
    ORAO has neither: the request goes out in the same transaction that closes
    the pool, the answer lands a second or so later, and what is left is the
    worker noticing and the pause before buying starts.

    The page runs a countdown on this. When it runs out the page says "any
    moment now" rather than showing a negative, so erring short is safe.
    """
    settings = get_settings()
    return int(
        settings.phase2_poll_interval_seconds * 2
        + _ORAO_FULFILMENT_SECONDS
        + settings.start_purchases_delay_seconds
    )


def _next_pool_at(proceeding_started_at: datetime | None) -> datetime | None:
    """When the next pool opens: the end of the buying window plus the "done" pause.

    Computed exactly the way the autostart worker decides it
    (`_has_active_execution_window`), so the timer on the page shows the real
    moment rather than an approximate one.
    """
    if proceeding_started_at is None:
        return None
    settings = get_settings()
    started = proceeding_started_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return started + timedelta(
        seconds=int(settings.execution_countdown_seconds) + int(settings.lottery_autostart_gap_seconds)
    )


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> int:
    user_id = jwt_handler.verify_token(credentials.credentials)
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    return user_id


def require_admin_user(
    current_user_id: int = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> int:
    user = db.query(UserModel).filter(UserModel.id == current_user_id).first()
    role = getattr(user, "role", None)
    role_value = getattr(role, "value", role)
    if user is None or role_value != UserRole.ADMIN.value:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user_id


@router.get("/current", response_model=LotteryListResponse)
async def get_current_lottery(
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    db: Session = Depends(get_db)
):
    """
    Get current created lottery entries sorted by total solana bet (descending).
    Returns a list of meme coins with their ranking, betting info, market data, and price history.
    If no created lottery exists, returns empty list.
    """
    try:
        from infrastructure.database.models.bet_participation_model import BetParticipationModel
        from sqlalchemy import func

        # Lotteries that are open for deposits right now.
        deposit_open_lotteries = await lottery_repository.get_active_lotteries()
        has_active_lottery = bool(deposit_open_lotteries)

        # Latest active-phase lottery by market, so UI can reflect phase/timer even
        # when deposits are closed and /current entries are naturally empty.
        latest_by_type: dict[str, Lottery] = {}
        latest_any_by_type: dict[str, Lottery] = {}
        tracked_statuses = {
            LotteryStatus.ID_GENERATED,
            LotteryStatus.CREATED,
            LotteryStatus.PHASE2STARTED,
            LotteryStatus.VRF_BINDED,
            LotteryStatus.VRF_FULFILLED,
            LotteryStatus.PROCEEDING_PURCHASES,
        }
        all_lotteries, _ = await lottery_repository.get_all_lotteries(skip=0, limit=200)
        for lottery in all_lotteries:
            if lottery.status == LotteryStatus.INITIALIZE_ABANDONED:
                continue
            lottery_type = lottery.lottery_type.value
            latest_any_by_type.setdefault(lottery_type, lottery)
            if lottery_type not in latest_by_type and lottery.status in tracked_statuses:
                latest_by_type[lottery_type] = lottery

        # We compute the totals for the latest pool whatever its status: while
        # the buying runs its status is already closed, but the screen still
        # needs both the pool size and the coins.
        summary_lotteries: dict[int, Lottery] = {}
        for source in (latest_by_type, latest_any_by_type):
            for lottery in source.values():
                if lottery.id is not None:
                    summary_lotteries.setdefault(int(lottery.id), lottery)
        latest_lottery_ids = list(summary_lotteries.keys())
        total_pool_by_lottery_id: dict[int, float] = {}
        if latest_lottery_ids:
            total_pool_rows = db.query(
                BetParticipationModel.lottery_id,
                func.sum(BetParticipationModel.sol_amount).label("total_pool_sol")
            ).filter(
                BetParticipationModel.lottery_id.in_(latest_lottery_ids),
                active_bet_condition(BetParticipationModel),
            ).group_by(
                BetParticipationModel.lottery_id
            ).all()
            total_pool_by_lottery_id = {
                int(lottery_id): float(total_pool_sol or 0)
                for lottery_id, total_pool_sol in total_pool_rows
            }

        active_summaries: list[ActiveLotterySummaryResponse] = []
        settings = get_settings()
        execution_countdown_seconds = settings.execution_countdown_seconds
        account_summary_by_lottery_id: dict[int, tuple[str | None, str | None, str | None]] = {}

        def get_account_summary(lottery_id: int) -> tuple[str | None, str | None, str | None]:
            if lottery_id not in account_summary_by_lottery_id:
                account_summary_by_lottery_id[lottery_id] = _derive_lottery_account_summary(
                    lottery_id,
                    settings,
                )
            return account_summary_by_lottery_id[lottery_id]

        for lottery_type in ("pumpfun", "dex"):
            lottery = latest_by_type.get(lottery_type)
            if lottery is None or lottery.id is None:
                continue
            lottery_pda, vault_pda, admin_pubkey = get_account_summary(int(lottery.id))
            active_summaries.append(
                ActiveLotterySummaryResponse(
                    id=lottery.id,
                    lottery_type=lottery.lottery_type.value,
                    status=lottery.status.value,
                    lottery_pda=lottery_pda,
                    vault_pda=vault_pda,
                    admin_pubkey=admin_pubkey,
                    created_at=lottery.created_at,
                    end_date=lottery.end_date,
                    second_phase_started_at=lottery.second_phase_started_at,
                    proceeding_purchases_started_at=lottery.proceeding_purchases_started_at,
                    execution_countdown_seconds=execution_countdown_seconds,
                    draw_seconds=_expected_draw_seconds(),
                    next_pool_at=_next_pool_at(lottery.proceeding_purchases_started_at),
                    max_total=lottery.max_total,
                    total_pool_sol=total_pool_by_lottery_id.get(lottery.id, 0.0),
                    winner_results=_build_lottery_winner_results(db, lottery),
                )
            )

        latest_summaries: list[ActiveLotterySummaryResponse] = []
        for lottery_type in ("pumpfun", "dex"):
            lottery = latest_any_by_type.get(lottery_type)
            if lottery is None or lottery.id is None:
                continue
            lottery_pda, vault_pda, admin_pubkey = get_account_summary(int(lottery.id))
            latest_summaries.append(
                ActiveLotterySummaryResponse(
                    id=lottery.id,
                    lottery_type=lottery.lottery_type.value,
                    status=lottery.status.value,
                    lottery_pda=lottery_pda,
                    vault_pda=vault_pda,
                    admin_pubkey=admin_pubkey,
                    created_at=lottery.created_at,
                    end_date=lottery.end_date,
                    second_phase_started_at=lottery.second_phase_started_at,
                    proceeding_purchases_started_at=lottery.proceeding_purchases_started_at,
                    execution_countdown_seconds=execution_countdown_seconds,
                    draw_seconds=_expected_draw_seconds(),
                    next_pool_at=_next_pool_at(lottery.proceeding_purchases_started_at),
                    max_total=lottery.max_total,
                    total_pool_sol=total_pool_by_lottery_id.get(lottery.id, 0.0),
                    winner_results=_build_lottery_winner_results(db, lottery),
                )
            )

        entry_lotteries = list(summary_lotteries.values())
        hype_countdowns: list[HypeCountdownResponse] = []
        if settings.lottery_hype_countdown_seconds > 0:
            now_utc = datetime.now(timezone.utc)
            active_types = {
                lottery.lottery_type.value
                for lottery in latest_by_type.values()
                if lottery.id is not None
            }
            for control in list_cycle_controls(db):
                launch_at = control.hype_launch_at
                if control.enabled or launch_at is None or control.lottery_type in active_types:
                    continue
                if launch_at.tzinfo is None:
                    launch_at = launch_at.replace(tzinfo=timezone.utc)
                if launch_at < now_utc:
                    launch_at = now_utc
                hype_countdowns.append(
                    HypeCountdownResponse(
                        lottery_type=control.lottery_type,
                        launch_at=launch_at,
                    )
                )

        response_entries = []
        for active_lottery in entry_lotteries:
            lottery_id = active_lottery.id
            if lottery_id is None:
                continue

            # Query real bet statistics from database, grouped by meme_coin_address
            bet_stats = db.query(
                BetParticipationModel.meme_coin_address,
                func.sum(BetParticipationModel.sol_amount).label('total_solana_bet'),
                func.count(BetParticipationModel.id).label('bet_count')
            ).filter(
                BetParticipationModel.lottery_id == lottery_id,
                active_bet_condition(BetParticipationModel),
            ).group_by(
                BetParticipationModel.meme_coin_address
            ).order_by(
                func.sum(BetParticipationModel.sol_amount).desc()
            ).all()

            for rank, (meme_coin_address, total_bet, bet_count) in enumerate(bet_stats, 1):
                coin_name, coin_symbol, coin_logo = _get_coin_metadata(db, str(meme_coin_address))

                coin_response = CoinResponse(
                    name=coin_name,
                    symbol=coin_symbol,
                    address=meme_coin_address,  # Add the token address
                    market_cap=0.0,  # No metadata available
                    current_price=0.0,  # No metadata available
                    price_history=[],  # No price history
                    volume_24h=0.0,  # No metadata available
                    logo_url=coin_logo
                )

                response_entry = LotteryEntryResponse(
                    rank=rank,
                    lottery_id=lottery_id,
                    lottery_type=active_lottery.lottery_type.value,
                    coin=coin_response,
                    total_solana_bet=float(total_bet),
                    bet_count=bet_count,
                )
                response_entries.append(response_entry)

        return LotteryListResponse(
            entries=response_entries,
            has_active_lottery=has_active_lottery,
            active_lotteries=active_summaries,
            latest_lotteries=latest_summaries,
            hype_countdowns=hype_countdowns,
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get lottery entries: {str(e)}")


@router.get("/archive", response_model=LotteryArchiveListResponse)
async def get_lottery_archive(
    lottery_type: str = Query("dex", description="Lottery type: pumpfun or dex"),
    include_empty: bool = Query(
        False,
        description="Show rounds where nobody committed anything",
    ),
    window_days: int = Query(ARCHIVE_WINDOW_DAYS, ge=1, le=365),
    db: Session = Depends(get_db),
):
    """Round history.

    Empty rounds are hidden by default. While there are few participants a round
    still opens every few hours, and without this filter the archive would be a
    list of zeros with no real round visible in it.
    """
    try:
        parsed_type = _parse_lottery_type(lottery_type)
        now_utc = datetime.now(timezone.utc)
        created_after = now_utc - timedelta(days=window_days)

        lottery_models = db.query(LotteryModel).filter(
            LotteryModel.lottery_type == parsed_type.value,
            LotteryModel.created_at >= created_after,
        ).order_by(LotteryModel.created_at.desc()).all()

        close_event_map = _build_archive_close_event_map(db, lottery_models)
        items: list[LotteryArchiveItemResponse] = []

        for lottery in lottery_models:
            ended_at, ended_at_source = _resolve_archive_ended_at(lottery, close_event_map)
            if ended_at is None or ended_at > now_utc:
                continue

            winner_results = _build_lottery_winner_results(db, lottery)
            entries = _build_lottery_archive_entries(db, lottery, winner_results)
            total_pool_sol = round(sum(item.total_solana_bet for item in entries), 8)
            if not include_empty and total_pool_sol <= 0:
                continue

            items.append(
                LotteryArchiveItemResponse(
                    id=int(lottery.id),
                    lottery_type=str(lottery.lottery_type),
                    status=str(lottery.status.value if hasattr(lottery.status, "value") else lottery.status),
                    lottery_pda=str(lottery.lottery_pda).strip() if getattr(lottery, "lottery_pda", None) else None,
                    started_at=_resolve_archive_started_at(lottery) or now_utc,
                    ended_at=ended_at,
                    ended_at_source=ended_at_source or "unknown",
                    close_reason=getattr(lottery, "close_reason", None),
                    initialize_abandoned_at=getattr(lottery, "initialize_abandoned_at", None),
                    initialize_abandoned_error=getattr(lottery, "initialize_abandoned_error", None),
                    total_pool_sol=total_pool_sol,
                    entries=entries,
                )
            )
            if len(items) >= ARCHIVE_MAX_ITEMS:
                break

        return LotteryArchiveListResponse(
            lottery_type=parsed_type.value,
            window_days=window_days,
            items=items,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("archive fetch failed (lottery_type=%s)", lottery_type)
        raise HTTPException(status_code=500, detail=f"Failed to get lottery archive: {str(e)}")


@router.get("/my/commits", response_model=MyCommitsResponse)
async def get_my_commits(
    db: Session = Depends(get_db),
    current_user_id: int = Depends(get_current_user),
):
    """My commits: where I took part, how much I put in and what came of it.

    This is the only screen where a person sees themselves. Without it they hand
    over SOL and then stare at a shared pool with no idea which part is theirs.

    What we honestly show: the commit itself with its on-chain signature, how
    much stands behind that coin in total, and how much went into buying it
    after the draw. What we do not show: how many tokens arrived — we do not
    know that, the tokens go straight to the wallet, and the truth about them is
    on Solscan, not with us.
    """
    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    bets = (
        db.query(BetParticipationModel)
        .filter(
            BetParticipationModel.user_id == current_user_id,
            active_bet_condition(BetParticipationModel),
        )
        .order_by(BetParticipationModel.lottery_id.desc(), BetParticipationModel.created_at.desc())
        .all()
    )
    if not bets:
        return MyCommitsResponse(total_sol=0.0, rounds=[])

    # Rounds run newest to oldest and we show only the recent ones: the history
    # is there as evidence, not as bookkeeping for all time.
    lottery_ids: list[int] = []
    for bet in bets:
        if bet.lottery_id not in lottery_ids:
            lottery_ids.append(int(bet.lottery_id))
    lottery_ids = lottery_ids[:MY_COMMITS_MAX_ROUNDS]

    lotteries = {
        int(row.id): row
        for row in db.query(LotteryModel).filter(LotteryModel.id.in_(lottery_ids)).all()
    }

    rounds: list[MyCommitRoundResponse] = []
    total_sol = 0.0

    for lottery_id in lottery_ids:
        lottery = lotteries.get(lottery_id)
        if lottery is None:
            continue

        mine = [bet for bet in bets if int(bet.lottery_id) == lottery_id]
        # How much everyone together stands behind each coin: without that
        # number your own share means nothing.
        pool_by_mint = {
            str(mint): float(total or 0.0)
            for mint, total in db.query(
                BetParticipationModel.meme_coin_address,
                func.sum(BetParticipationModel.sol_amount),
            )
            .filter(
                BetParticipationModel.lottery_id == lottery_id,
                active_bet_condition(BetParticipationModel),
            )
            .group_by(BetParticipationModel.meme_coin_address)
            .all()
        }
        drawn_by_mint = {
            item.mint: item.target_sol
            for item in _build_lottery_winner_results(db, lottery)
        }

        by_mint: dict[str, MyCommitCoinResponse] = {}
        for bet in mine:
            mint = str(bet.meme_coin_address)
            entry = by_mint.get(mint)
            if entry is None:
                name, ticker, logo = _get_coin_metadata(db, mint)
                entry = MyCommitCoinResponse(
                    mint=mint,
                    name=name,
                    ticker=ticker,
                    logo_url=logo,
                    my_sol=0.0,
                    my_commits=0,
                    pool_sol=round(pool_by_mint.get(mint, 0.0), 8),
                    drawn_sol=drawn_by_mint.get(mint),
                    signatures=[],
                )
                by_mint[mint] = entry
            entry.my_sol = round(entry.my_sol + float(bet.sol_amount or 0.0), 8)
            entry.my_commits += 1
            if bet.tx_signature:
                entry.signatures.append(str(bet.tx_signature))

        coins = sorted(by_mint.values(), key=lambda item: item.my_sol, reverse=True)
        my_sol = round(sum(item.my_sol for item in coins), 8)
        total_sol = round(total_sol + my_sol, 8)

        rounds.append(
            MyCommitRoundResponse(
                lottery_id=lottery_id,
                lottery_type=str(lottery.lottery_type),
                status=str(lottery.status.value if hasattr(lottery.status, "value") else lottery.status),
                created_at=lottery.created_at,
                end_date=lottery.end_date,
                my_sol=my_sol,
                pool_sol=round(sum(pool_by_mint.values()), 8),
                wallets=sorted({str(bet.wallet_address) for bet in mine if bet.wallet_address}),
                coins=coins,
            )
        )

    return MyCommitsResponse(total_sol=total_sol, rounds=rounds)


@router.get("/coin/{coin_name}", response_model=LotteryEntryResponse)
async def get_lottery_entry_by_coin(
    coin_name: str,
    lottery_service: LotteryService = Depends(get_lottery_service)
):
    """
    Get specific lottery entry by coin name.
    """
    try:
        entry = await lottery_service.get_lottery_entry_by_coin_name(coin_name)

        price_history = [
            PricePointResponse(
                timestamp=point.timestamp,
                price=point.price
            ) for point in entry.price_history
        ]

        return LotteryEntryResponse(
            rank=entry.rank,
            coin_name=entry.coin_name,
            total_solana_bet=entry.total_solana_bet,
            market_cap=entry.market_cap,
            current_price=entry.current_price,
            price_history=price_history,
            logo_url=entry.logo_url
        )

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get lottery entry: {str(e)}")


@router.post("/create", response_model=LotteryResponse, responses={
    409: {"model": ProblemDetails, "description": "Conflict - Active lottery already exists"}
})
async def create_lottery(
    request: CreateLotteryRequest,
    allow_existing: bool = Query(False),
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Create a new lottery. Requires authentication.
    Only authenticated users can create lotteries.
    """
    lottery_type = _parse_lottery_type(request.lottery_type)

    # Check if there's already an open lottery of the same type
    open_lotteries = await lottery_repository.get_open_lotteries(lottery_type=lottery_type)
    if open_lotteries:
        if allow_existing:
            return _to_lottery_response(open_lotteries[0])
        problem = ProblemDetails(
            type="https://example.com/problems/open-lottery-for-type-exists",
            title="Open Lottery For Type Already Exists",
            status=409,
            detail=f"Cannot create a new {lottery_type.value} lottery. An open lottery of this type already exists.",
            instance="/lottery/create"
        )
        return JSONResponse(
            status_code=409,
            content=problem.model_dump(),
            media_type="application/problem+json"
        )

    try:

        lottery = Lottery(
            id=None,
            name=request.name,
            lottery_type=lottery_type,
            created_by_user_id=current_user_id,
            created_at=datetime.now(),
            end_date=request.end_date,
            max_total=request.max_total,
            status=LotteryStatus.ID_GENERATED
        )

        created_lottery = await lottery_repository.create_lottery(lottery)

        return _to_lottery_response(created_lottery)

    except ValueError as e:
        if "Open lottery already exists" in str(e):
            if allow_existing:
                open_lotteries = await lottery_repository.get_open_lotteries(lottery_type=lottery_type)
                if open_lotteries:
                    return _to_lottery_response(open_lotteries[0])
            problem = ProblemDetails(
                type="https://example.com/problems/open-lottery-for-type-exists",
                title="Open Lottery For Type Already Exists",
                status=409,
                detail=f"Cannot create a new {lottery_type.value} lottery. An open lottery of this type already exists.",
                instance="/lottery/create"
            )
            return JSONResponse(
                status_code=409,
                content=problem.model_dump(),
                media_type="application/problem+json"
            )
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create lottery: {str(e)}")


@router.get("/all", response_model=PagedLotteryResponse)
async def get_all_lotteries(
    page_index: int = Query(0, ge=0),
    page_size: int = Query(10, ge=1, le=100),
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Get all lotteries with pagination. Requires authentication.
    """
    try:
        skip = page_index * page_size
        lotteries, total_count = await lottery_repository.get_all_lotteries(skip=skip, limit=page_size)

        lottery_responses = [_to_lottery_response(lottery) for lottery in lotteries]

        return PagedLotteryResponse(items=lottery_responses, total_count=total_count)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get lotteries: {str(e)}")


def _to_cycle_control_response(control) -> LotteryCycleControlResponse:
    return LotteryCycleControlResponse(
        lottery_type=control.lottery_type,
        enabled=control.enabled,
        stop_requested_at=control.stop_requested_at,
        hype_launch_at=control.hype_launch_at,
        updated_at=control.updated_at,
    )


@router.get("/cycles", response_model=LotteryCycleControlsResponse)
async def get_lottery_cycles(
    db: Session = Depends(get_db),
    _: int = Depends(require_admin_user),
):
    return LotteryCycleControlsResponse(
        items=[_to_cycle_control_response(control) for control in list_cycle_controls(db)]
    )


@router.post("/cycles/{lottery_type}/stop", response_model=LotteryCycleControlResponse)
async def stop_lottery_cycle(
    lottery_type: str,
    db: Session = Depends(get_db),
    _: int = Depends(require_admin_user),
):
    try:
        normalized_type = normalize_lottery_type(lottery_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_cycle_control_response(set_cycle_enabled(db, normalized_type, False))


@router.post("/cycles/{lottery_type}/resume", response_model=LotteryCycleControlResponse)
async def resume_lottery_cycle(
    lottery_type: str,
    db: Session = Depends(get_db),
    _: int = Depends(require_admin_user),
):
    try:
        normalized_type = normalize_lottery_type(lottery_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _to_cycle_control_response(set_cycle_enabled(db, normalized_type, True))


@router.get("/{lottery_id}/verification", response_model=LotteryVerificationResponse)
def get_lottery_verification(lottery_id: int, db: Session = Depends(get_db)):
    """
    Everything a round can be checked by from the outside.

    Deliberately open with no sign-in: verification is pointless if it requires
    an account with the very people being verified. The script in the public
    repository reads from here too, so the format is machine readable and stable.

    What we return:

    * the weights commitment written into the program BEFORE the draw, and its
      preimage — the exact string sha256 was taken over. Anyone can recompute
      the hash, and we compare it ourselves so nobody has to take our word;
    * where the randomness came from. `vrf` means the oracle revealed it,
      `emergency` means the round was drawn with the admin's emergency seed. The
      second must not be hidden: it is the only case where we rolled the dice
      ourselves;
    * the fingerprint of the shares algorithm stored in the round, and the path
      to the file it is computed from.
    """
    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    lottery = db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        raise HTTPException(status_code=404, detail="Lottery not found")

    settings = get_settings()
    lottery_pda, vault_pda, admin_pubkey = _derive_lottery_account_summary(int(lottery_id), settings)

    # The commitment preimage is built from the same commits and by the same
    # rule the worker used when it put the hash into the program.
    rows = (
        db.query(
            BetParticipationModel.meme_coin_address,
            func.sum(BetParticipationModel.sol_amount).label("total_sol"),
        )
        .filter(BetParticipationModel.lottery_id == lottery_id)
        .filter(active_bet_condition(BetParticipationModel))
        .group_by(BetParticipationModel.meme_coin_address)
        .all()
    )
    commitment = build_weights_commitment([(str(mint), Decimal(str(total))) for mint, total in rows])
    weights_payload = commitment[0] if commitment else None
    weights_recomputed = commitment[1] if commitment else None

    onchain: dict[str, object] = {}
    if lottery_pda:
        try:
            client = Client(settings.solana_http_endpoint.strip())
            response = client.get_account_info(Pubkey.from_string(lottery_pda))
            value = getattr(response, "value", None)
            if value is not None and getattr(value, "data", None):
                onchain = _parse_lottery_account(bytes(value.data))
        except Exception:  # noqa: BLE001
            # The network is unreachable, so we return what the database knows.
            # A verifier will go to the network themselves anyway, they have the
            # pool address.
            logger.warning("verification: on-chain read failed (lottery_id=%s)", lottery_id)

    weights_onchain = onchain.get("weights_hash") if onchain else None
    seed = onchain.get("vrf_seed") if onchain else None
    seed = seed or (lottery.vrf_seed or None)

    if not seed:
        source = "pending"
    elif getattr(lottery, "is_offchain_vrf", False):
        source = "emergency"
    else:
        source = "vrf"

    network = "devnet" if "devnet" in (settings.solana_http_endpoint or "") else "mainnet"

    return LotteryVerificationResponse(
        lottery_id=int(lottery_id),
        lottery_type=lottery.lottery_type.value if hasattr(lottery.lottery_type, "value") else str(lottery.lottery_type),
        status=lottery.status.value if hasattr(lottery.status, "value") else str(lottery.status),
        network=network,
        program_id=str(settings.lottery_program_id or "") or None,
        lottery_account=lottery_pda,
        vault_account=vault_pda,
        admin_account=admin_pubkey,
        weights_hash_onchain=weights_onchain,
        weights_payload=weights_payload,
        weights_hash_recomputed=weights_recomputed,
        weights_match=(
            bool(weights_onchain and weights_recomputed and weights_onchain == weights_recomputed)
            if weights_onchain or weights_recomputed
            else None
        ),
        randomness_source=source,
        randomness_account=onchain.get("vrf_randomness_account") if onchain else None,
        vrf_seed=seed,
        vrf_algorithm_hash=onchain.get("vrf_algorithm_hash") if onchain else None,
        winner_results=_build_lottery_winner_results(db, lottery),
    )


@router.get("/{lottery_id}", response_model=LotteryResponse)
async def get_lottery_by_id(
    lottery_id: int,
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    current_user_id: int = Depends(require_admin_user),
    request: Request = None,
):
    """
    Get lottery by ID. Requires authentication.
    """
    try:
        logger.info(
            "lottery.get_by_id started (lottery_id=%s, user_id=%s, client=%s)",
            lottery_id,
            current_user_id,
            request.client.host if request and request.client else None,
        )
        lottery = await lottery_repository.get_lottery_by_id(lottery_id)

        if not lottery:
            raise HTTPException(status_code=404, detail="Lottery not found")

        logger.info(
            "lottery.get_by_id succeeded (lottery_id=%s, status=%s, randomness_account=%s, second_phase_started_at=%s)",
            lottery_id,
            lottery.status.value,
            lottery.randomness_account,
            lottery.second_phase_started_at,
        )
        return _to_lottery_response(lottery)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get lottery: {str(e)}")


@router.post("/{lottery_id}/close", response_model=LotteryResponse)
async def close_lottery(
    lottery_id: int,
    lottery_service: LotteryService = Depends(get_lottery_service),
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Close a lottery by setting its status to CLOSED.
    """
    try:
        existing_lottery = await lottery_repository.get_lottery_by_id(lottery_id)
        if not existing_lottery:
            raise HTTPException(status_code=404, detail="Lottery not found")

        if existing_lottery.status != LotteryStatus.CLOSED and existing_lottery.randomness_account:
            # The ORAO request account stays where it is. It is theirs, it
            # cannot be closed, and it is the round's proof: the seed and the
            # value that came back stay readable for as long as the chain does.
            await lottery_repository.update_lottery_randomness_account(lottery_id, None)

        lottery = await lottery_service.close_lottery(lottery_id)
        return _to_lottery_response(lottery)
    except HTTPException:
        raise
    except ValueError as e:
        message = str(e)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to close lottery: {str(e)}")


@router.post("/{lottery_id}/phase2started", response_model=LotteryResponse)
async def mark_phase2_started(
    lottery_id: int,
    lottery_service: LotteryService = Depends(get_lottery_service),
    current_user_id: int = Depends(require_admin_user),
    request: Request = None,
):
    """
    Mark lottery as Phase II started. Requires authentication.
    """
    try:
        logger.info(
            "phase2started started (lottery_id=%s, user_id=%s, client=%s)",
            lottery_id,
            current_user_id,
            request.client.host if request and request.client else None,
        )
        lottery = await lottery_service.mark_phase2_started(lottery_id)
        # The randomness was asked for in the same transaction that closed the
        # round, so there is nothing to request here. The account is recorded
        # for the verification page, and a round can be marked started before
        # the event that carries it has been read.
        randomness_account = lottery.randomness_account
        logger.info(
            "phase2started succeeded (lottery_id=%s, status=%s, randomness_account=%s, second_phase_started_at=%s)",
            lottery_id,
            lottery.status.value,
            lottery.randomness_account,
            lottery.second_phase_started_at,
        )
        return _to_lottery_response(lottery)
    except ValueError as e:
        message = str(e)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update lottery status: {str(e)}")


@router.post("/{lottery_id}/vrf-fulfilled", response_model=LotteryResponse)
async def mark_vrf_fulfilled(
    lottery_id: int,
    lottery_service: LotteryService = Depends(get_lottery_service),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Mark lottery as vrf_fulfilled. Requires authentication.
    """
    try:
        logger.info("vrf-fulfilled started (lottery_id=%s)", lottery_id)
        lottery = await lottery_service.mark_vrf_fulfilled(lottery_id)
        logger.info(
            "vrf-fulfilled succeeded (lottery_id=%s, status=%s, randomness_account=%s)",
            lottery_id,
            lottery.status.value,
            lottery.randomness_account,
        )
        return _to_lottery_response(lottery)
    except ValueError as e:
        message = str(e)
        logger.warning("vrf-fulfilled validation failed (lottery_id=%s, error=%s)", lottery_id, message)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=message)
    except Exception as e:
        logger.exception("vrf-fulfilled failed (lottery_id=%s)", lottery_id)
        raise HTTPException(status_code=500, detail=f"Failed to update lottery status: {str(e)}")


@router.post("/{lottery_id}/offchain-vrf", response_model=LotteryResponse)
async def mark_offchain_vrf(
    lottery_id: int,
    payload: OffchainVrfRequest,
    lottery_service: LotteryService = Depends(get_lottery_service),
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    current_user_id: int = Depends(require_admin_user),
):
    del current_user_id
    try:
        lottery = await lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            raise HTTPException(status_code=404, detail="Lottery not found")

        # Keep backend status progression consistent with bind/fulfill flow.
        if lottery.status == LotteryStatus.PHASE2STARTED:
            lottery = await lottery_service.mark_vrf_binded(lottery_id)
        if lottery.status == LotteryStatus.VRF_BINDED:
            lottery = await lottery_service.mark_vrf_fulfilled(lottery_id)

        lottery = await lottery_repository.update_lottery_offchain_vrf(lottery_id, True)
        if not lottery:
            raise HTTPException(status_code=404, detail="Lottery not found")

        offchain_seed_hex = (payload.seed_hex or "").strip().lower()
        if offchain_seed_hex:
            if len(offchain_seed_hex) != 64:
                raise HTTPException(status_code=400, detail="seed_hex must be a 64-char hex string")
            try:
                seed_bytes = bytes.fromhex(offchain_seed_hex)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="seed_hex must be valid hex") from exc
            if seed_bytes == bytes(32):
                raise HTTPException(status_code=400, detail="seed_hex must be non-zero")
        else:
            # Generate an offchain seed that resembles a large 256-bit on-chain value.
            seed_bytes = bytearray(secrets.token_bytes(32))
            seed_bytes[0] |= 0xF0
            offchain_seed_hex = bytes(seed_bytes).hex()

        lottery = await lottery_repository.update_lottery_vrf_seed(lottery_id, offchain_seed_hex)
        if not lottery:
            raise HTTPException(status_code=404, detail="Lottery not found")

        return _to_lottery_response(lottery)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update lottery offchain VRF flag: {str(e)}")


@router.get("/{lottery_id}/phase2-accounts", response_model=Phase2AccountsResponse)
def phase2_accounts(
    lottery_id: int,
    db: Session = Depends(get_db),
    current_user_id: int = Depends(require_admin_user),
):
    """The account list for signing `start_second_phase` from the admin area.

    The request seed comes from the round's address, the weights commitment and
    the hash of a recent slot. All three are worked out here so the derivation
    stays in one language: the program has a copy and the worker has a copy,
    and a third one in the browser would be a third chance for them to drift.

    The slot goes stale. The program refuses anything older than 128 slots,
    roughly a minute, which is long enough to sign and send and short enough
    that the hash cannot be picked out of history.
    """
    from shared import orao_vrf
    from infrastructure.database.models.bet_participation_model import BetParticipationModel

    lottery = db.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        raise HTTPException(status_code=404, detail="Lottery not found")

    settings = get_settings()
    lottery_pda, _vault_pda, _admin = _derive_lottery_account_summary(int(lottery_id), settings)
    if not lottery_pda:
        raise HTTPException(status_code=409, detail="Lottery PDA could not be derived")

    rows = (
        db.query(
            BetParticipationModel.meme_coin_address,
            func.sum(BetParticipationModel.sol_amount).label("total_sol"),
        )
        .filter(BetParticipationModel.lottery_id == lottery_id)
        .filter(active_bet_condition(BetParticipationModel))
        .group_by(BetParticipationModel.meme_coin_address)
        .all()
    )
    commitment = build_weights_commitment([(str(mint), Decimal(str(total))) for mint, total in rows])
    if not commitment:
        raise HTTPException(status_code=409, detail="The round has no commits, so there is nothing to draw")
    weights_hash = bytes.fromhex(commitment[1])

    try:
        client = Client(settings.solana_http_endpoint.strip())
        sysvar = client.get_account_info(orao_vrf.SLOT_HASHES_SYSVAR)
        entry = orao_vrf.parse_slot_hashes(bytes(sysvar.value.data), back=2)
        network = client.get_account_info(orao_vrf.network_state_address())
        treasury = orao_vrf.parse_treasury(bytes(network.value.data))
    except Exception as exc:  # noqa: BLE001
        logger.exception("phase2-accounts: on-chain read failed (lottery_id=%s)", lottery_id)
        raise HTTPException(status_code=503, detail=f"Could not read the chain: {exc}")

    force = orao_vrf.derive_force(Pubkey.from_string(lottery_pda), weights_hash, entry.hash)

    return Phase2AccountsResponse(
        lottery_pda=lottery_pda,
        weights_hash=weights_hash.hex(),
        seed_slot=entry.slot,
        vrf_request=str(orao_vrf.request_address(force)),
        vrf_network_state=str(orao_vrf.network_state_address()),
        vrf_treasury=str(treasury),
        vrf_program=str(orao_vrf.ORAO_PROGRAM_ID),
        recent_slothashes=str(orao_vrf.SLOT_HASHES_SYSVAR),
    )


# TODO: Remove this method; it should not be called as a separate frontend step.
@router.post("/{lottery_id}/proceeding-purchases", response_model=LotteryResponse)
async def mark_proceeding_purchases(
    lottery_id: int,
    lottery_service: LotteryService = Depends(get_lottery_service),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Mark lottery as proceeding purchases. Requires authentication.
    """
    try:
        lottery = await lottery_service.mark_proceeding_purchases(lottery_id)
        return _to_lottery_response(lottery)
    except ValueError as e:
        message = str(e)
        if "not found" in message.lower():
            raise HTTPException(status_code=404, detail=message)
        raise HTTPException(status_code=400, detail=message)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update lottery status: {str(e)}")


@router.get("/{lottery_id}/vrf-preview", response_model=VrfPreviewResponse)
async def vrf_preview(
    lottery_id: int,
    db: Session = Depends(get_db),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Return a deterministic VRF preview using actual bets for the lottery.
    """
    try:
        weights = _collect_lottery_weights(db, lottery_id)
        result = VrfEngine.run(weights)
        return VrfPreviewResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to compute VRF preview: {str(e)}")


@router.get("/{lottery_id}/run-purchases-payload", response_model=RunPurchasesPayload)
async def run_purchases_payload_preview(
    lottery_id: int,
    db: Session = Depends(get_db),
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    current_user_id: int = Depends(require_admin_user),
):
    del current_user_id
    try:
        lottery = await lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            raise HTTPException(status_code=404, detail="Lottery not found")
        payload = _build_run_purchases_payload(db, lottery)
        return payload  # type: ignore[return-value]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build run-purchases payload: {str(e)}")


@router.post("/{lottery_id}/run-purchases", response_model=RunPurchasesResponse)
async def run_purchases(
    lottery_id: int,
    db: Session = Depends(get_db),
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    offchain_client: OffchainApiClient = Depends(get_offchain_api_client),
    current_user_id: int = Depends(require_admin_user),
):
    del current_user_id
    try:
        logger.info("run-purchases started (lottery_id=%s)", lottery_id)
        lottery = await lottery_repository.get_lottery_by_id(lottery_id)
        if not lottery:
            logger.warning("run-purchases lottery not found (lottery_id=%s)", lottery_id)
            raise HTTPException(status_code=404, detail="Lottery not found")

        if lottery.status != LotteryStatus.PROCEEDING_PURCHASES:
            logger.warning(
                "run-purchases invalid status (lottery_id=%s, status=%s)",
                lottery_id,
                lottery.status.value,
            )
            raise HTTPException(
                status_code=400,
                detail="Lottery must be in proceeding_purchases status before running purchases",
            )

        payload = _build_run_purchases_payload(db, lottery)

        logger.info(
            "run-purchases payload built (lottery_id=%s, token_count=%s)",
            lottery_id,
            len(payload.get("tokens", [])),
        )
        offchain_response = offchain_client.execute_lottery(payload)
        logger.info("run-purchases offchain accepted (lottery_id=%s)", lottery_id)
        return RunPurchasesResponse(
            lottery_id=lottery_id,
            payload=payload,  # type: ignore[arg-type]
            offchain_response=offchain_response,
        )
    except HTTPException:
        raise
    except RuntimeError as e:
        logger.exception("run-purchases runtime error (lottery_id=%s)", lottery_id)
        message = str(e)
        if "not configured" in message.lower():
            raise HTTPException(status_code=503, detail=message)
        raise HTTPException(status_code=500, detail=f"Failed to run purchases: {message}")
    except Exception as e:
        logger.exception("run-purchases failed (lottery_id=%s)", lottery_id)
        raise HTTPException(status_code=500, detail=f"Failed to run purchases: {str(e)}")


@router.post("/bet", response_model=BetParticipationResponse)
async def place_bet(
    request: CreateBetRequest,
    lottery_repository: LotteryRepository = Depends(get_lottery_repository),
    db: Session = Depends(get_db),
    current_user_id: int = Depends(get_current_user)
):
    """
    Place a bet on a meme coin in the current created lottery. Requires authentication.
    """
    try:
        # Import here to avoid circular dependencies
        from infrastructure.database.models.bet_participation_model import BetParticipationModel

        # Resolve target lottery. Explicit lottery_id is preferred for multi-type lotteries.
        current_lottery = None
        if request.lottery_id is not None:
            current_lottery = await lottery_repository.get_lottery_by_id(int(request.lottery_id))
            if not current_lottery:
                raise HTTPException(status_code=404, detail="Lottery not found")
        else:
            active_lotteries = await lottery_repository.get_active_lotteries()
            if request.lottery_type:
                requested_type = _parse_lottery_type(request.lottery_type)
                active_lotteries = [lottery for lottery in active_lotteries if lottery.lottery_type == requested_type]
            if not active_lotteries:
                raise HTTPException(status_code=400, detail="No active lottery available")
            current_lottery = active_lotteries[0]

        if current_lottery.status != LotteryStatus.CREATED:
            raise HTTPException(status_code=400, detail="Lottery is not accepting bets")
        if current_lottery.end_date is not None:
            end_date = current_lottery.end_date
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > end_date:
                raise HTTPException(status_code=400, detail="Betting period has ended for current lottery")

        # Validate input
        if request.sol_amount <= 0:
            raise HTTPException(status_code=400, detail="SOL amount must be greater than 0")

        if not request.meme_coin_address or not request.meme_coin_address.strip():
            raise HTTPException(status_code=400, detail="Meme coin address is required")

        if not request.wallet_address or not request.wallet_address.strip():
            raise HTTPException(status_code=400, detail="Wallet address is required")

        if not request.tx_signature or not request.tx_signature.strip():
            raise HTTPException(status_code=400, detail="Transaction signature is required")

        canonical_mint, _, _, _, _, _ = _validate_mint_by_lottery_type(
            request.meme_coin_address,
            current_lottery.lottery_type,
            min_pumpswap_quote_lamports=_sol_to_lamports(request.sol_amount),
        )

        existing_bet = db.query(BetParticipationModel).filter(
            BetParticipationModel.tx_signature == request.tx_signature.strip()
        ).first()
        if existing_bet:
            if is_orphaned_bet(getattr(existing_bet, "confirmation_status", None)):
                raise HTTPException(status_code=409, detail="Transaction was not finalized and is not eligible")
            return BetParticipationResponse(
                id=existing_bet.id,
                user_id=existing_bet.user_id,
                lottery_id=existing_bet.lottery_id,
                meme_coin_address=existing_bet.meme_coin_address,
                sol_amount=existing_bet.sol_amount,
                wallet_address=existing_bet.wallet_address,
                tx_signature=existing_bet.tx_signature,
                created_at=existing_bet.created_at
            )

        try:
            deposit_event = await _fetch_confirmed_deposit_event(request.tx_signature.strip())
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("failed to verify bet transaction (signature=%s)", request.tx_signature.strip())
            raise HTTPException(status_code=503, detail=f"Failed to verify transaction: {str(exc)}")

        if deposit_event is None:
            raise HTTPException(status_code=400, detail="Transaction is not a confirmed QRES deposit")

        _validate_deposit_event_matches_request(
            event=deposit_event,
            lottery_id=int(current_lottery.id),
            canonical_mint=canonical_mint,
            wallet_address=request.wallet_address,
            sol_amount=request.sol_amount,
        )

        bet_time = None
        try:
            bet_time = datetime.fromtimestamp(int(deposit_event.ts), tz=timezone.utc)
        except Exception:
            bet_time = datetime.now(timezone.utc)

        # A commit belongs to the wallet's owner, not to whoever managed to
        # record it: otherwise the same deposit would get different owners from
        # the browser and from the events worker. An unclaimed wallet is
        # attached to whoever is signed in now: they just signed the deposit
        # with that wallet. A sign-in signature overrides the link later.
        wallet_address = request.wallet_address.strip()
        owner_id = find_wallet_owner_id(db, wallet_address)
        if owner_id is None:
            link_wallet(db, user_id=current_user_id, address=wallet_address, linked_via=LINKED_VIA_DEPOSIT)
            owner_id = find_wallet_owner_id(db, wallet_address) or current_user_id

        # Create bet participation
        bet_participation = BetParticipationModel(
            user_id=owner_id,
            lottery_id=current_lottery.id,
            meme_coin_address=canonical_mint,
            sol_amount=request.sol_amount,
            wallet_address=wallet_address,
            tx_signature=request.tx_signature.strip(),
            confirmation_status=BET_STATUS_CONFIRMED,
            confirmed_at=datetime.now(timezone.utc),
            created_at=bet_time,
        )

        db.add(bet_participation)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing_bet = db.query(BetParticipationModel).filter(
                BetParticipationModel.tx_signature == request.tx_signature.strip()
            ).first()
            if existing_bet:
                if is_orphaned_bet(getattr(existing_bet, "confirmation_status", None)):
                    raise HTTPException(status_code=409, detail="Transaction was not finalized and is not eligible")
                return BetParticipationResponse(
                    id=existing_bet.id,
                    user_id=existing_bet.user_id,
                    lottery_id=existing_bet.lottery_id,
                    meme_coin_address=existing_bet.meme_coin_address,
                    sol_amount=existing_bet.sol_amount,
                    wallet_address=existing_bet.wallet_address,
                    tx_signature=existing_bet.tx_signature,
                    created_at=existing_bet.created_at
                )
            raise
        db.refresh(bet_participation)

        try:
            has_persisted_metadata = db.query(TokenMetadataModel).filter(
                TokenMetadataModel.mint == canonical_mint
            ).first() is not None
            if canonical_mint not in TOKEN_METADATA and not has_persisted_metadata:
                token_metadata = _fetch_token_metadata(canonical_mint)
                if any(token_metadata.values()):
                    _persist_helius_metadata(db, canonical_mint, token_metadata, commit=True)
                    token_metadata_queue.forget(canonical_mint)
        except Exception:
            db.rollback()
            logger.exception(
                "token metadata update failed after bet (lottery_id=%s, mint=%s)",
                current_lottery.id,
                canonical_mint,
            )

        return BetParticipationResponse(
            id=bet_participation.id,
            user_id=bet_participation.user_id,
            lottery_id=bet_participation.lottery_id,
            meme_coin_address=bet_participation.meme_coin_address,
            sol_amount=bet_participation.sol_amount,
            wallet_address=bet_participation.wallet_address,
            tx_signature=bet_participation.tx_signature,
            created_at=bet_participation.created_at
        )

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to place bet: {str(e)}")


@router.post("/check-mint", response_model=MintAllowTokenResponse)
async def check_mint(
    request: MintAllowTokenRequest,
    db: Session = Depends(get_db),
    current_user_id: int = Depends(get_current_user),
):
    del current_user_id
    try:
        lottery_type = _parse_lottery_type(request.lottery_type)
        canonical_mint, network_type, is_pumpfun, has_dex_liquidity, dex_pool_count, dex_check_unverified = _validate_mint_by_lottery_type(
            request.mint_address,
            lottery_type,
        )
        existing_allowed = db.query(AllowedMintModel).filter(
            AllowedMintModel.mint == canonical_mint,
            AllowedMintModel.network_type == network_type,
        ).first()
        if existing_allowed is None:
            db.add(
                AllowedMintModel(
                    mint=canonical_mint,
                    network_type=network_type,
                )
            )
            db.commit()

        existing_metadata = db.query(TokenMetadataModel).filter(
            TokenMetadataModel.mint == canonical_mint
        ).first()
        if existing_metadata and (existing_metadata.name or existing_metadata.symbol or existing_metadata.logo_url):
            token_metadata = {
                "token_name": existing_metadata.name,
                "token_symbol": existing_metadata.symbol,
                "token_image_url": existing_metadata.logo_url,
            }
        else:
                token_metadata = _fetch_token_metadata(canonical_mint)

        if any(token_metadata.values()):
            try:
                _persist_helius_metadata(db, canonical_mint, token_metadata, commit=True)
            except Exception:
                db.rollback()
                logger.exception("failed to persist checked mint metadata (mint=%s)", canonical_mint)

        market: dict[str, object] = {}
        if lottery_type != LotteryType.PUMPFUN:
            try:
                market = _dex_market_info(canonical_mint, _cached_dex_pools(canonical_mint))
            except Exception:
                # The market card is a nice extra, not a condition of a commit.
                logger.warning("market info unavailable (mint=%s)", canonical_mint)

        return MintAllowTokenResponse(
            mint_address=canonical_mint,
            is_pumpfun_mint=is_pumpfun,
            has_dex_liquidity=has_dex_liquidity,
            dex_liquidity_pool_count=dex_pool_count,
            dex_liquidity_check_unverified=dex_check_unverified,
            network_type=network_type.value,
            **token_metadata,
            **market,
        )
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        response = getattr(e, "response", None)
        http_status = getattr(e, "code", None) or getattr(response, "status_code", None) or getattr(response, "status", None)
        http_body = (response.text if response is not None and getattr(response, "text", None) is not None else None)
        if http_body is None and isinstance(e, urllib_error.HTTPError):
            try:
                http_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                http_body = None
        logger.exception("check-mint failed: status=%s body=%s", http_status, http_body)
        raise HTTPException(status_code=500, detail=f"Failed to check mint: {str(e)}")


@router.get("/coin/{mint}/chart", response_model=CoinChartResponse)
async def get_coin_chart(mint: str):
    """The coin's price over the last few minutes, for the hover tooltip.

    Public and deliberately cheap: the source's answer sits in a shared cache,
    our own counter keeps us under its limit, and a failure turns into "no
    chart". The coin may be brand new, in which case there will be two or three
    points, and the interface says so.
    """
    canonical = (mint or "").strip()
    if not canonical or len(canonical) > 64:
        raise HTTPException(status_code=400, detail="Invalid mint")

    settings = get_settings()
    pool_address: str | None = None
    venue: str | None = None
    price_usd: float | None = None
    change_pct: float | None = None
    try:
        pools = _cached_dex_pools(canonical)
        pair = _best_dex_pair(canonical, pools)
        if pair:
            pool_address = str(pair.get("pairAddress") or "").strip() or None
            venue = str(pair.get("dexId") or "").strip() or None
            price_usd = _to_float(pair.get("priceUsd")) or None
            price_change = pair.get("priceChange")
            if isinstance(price_change, dict) and price_change.get("h24") is not None:
                change_pct = _to_float(price_change.get("h24"))
    except Exception:
        logger.info("coin chart: pools unavailable (mint=%s)", canonical)

    chart = coin_chart(
        canonical,
        pool_address,
        venue,
        timeout_seconds=settings.external_lookup_timeout_seconds,
    )

    return CoinChartResponse(
        mint=canonical,
        available=chart.available,
        points=[CoinChartPointResponse(t=point[0], p=point[1]) for point in chart.points],
        minutes=chart.minutes,
        venue=chart.venue or venue,
        price_usd=price_usd,
        change_pct=change_pct,
    )


@router.get("/{lottery_id}/purchases", response_model=PurchaseFeedResponse)
async def get_lottery_purchases(lottery_id: int, db: Session = Depends(get_db)):
    """What has been bought for this round and in which transactions.

    A public endpoint: everything here is on chain anyway, and for a participant
    it is the only proof that the buying is running. The buyer's answer is
    cached for a few seconds: people watch the pool page at the same time, and
    it reads its state from disk.
    """
    payload = _cached_purchase_feed(lottery_id)
    if payload is None:
        return PurchaseFeedResponse(lottery_id=lottery_id, available=False)

    totals = payload.get("totals") or {}
    tokens = payload.get("tokens") or []
    purchases = payload.get("purchases") or []

    coins: list[PurchaseFeedCoinResponse] = []
    for token in tokens:
        mint = str(token.get("mint") or "")
        if not mint:
            continue
        name, symbol, logo_url = _get_coin_metadata(db, mint)
        coins.append(
            PurchaseFeedCoinResponse(
                mint=mint,
                name=name,
                symbol=symbol,
                logo_url=logo_url or None,
                target_sol=float(token.get("targetSol") or 0.0),
                bought_sol=float(token.get("spentSol") or 0.0),
                completed_purchases=int(token.get("completedPurchases") or 0),
                planned_purchases=int(token.get("plannedPurchases") or 0),
                status=str(token.get("status") or "pending"),
            )
        )

    metadata_by_mint = {coin.mint: coin for coin in coins}
    items: list[PurchaseFeedItemResponse] = []
    for purchase in purchases:
        mint = str(purchase.get("mint") or "")
        signature = str(purchase.get("signature") or "")
        if not mint or not signature:
            continue
        coin = metadata_by_mint.get(mint)
        name, symbol, logo_url = (
            (coin.name, coin.symbol, coin.logo_url) if coin else _get_coin_metadata(db, mint)
        )
        items.append(
            PurchaseFeedItemResponse(
                mint=mint,
                name=name,
                symbol=symbol,
                logo_url=logo_url or None,
                sol_amount=float(purchase.get("solAmount") or 0.0),
                signature=signature,
                venue=str(purchase.get("venue")) if purchase.get("venue") else None,
                at=_purchase_time(purchase.get("at")),
            )
        )

    summary = payload.get("summary") or {}
    return PurchaseFeedResponse(
        lottery_id=lottery_id,
        available=True,
        target_sol=float(totals.get("targetSol") or 0.0),
        bought_sol=float(totals.get("spentSol") or 0.0),
        completed_purchases=int(totals.get("completedPurchases") or 0),
        planned_purchases=int(totals.get("plannedPurchases") or 0),
        finished=summary.get("finishedAt") is not None,
        coins=coins,
        purchases=items,
    )


@router.get("/{lottery_id}/bets", response_model=list[BetParticipationResponse])
async def get_lottery_bets(
    lottery_id: int,
    db: Session = Depends(get_db),
    current_user_id: int = Depends(require_admin_user)
):
    """
    Get all bets for a specific lottery. Requires authentication.
    """
    try:
        from infrastructure.database.models.bet_participation_model import BetParticipationModel

        bets = db.query(BetParticipationModel).filter(
            BetParticipationModel.lottery_id == lottery_id,
            active_bet_condition(BetParticipationModel),
        ).order_by(BetParticipationModel.created_at.desc()).all()

        return [
            BetParticipationResponse(
                id=bet.id,
                user_id=bet.user_id,
                lottery_id=bet.lottery_id,
                meme_coin_address=bet.meme_coin_address,
                sol_amount=bet.sol_amount,
                wallet_address=bet.wallet_address,
                tx_signature=getattr(bet, "tx_signature", None),
                created_at=bet.created_at
            )
            for bet in bets
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get bets: {str(e)}")
