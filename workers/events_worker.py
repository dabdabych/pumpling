import asyncio
import base64
import enum
import hashlib
import json
import logging
import os
import signal
import socket
import ssl
import sys
from datetime import datetime, timezone
from dataclasses import asdict
from contextlib import suppress
from pathlib import Path
from typing import Any, Dict, List, Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_BACKEND_DIR = _PROJECT_ROOT / "webapp" / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from anchorpy import EventParser, Idl
from anchorpy.coder.coder import Coder
from solders.pubkey import Pubkey
from solders.rpc.config import RpcTransactionLogsFilterMentions
from solana.rpc.websocket_api import connect
import certifi

from database.database import SessionLocal
from database.models.smart_contract_event_model import SmartContractEventModel
from database.models.user_model import UserModel, UserRole  # noqa: F401 - ensures users table is registered
from database.models.bet_participation_model import BetParticipationModel
from sqlalchemy.exc import IntegrityError
from database.models.lottery_model import LotteryModel, LotteryStatus
from shared.bet_confirmation import BET_STATUS_CONFIRMED
from shared.deposit_event_decoder import DEPOSIT_EVENT_DISCRIMINATOR, decode_deposit_event
from shared.solana_rpc import SolanaJsonRpc, signature_failed
from shared.wallet_owner import resolve_wallet_owner_id

_PROGRAM_ID: Optional[Pubkey] = None
_LOTTERY_PUBKEY_CACHE: Dict[str, int] = {}
_EVENT_DISCRIMINATOR_LEN = 8
_EVENT_DISCRIMINATORS: Dict[str, bytes] = {
    "PhaseChanged": hashlib.sha256(b"event:PhaseChanged").digest()[:_EVENT_DISCRIMINATOR_LEN],
}

def _resolve_idl_path() -> Path:
    here = Path(__file__).resolve()
    local_idl = here.parent / "idl" / "lottery.json"
    if local_idl.exists():
        return local_idl.resolve()

    for parent in [here.parent] + list(here.parents):
        candidate = parent / "lottery-contracts" / "target" / "idl" / "lottery.json"
        if candidate.exists():
            return candidate
    return (here.parents[1] / "lottery-contracts" / "target" / "idl" / "lottery.json").resolve()


def _network_default_endpoint(kind: str) -> str:
    network = (os.getenv("NETWORK") or os.getenv("SOLANA_NETWORK") or "").lower()
    if "mainnet" in network:
        return "wss://api.mainnet-beta.solana.com/" if kind == "ws" else "https://api.mainnet-beta.solana.com/"
    return "wss://api.devnet.solana.com/" if kind == "ws" else "https://api.devnet.solana.com/"


# Paths and endpoints can be configured via env vars
DEFAULT_IDL_PATH = _resolve_idl_path()
LOG_LEVEL = os.getenv("WORKER_LOG_LEVEL", "INFO").upper()
SOLANA_WS_ENDPOINT = os.getenv("SOLANA_WS_ENDPOINT", _network_default_endpoint("ws"))
SOLANA_HTTP_ENDPOINT = os.getenv("SOLANA_HTTP_ENDPOINT", _network_default_endpoint("http"))
PROGRAM_ID = os.getenv("PROGRAM_ID") or os.getenv("LOTTERY_PROGRAM_ID")
RECONNECT_DELAY_SECONDS = float(os.getenv("WORKER_RECONNECT_DELAY_SECONDS", "3.0"))
POLL_INTERVAL_SECONDS = float(os.getenv("WORKER_POLL_INTERVAL_SECONDS", "10.0"))
RAW_LOG_DEBUG = os.getenv("WORKER_RAW_LOG_DEBUG", "false").lower() in {"1", "true", "yes"}
SOLANA_WS_SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def _lottery_status_value(lottery: LotteryModel) -> str:
    return str(getattr(lottery.status, "value", lottery.status) or "")


def _is_initialize_abandoned(lottery: LotteryModel) -> bool:
    return _lottery_status_value(lottery) == LotteryStatus.INITIALIZE_ABANDONED.value


def _configured_admin_pubkeys_from_env() -> List[Pubkey]:
    candidates: List[str] = []
    for env_name in ("ADMIN_PUBKEYS", "LOTTERY_ADMIN_PUBKEYS"):
        raw = (os.getenv(env_name) or "").strip()
        if not raw:
            continue
        for item in raw.split(","):
            value = item.strip()
            if value and value not in candidates:
                candidates.append(value)

    for env_name in ("ADMIN_PUBKEY", "LOTTERY_ADMIN_PUBKEY"):
        value = (os.getenv(env_name) or "").strip()
        if value and value not in candidates:
            candidates.append(value)

    pubkeys: List[Pubkey] = []
    for value in candidates:
        pubkey = _extract_pubkey(value)
        if pubkey:
            pubkeys.append(pubkey)
        else:
            logging.warning("Ignoring invalid admin pubkey from env: %s", value)
    return pubkeys


def setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )


def _install_signal_handlers(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)


def _load_idl(idl_path: Path) -> Dict[str, Any]:
    with idl_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _normalize_idl_for_anchorpy(idl_dict: Dict[str, Any]) -> str:
    """
    Anchor 0.30+ IDL has account discriminators and events without fields.
    anchorpy 0.16.0 expects legacy shape: accounts with inline type and events with fields.
    """
    def _normalize_type(typ: Any) -> Any:
        if isinstance(typ, str):
            return "publicKey" if typ.lower() == "pubkey" else typ
        if isinstance(typ, dict):
            if "array" in typ and isinstance(typ["array"], list) and len(typ["array"]) == 2:
                return {"array": [_normalize_type(typ["array"][0]), typ["array"][1]]}
            if "vec" in typ:
                return {"vec": _normalize_type(typ["vec"])}
            if "option" in typ:
                return {"option": _normalize_type(typ["option"])}
            if "defined" in typ:
                defined = typ["defined"]
                if isinstance(defined, dict) and "name" in defined:
                    defined = defined["name"]
                return {"defined": defined}
        return typ

    normalized_types: List[Dict[str, Any]] = []
    for t in idl_dict.get("types", []):
        if not isinstance(t, dict):
            continue
        entry = dict(t)
        entry_type = entry.get("type")
        if isinstance(entry_type, dict) and "fields" in entry_type:
            fields = entry_type.get("fields") or []
            new_fields = []
            for fld in fields:
                if not isinstance(fld, dict):
                    continue
                new_fields.append({**fld, "type": _normalize_type(fld.get("type"))})
            entry["type"] = {**entry_type, "fields": new_fields}
        normalized_types.append(entry)

    type_map = {t["name"]: t.get("type") for t in normalized_types if isinstance(t, dict)}

    normalized: Dict[str, Any] = {
        "version": idl_dict.get("metadata", {}).get("version") or idl_dict.get("version", "0.1.0"),
        "name": idl_dict.get("metadata", {}).get("name") or idl_dict.get("name"),
        "metadata": idl_dict.get("metadata", {}),
        "address": idl_dict.get("address"),
    }
    if normalized_types:
        normalized["types"] = normalized_types

    # Rebuild instructions: keep only name, accounts, args
    new_instructions: List[Dict[str, Any]] = []
    for ix in idl_dict.get("instructions", []):
        if not isinstance(ix, dict):
            continue
        accounts_clean: List[Dict[str, Any]] = []
        for acct in ix.get("accounts", []):
            if not isinstance(acct, dict):
                continue
            accounts_clean.append(
                {
                    "name": acct.get("name"),
                    "isMut": bool(acct.get("writable", False)),
                    "isSigner": bool(acct.get("signer", False)),
                }
            )
        new_ix: Dict[str, Any] = {
            "name": ix.get("name"),
            "accounts": accounts_clean,
            "args": [
                {**arg, "type": _normalize_type(arg.get("type"))}
                for arg in ix.get("args", [])
                if isinstance(arg, dict)
            ],
        }
        if "docs" in ix:
            new_ix["docs"] = ix["docs"]
        new_instructions.append(new_ix)
    normalized["instructions"] = new_instructions

    # Rebuild accounts list with inline types, drop discriminators
    new_accounts: List[Dict[str, Any]] = []
    for acct in idl_dict.get("accounts", []):
        if not isinstance(acct, dict):
            continue
        name = acct.get("name")
        inline_type = type_map.get(name)
        if name and inline_type:
            entry: Dict[str, Any] = {"name": name, "type": inline_type}
            if "docs" in acct:
                entry["docs"] = acct["docs"]
            new_accounts.append(entry)
    normalized["accounts"] = new_accounts

    # Rebuild events with fields from type definitions
    new_events: List[Dict[str, Any]] = []
    for ev in idl_dict.get("events", []):
        if not isinstance(ev, dict):
            continue
        name = ev.get("name")
        ev_type = type_map.get(name)
        fields = []
        if isinstance(ev_type, dict):
            for fld in ev_type.get("fields", []):
                if not isinstance(fld, dict):
                    continue
                fields.append(
                    {
                        "name": fld.get("name"),
                        "type": _normalize_type(fld.get("type")),
                        "index": False,
                    }
                )
        new_ev: Dict[str, Any] = {"name": name, "fields": fields}
        if "discriminator" in ev:
            new_ev["discriminator"] = ev["discriminator"]
        new_events.append(new_ev)
    normalized["events"] = new_events

    return json.dumps(normalized)


def _extract_program_id(idl_dict: Dict[str, Any]) -> str:
    if PROGRAM_ID:
        return PROGRAM_ID
    if "address" in idl_dict and idl_dict["address"]:
        return idl_dict["address"]
    metadata = idl_dict.get("metadata") or {}
    if isinstance(metadata, dict) and metadata.get("address"):
        return metadata["address"]
    raise KeyError("address")


def _build_event_parser(idl_dict: Dict[str, Any]) -> tuple[Pubkey, EventParser]:
    program_id = Pubkey.from_string(_extract_program_id(idl_dict))
    idl_json = _normalize_idl_for_anchorpy(idl_dict)
    idl = Idl.from_json(idl_json)
    coder = Coder(idl)
    parser = EventParser(program_id, coder)
    return program_id, parser


def _parse_logs(parser: EventParser, logs: List[str], signature: Optional[str]) -> None:
    found = False
    parsed_event_names: set[str] = set()
    incomplete_event_names: set[str] = set()

    def _callback(event):
        nonlocal found
        found = True
        parsed_event_names.add(event.name)
        payload = _serialize_value(event.data)
        if event.name == "PhaseChanged":
            raw_status = payload.get("status") if isinstance(payload, dict) else None
            if not isinstance(raw_status, str) or not raw_status.strip():
                incomplete_event_names.add(event.name)
                logging.warning(
                    "Incomplete Anchor event %s (%s); deferring persistence to fallback decoder",
                    event.name,
                    signature,
                )
                return
        logging.info("Event %s (%s): %s", event.name, signature, payload)
        _persist_event(event.name, signature, payload, logs)

    try:
        parser.parse_logs(logs, _callback)
    except Exception as exc:
        logging.warning(
            "Anchor event decoding failed for signature %s; trying fallback decoders: %s",
            signature,
            exc,
        )
    fallback_events = _decode_fallback_events_from_logs(logs)
    for event_name, payload in fallback_events:
        if event_name not in parsed_event_names or event_name in incomplete_event_names:
            found = True
            logging.info("Event %s (%s) decoded via fallback parser: %s", event_name, signature, payload)
            _persist_event(event_name, signature, payload, logs)

    if not found:
        msg = "No Anchor events decoded for signature %s" % signature
        if RAW_LOG_DEBUG:
            logging.debug("%s. Logs: %s", msg, logs)
        else:
            logging.warning(msg)


def _extract_transaction_log_messages(tx: Any) -> Optional[List[str]]:
    if tx is None:
        return None

    transaction = getattr(tx, "transaction", None)
    meta = getattr(transaction, "meta", None)
    log_messages = getattr(meta, "log_messages", None)
    if isinstance(log_messages, list):
        return [str(message) for message in log_messages]

    if isinstance(tx, dict):
        meta = tx.get("meta")
        if isinstance(meta, dict):
            log_messages = meta.get("logMessages") or meta.get("log_messages")
            if isinstance(log_messages, list):
                return [str(message) for message in log_messages]

    return None


def _extract_transaction_error(tx: Any) -> Any:
    if tx is None:
        return None

    transaction = getattr(tx, "transaction", None)
    meta = getattr(transaction, "meta", None)
    err = getattr(meta, "err", None)
    if err is not None:
        return err

    if isinstance(tx, dict):
        meta = tx.get("meta")
        if isinstance(meta, dict):
            return meta.get("err")

    return None


def _decode_fallback_events_from_logs(logs: List[str]) -> List[tuple[str, Dict[str, Any]]]:
    decoded: List[tuple[str, Dict[str, Any]]] = []
    marker = "Program data: "

    for line in logs:
        if marker not in line:
            continue

        encoded = line.split(marker, 1)[1].strip()
        if not encoded:
            continue
        try:
            raw = base64.b64decode(encoded)
        except Exception:
            continue

        if len(raw) < _EVENT_DISCRIMINATOR_LEN:
            continue
        discriminator = raw[:_EVENT_DISCRIMINATOR_LEN]
        payload = raw[_EVENT_DISCRIMINATOR_LEN:]
        if discriminator == _EVENT_DISCRIMINATORS["PhaseChanged"]:
            parsed = _decode_phase_changed_payload(payload)
            if parsed:
                decoded.append(("PhaseChanged", parsed))
        elif discriminator == DEPOSIT_EVENT_DISCRIMINATOR:
            parsed_deposit = decode_deposit_event(raw)
            if parsed_deposit:
                decoded.append((
                    "Deposit",
                    {
                        "lottery": parsed_deposit.lottery,
                        "user": parsed_deposit.user,
                        "mint": parsed_deposit.mint,
                        "amount": parsed_deposit.amount_lamports,
                        "ts": parsed_deposit.ts,
                    },
                ))

    return decoded


def _decode_phase_changed_payload(payload: bytes) -> Optional[Dict[str, Any]]:
    # PhaseChanged layout: lottery Pubkey + LotteryStatus enum variant u8.
    if len(payload) < 33:
        return None
    try:
        lottery = str(Pubkey.from_bytes(payload[:32]))
    except Exception:
        return None
    status = {
        0: "open",
        1: "pending_vrf",
        2: "ready_to_draw",
        3: "proceeding_purchases",
        4: "closed",
    }.get(payload[32])
    if status is None:
        return None
    return {"lottery": lottery, "status": status}


def _serialize_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    if isinstance(value, enum.Enum):
        return value.name
    if isinstance(value, (list, tuple)):
        return [_serialize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    if hasattr(value, "__dataclass_fields__"):
        return _serialize_value(asdict(value))
    if hasattr(value, "__dict__"):
        return {
            k: _serialize_value(v)
            for k, v in value.__dict__.items()
            if not k.startswith("_")
        }
    try:
        return str(value)
    except Exception:
        return repr(value)


def _persist_event(event_name: str, signature: Optional[str], event_data: Any, raw_logs: Optional[List[str]]) -> None:
    """Persist parsed event into DB using the same SessionLocal as the FastAPI app."""
    if _is_placeholder_signature(signature):
        logging.debug("Skipping event with placeholder signature: %s (%s)", event_name, signature)
        return
    session = SessionLocal()
    try:
        data = _serialize_value(event_data)

        record = SmartContractEventModel(
            signature=signature,
            event_name=event_name,
            data=data,
            raw_logs=raw_logs,
        )
        session.add(record)
        session.commit()
        _handle_lottery_initialized(session, event_name, event_data)
        _handle_phase2_started(session, event_name, event_data)
        _handle_emergency_seed_used(session, event_name, event_data)
        _handle_vrf_fulfilled(session, event_name, event_data)
        _handle_purchases_phase_started(session, event_name, event_data)
        _handle_phase_changed(session, event_name, event_data)
        _handle_deposit(session, event_name, event_data, signature)
    except IntegrityError as exc:
        session.rollback()
        # Duplicate (signature, event_name) can happen when polling and websocket overlap.
        if "uq_event_signature_name" in str(exc.orig):
            logging.debug("Duplicate event ignored: %s (%s)", event_name, signature)
            try:
                _repair_incomplete_event_record(
                    session=session,
                    event_name=event_name,
                    signature=signature,
                    event_data=event_data,
                    raw_logs=raw_logs,
                )
                _handle_lottery_initialized(session, event_name, event_data)
                _handle_phase2_started(session, event_name, event_data)
                _handle_emergency_seed_used(session, event_name, event_data)
                _handle_vrf_fulfilled(session, event_name, event_data)
                _handle_purchases_phase_started(session, event_name, event_data)
                _handle_phase_changed(session, event_name, event_data)
                _handle_deposit(session, event_name, event_data, signature)
            except Exception:
                logging.exception("Failed to handle duplicate event %s (%s)", event_name, signature)
            return
        logging.exception("Failed to persist event %s (%s)", event_name, signature)
    except Exception:
        session.rollback()
        logging.exception("Failed to persist event %s (%s)", event_name, signature)
    finally:
        session.close()


def _repair_incomplete_event_record(
    session,
    event_name: str,
    signature: Optional[str],
    event_data: Any,
    raw_logs: Optional[List[str]],
) -> None:
    if event_name != "PhaseChanged" or not signature:
        return

    incoming = _serialize_value(event_data)
    incoming_status = incoming.get("status") if isinstance(incoming, dict) else None
    if not isinstance(incoming_status, str) or not incoming_status.strip():
        return

    existing = session.query(SmartContractEventModel).filter(
        SmartContractEventModel.signature == signature,
        SmartContractEventModel.event_name == event_name,
    ).first()
    if not existing:
        return

    existing_data = existing.data or {}
    existing_status = existing_data.get("status") if isinstance(existing_data, dict) else None
    if isinstance(existing_status, str) and existing_status.strip():
        return

    existing.data = incoming
    existing.raw_logs = raw_logs
    session.commit()
    logging.info("Repaired incomplete event record: %s (%s)", event_name, signature)


def _repair_stored_incomplete_phase_changed_events() -> None:
    session = SessionLocal()
    repaired = 0
    try:
        records = session.query(SmartContractEventModel).filter(
            SmartContractEventModel.event_name == "PhaseChanged"
        ).all()
        for record in records:
            existing_data = record.data or {}
            existing_status = existing_data.get("status") if isinstance(existing_data, dict) else None
            if isinstance(existing_status, str) and existing_status.strip():
                continue

            fallback_payload = next(
                (
                    payload
                    for event_name, payload in _decode_fallback_events_from_logs(record.raw_logs or [])
                    if event_name == "PhaseChanged"
                    and isinstance(payload.get("status"), str)
                    and payload["status"].strip()
                ),
                None,
            )
            if fallback_payload is None:
                continue

            record.data = fallback_payload
            session.commit()
            lottery_pubkey = _extract_pubkey(fallback_payload.get("lottery"))
            if (
                fallback_payload.get("status") == "closed"
                and lottery_pubkey is not None
                and _resolve_lottery_id_by_pubkey(session, lottery_pubkey) is not None
            ):
                _handle_phase_changed(session, "PhaseChanged", fallback_payload)
            repaired += 1
    except Exception:
        session.rollback()
        logging.exception("Failed to reconcile stored incomplete PhaseChanged events")
    finally:
        session.close()

    if repaired:
        logging.info("Repaired %s stored incomplete PhaseChanged event records", repaired)


def _handle_lottery_initialized(session, event_name: str, event_data: Any) -> None:
    if event_name != "LotteryInitialized":
        return
    if _PROGRAM_ID is None:
        logging.warning("Program id is not set; skipping lottery status update.")
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    admin_pubkey = _extract_pubkey(_get_event_field(event_data, "admin"))
    if not lottery_pubkey or not admin_pubkey:
        logging.warning("LotteryInitialized missing lottery/admin pubkey; skipping status update.")
        return

    lottery_id = _find_lottery_id(session, admin_pubkey, lottery_pubkey, _PROGRAM_ID)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping status update.", lottery_id)
        return

    if lottery.status != LotteryStatus.ID_GENERATED:
        logging.info(
            "Lottery %s status is %s; skipping update.",
            lottery_id,
            getattr(lottery.status, "value", lottery.status),
        )
        return

    lottery.status = LotteryStatus.CREATED
    session.commit()
    logging.info("Lottery %s status updated to created.", lottery_id)
    _LOTTERY_PUBKEY_CACHE[str(lottery_pubkey)] = lottery_id


def _handle_deposit(session, event_name: str, event_data: Any, signature: Optional[str]) -> None:
    if event_name != "Deposit":
        return

    if not signature:
        logging.warning("Deposit missing signature; skipping bet insert.")
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    user_pubkey = _extract_pubkey(_get_event_field(event_data, "user"))
    mint_pubkey = _extract_pubkey(_get_event_field(event_data, "mint"))
    amount = _get_event_field(event_data, "amount")
    if not lottery_pubkey or not user_pubkey or not mint_pubkey or amount is None:
        logging.warning("Deposit missing lottery/user/mint/amount; skipping bet insert.")
        return

    lottery_id = _resolve_lottery_id_by_pubkey(session, lottery_pubkey)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping bet insert.", lottery_id)
        return
    if _is_initialize_abandoned(lottery):
        logging.error(
            "Deposit ignored for abandoned initialize lottery (lottery_id=%s, lottery=%s, signature=%s)",
            lottery_id,
            lottery_pubkey,
            signature,
        )
        return

    try:
        owner_id = resolve_wallet_owner_id(session, str(user_pubkey))
    except Exception:
        logging.exception("Failed to resolve the owner of wallet %s; skipping bet insert.", user_pubkey)
        session.rollback()
        return

    try:
        lamports = int(amount)
    except Exception:
        logging.warning("Invalid deposit amount %s; skipping bet insert.", amount)
        return

    exists = session.query(BetParticipationModel).filter(
        BetParticipationModel.tx_signature == signature
    ).first()
    if exists:
        logging.info(
            "Skipping duplicate bet for lottery %s from wallet %s (sig=%s).",
            lottery_id,
            user_pubkey,
            signature,
        )
        return

    sol_amount = lamports / 1_000_000_000
    event_ts = _get_event_field(event_data, "ts")
    bet_time = None
    if event_ts is not None:
        try:
            bet_time = datetime.fromtimestamp(int(event_ts), tz=timezone.utc)
        except Exception:
            bet_time = None

    bet = BetParticipationModel(
        user_id=owner_id,
        lottery_id=lottery_id,
        meme_coin_address=str(mint_pubkey),
        sol_amount=sol_amount,
        wallet_address=str(user_pubkey),
        tx_signature=signature,
        confirmation_status=BET_STATUS_CONFIRMED,
        confirmed_at=datetime.now(timezone.utc),
        created_at=bet_time,
    )
    session.add(bet)
    session.commit()
    logging.info("Inserted bet for lottery %s from wallet %s.", lottery_id, user_pubkey)


def _handle_phase2_started(session, event_name: str, event_data: Any) -> None:
    if event_name != "Phase2Started":
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    if not lottery_pubkey:
        logging.warning("Phase2Started missing lottery pubkey; skipping status update.")
        return

    lottery_id = _resolve_lottery_id_by_pubkey(session, lottery_pubkey)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping status update.", lottery_id)
        return

    if lottery.status == LotteryStatus.PHASE2STARTED:
        if not getattr(lottery, "second_phase_started_at", None):
            lottery.second_phase_started_at = datetime.now(timezone.utc)
            session.commit()
            logging.info(
                "Lottery %s already phase2started; backfilled second_phase_started_at.",
                lottery_id,
            )
        else:
            logging.info("Lottery %s already phase2started; skipping update.", lottery_id)
        return

    if lottery.status not in {LotteryStatus.ID_GENERATED, LotteryStatus.CREATED}:
        logging.info(
            "Lottery %s status is %s; skipping phase2started update.",
            lottery_id,
            getattr(lottery.status, "value", lottery.status),
        )
        return

    lottery.status = LotteryStatus.PHASE2STARTED
    lottery.second_phase_started_at = datetime.now(timezone.utc)
    session.commit()
    logging.info("Lottery %s status updated to phase2started.", lottery_id)


def _handle_vrf_fulfilled(session, event_name: str, event_data: Any) -> None:
    if event_name != "VrfFulfilled":
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    seed_hex = _extract_seed_hex(_get_event_field(event_data, "seed"))
    if not lottery_pubkey:
        logging.warning("VrfFulfilled missing lottery pubkey; skipping status update.")
        return

    lottery_id = _resolve_lottery_id_by_pubkey(session, lottery_pubkey)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping status update.", lottery_id)
        return

    if lottery.status not in {LotteryStatus.PHASE2STARTED, LotteryStatus.VRF_BINDED, LotteryStatus.VRF_FULFILLED}:
        logging.info(
            "Lottery %s status is %s; skipping vrf_fulfilled update.",
            lottery_id,
            getattr(lottery.status, "value", lottery.status),
        )
        return

    if lottery.status == LotteryStatus.VRF_FULFILLED and lottery.vrf_seed == seed_hex:
        logging.info("Lottery %s already vrf_fulfilled with same seed; skipping update.", lottery_id)
        return

    lottery.status = LotteryStatus.VRF_FULFILLED
    lottery.vrf_seed = seed_hex
    session.commit()
    logging.info("Lottery %s status updated to vrf_fulfilled (seed saved=%s).", lottery_id, bool(seed_hex))


def _handle_emergency_seed_used(session, event_name: str, event_data: Any) -> None:
    if event_name != "EmergencySeedUsed":
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    seed_hex = _extract_seed_hex(_get_event_field(event_data, "seed"))
    if not lottery_pubkey:
        logging.warning("EmergencySeedUsed missing lottery pubkey; skipping status update.")
        return

    lottery_id = _resolve_lottery_id_by_pubkey(session, lottery_pubkey)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping emergency seed update.", lottery_id)
        return

    if _is_initialize_abandoned(lottery):
        logging.error(
            "EmergencySeedUsed ignored for abandoned initialize lottery (lottery_id=%s, lottery=%s)",
            lottery_id,
            lottery_pubkey,
        )
        return

    if lottery.status in {
        LotteryStatus.PROCEEDING_PURCHASES,
        LotteryStatus.CLOSED,
        LotteryStatus.COMPLETED,
    }:
        logging.info(
            "Lottery %s status is %s; skipping emergency seed update.",
            lottery_id,
            getattr(lottery.status, "value", lottery.status),
        )
        return

    lottery.status = LotteryStatus.VRF_FULFILLED
    lottery.vrf_seed = seed_hex
    if hasattr(lottery, "is_offchain_vrf"):
        lottery.is_offchain_vrf = True
    session.commit()
    logging.info(
        "Lottery %s updated from EmergencySeedUsed (status=vrf_fulfilled, offchain=%s, seed_saved=%s).",
        lottery_id,
        bool(getattr(lottery, "is_offchain_vrf", False)),
        bool(seed_hex),
    )


def _handle_purchases_phase_started(session, event_name: str, event_data: Any) -> None:
    if event_name != "PurchasesPhaseStarted":
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    if not lottery_pubkey:
        logging.warning("PurchasesPhaseStarted missing lottery pubkey; skipping status update.")
        return

    lottery_id = _resolve_lottery_id_by_pubkey(session, lottery_pubkey)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping status update.", lottery_id)
        return

    if _is_initialize_abandoned(lottery):
        logging.error(
            "PurchasesPhaseStarted ignored for abandoned initialize lottery (lottery_id=%s, lottery=%s)",
            lottery_id,
            lottery_pubkey,
        )
        return

    if lottery.status == LotteryStatus.PROCEEDING_PURCHASES:
        logging.info("Lottery %s already proceeding_purchases; skipping update.", lottery_id)
        return

    if lottery.status in {LotteryStatus.CLOSED, LotteryStatus.COMPLETED}:
        logging.info(
            "Lottery %s status is %s; skipping proceeding_purchases update.",
            lottery_id,
            getattr(lottery.status, "value", lottery.status),
        )
        return

    lottery.status = LotteryStatus.PROCEEDING_PURCHASES
    session.commit()
    logging.info("Lottery %s status updated to proceeding_purchases.", lottery_id)


def _handle_phase_changed(session, event_name: str, event_data: Any) -> None:
    if event_name != "PhaseChanged":
        return

    lottery_pubkey = _extract_pubkey(_get_event_field(event_data, "lottery"))
    if not lottery_pubkey:
        logging.warning("PhaseChanged missing lottery pubkey; skipping status update.")
        return

    raw_status = _get_event_field(event_data, "status")
    status_value = str(raw_status).lower() if raw_status is not None else ""
    if status_value != "closed":
        return

    lottery_id = _resolve_lottery_id_by_pubkey(session, lottery_pubkey)
    if lottery_id is None:
        logging.warning("No matching lottery id for on-chain lottery %s", lottery_pubkey)
        return

    lottery = session.query(LotteryModel).filter(LotteryModel.id == lottery_id).first()
    if not lottery:
        logging.warning("Lottery %s not found in DB; skipping status update.", lottery_id)
        return

    close_reason = "initialize_abandoned" if _is_initialize_abandoned(lottery) else None
    if lottery.status == LotteryStatus.CLOSED:
        if close_reason and getattr(lottery, "close_reason", None) != close_reason:
            lottery.close_reason = close_reason
            session.commit()
        logging.info("Lottery %s already closed; skipping update.", lottery_id)
        return

    if close_reason:
        lottery.close_reason = close_reason
    lottery.status = LotteryStatus.CLOSED
    session.commit()
    logging.info("Lottery %s status updated to closed.", lottery_id)


def _resolve_lottery_id_by_pubkey(session, lottery_pubkey: Pubkey) -> Optional[int]:
    cache_key = str(lottery_pubkey)
    if cache_key in _LOTTERY_PUBKEY_CACHE:
        return _LOTTERY_PUBKEY_CACHE[cache_key]

    init_events = (
        session.query(SmartContractEventModel)
        .filter(SmartContractEventModel.event_name == "LotteryInitialized")
        .all()
    )
    for event in init_events:
        data = event.data or {}
        if data.get("lottery") != cache_key:
            continue
        admin = _extract_pubkey(data.get("admin"))
        if not admin or _PROGRAM_ID is None:
            continue
        lottery_id = _find_lottery_id(session, admin, lottery_pubkey, _PROGRAM_ID)
        if lottery_id is not None:
            _LOTTERY_PUBKEY_CACHE[cache_key] = lottery_id
            return lottery_id

    if _PROGRAM_ID is not None:
        for admin in _configured_admin_pubkeys_from_env():
            lottery_id = _find_lottery_id(session, admin, lottery_pubkey, _PROGRAM_ID)
            if lottery_id is not None:
                _LOTTERY_PUBKEY_CACHE[cache_key] = lottery_id
                return lottery_id

    return None


def _is_placeholder_signature(signature: Optional[str]) -> bool:
    if signature is None:
        return True
    return signature == "1111111111111111111111111111111111111111111111111111111111111111"


def _get_event_field(event_data: Any, field: str) -> Any:
    if hasattr(event_data, field):
        return getattr(event_data, field)
    if isinstance(event_data, dict):
        return event_data.get(field)
    return None


def _extract_seed_hex(value: Any) -> Optional[str]:
    if value is None:
        return None

    try:
        if isinstance(value, (bytes, bytearray)):
            return bytes(value).hex()
        if isinstance(value, str):
            return value.strip().lower() or None
        if isinstance(value, list) and all(isinstance(b, int) for b in value):
            return bytes(value).hex()
    except Exception:
        return None

    return None


def _extract_pubkey(value: Any) -> Optional[Pubkey]:
    if value is None:
        return None
    if isinstance(value, Pubkey):
        return value
    if isinstance(value, str):
        try:
            return Pubkey.from_string(value)
        except Exception:
            return None
    if isinstance(value, (bytes, bytearray)):
        try:
            return Pubkey.from_bytes(bytes(value))
        except Exception:
            return None
    if isinstance(value, list) and all(isinstance(b, int) for b in value):
        try:
            return Pubkey.from_bytes(bytes(value))
        except Exception:
            return None
    return None


def _find_lottery_id(session, admin_pubkey: Pubkey, lottery_pubkey: Pubkey, program_id: Pubkey) -> Optional[int]:
    lotteries = (
        session.query(LotteryModel)
        .filter(LotteryModel.status.in_([
            LotteryStatus.ID_GENERATED,
            LotteryStatus.INITIALIZE_ABANDONED,
            LotteryStatus.CREATED,
            LotteryStatus.PHASE2STARTED,
            LotteryStatus.VRF_BINDED,
            LotteryStatus.VRF_FULFILLED,
            LotteryStatus.PROCEEDING_PURCHASES,
            LotteryStatus.CLOSED,
        ]))
        .all()
    )
    for lottery in lotteries:
        lottery_id = lottery.id
        derived = _derive_lottery_pda(admin_pubkey, lottery_id, program_id)
        if derived and derived == lottery_pubkey:
            return lottery_id
    return None


def _derive_lottery_pda(admin_pubkey: Pubkey, lottery_id: int, program_id: Pubkey) -> Optional[Pubkey]:
    try:
        seed_lottery = b"lottery"
        seed_admin = bytes(admin_pubkey)
        seed_id = int(lottery_id).to_bytes(8, "little", signed=False)
        pda, _ = Pubkey.find_program_address([seed_lottery, seed_admin, seed_id], program_id)
        return pda
    except Exception:
        return None


async def _listen_events(stop_event: asyncio.Event, program_id: Pubkey, parser: EventParser) -> None:
    while not stop_event.is_set():
        try:
            async with connect(SOLANA_WS_ENDPOINT, ssl=SOLANA_WS_SSL_CONTEXT) as websocket:
                await websocket.logs_subscribe(RpcTransactionLogsFilterMentions(program_id))
                await websocket.recv()  # Subscription confirmation
                logging.info("Subscribed to logs for program %s via %s", program_id, SOLANA_WS_ENDPOINT)

                while not stop_event.is_set():
                    try:
                        messages = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue

                    if not isinstance(messages, list):
                        if RAW_LOG_DEBUG:
                            logging.debug("Non-list websocket message: %s", messages)
                        continue

                    for msg in messages:
                        # SubscriptionResult instances and other notifications also show up here.
                        to_json = getattr(msg, "to_json", None)
                        if not callable(to_json):
                            continue
                        payload = json.loads(to_json())

                        # Handle both shapes: {"params":{"result":...}} and {"result":...}
                        params = payload.get("params") or {}
                        result = params.get("result") if isinstance(params, dict) else None
                        value = result.get("value") if isinstance(result, dict) else None

                        if value is None and "result" in payload and isinstance(payload["result"], dict):
                            value = payload["result"].get("value")

                        logs = value.get("logs") if isinstance(value, dict) else None
                        signature = value.get("signature") if isinstance(value, dict) else None
                        transaction_error = value.get("err") if isinstance(value, dict) else None

                        if transaction_error is not None:
                            logging.info("Skipping failed transaction logs (%s): %s", signature, transaction_error)
                        elif isinstance(logs, list):
                            if RAW_LOG_DEBUG:
                                logging.debug("Raw logs (%s): %s", signature, logs)
                            _parse_logs(parser, logs, signature)
                        elif RAW_LOG_DEBUG:
                            logging.debug("Unexpected payload (no logs): %s", payload)
        except Exception as exc:  # noqa: BLE001 - we want to log any listener failure
            logging.exception("Event listener error: %s. Reconnecting in %ss", exc, RECONNECT_DELAY_SECONDS)
            if isinstance(exc, socket.gaierror):
                logging.error(
                    "Name resolution failed for %s. Check SOLANA_WS_ENDPOINT or network access; stopping listener.",
                    SOLANA_WS_ENDPOINT,
                )
                stop_event.set()
                break
            await asyncio.sleep(RECONNECT_DELAY_SECONDS)


async def _poll_events(stop_event: asyncio.Event, program_id: Pubkey, parser: EventParser) -> None:
    """Fallback polling via HTTP RPC to avoid missing events."""
    seen_signatures: set[str] = set()
    async with SolanaJsonRpc(SOLANA_HTTP_ENDPOINT) as rpc:
        while not stop_event.is_set():
            try:
                rows = await rpc.get_signatures_for_address(program_id, limit=20)
                fresh = [row for row in rows if str(row.get("signature") or "") not in seen_signatures]

                for row in reversed(fresh):  # older → newer
                    sig = str(row.get("signature") or "")
                    if not sig:
                        continue
                    if signature_failed(row):
                        # The listing already carries `err`, so a failed
                        # transaction costs nothing to skip here.
                        seen_signatures.add(sig)
                        continue
                    tx = await rpc.get_transaction(
                        sig,
                        encoding="jsonParsed",
                        max_supported_transaction_version=0,
                    )
                    if tx is None or _extract_transaction_error(tx) is not None:
                        seen_signatures.add(sig)
                        continue
                    log_messages = _extract_transaction_log_messages(tx)
                    if log_messages:
                        _parse_logs(parser, log_messages, sig)
                    seen_signatures.add(sig)
            except Exception as exc:  # noqa: BLE001
                logging.exception("Polling error: %s", exc)
                if isinstance(exc, socket.gaierror) or "nodename nor servname" in str(exc):
                    logging.error(
                        "Name resolution failed for %s. Check SOLANA_HTTP_ENDPOINT or network access; stopping polling.",
                        SOLANA_HTTP_ENDPOINT,
                    )
                    stop_event.set()
                    break
            await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def main() -> None:
    stop_event = asyncio.Event()
    setup_logging()
    _install_signal_handlers(stop_event)

    idl_env = os.getenv("PROGRAM_IDL_PATH")
    if idl_env:
        idl_path = Path(idl_env).expanduser()
        if not idl_path.is_file():
            raise FileNotFoundError(f"PROGRAM_IDL_PATH does not exist or is not a file: {idl_path}")
        logging.info("Using IDL from PROGRAM_IDL_PATH: %s", idl_path)
    else:
        idl_path = DEFAULT_IDL_PATH
    idl_dict = _load_idl(idl_path)
    if PROGRAM_ID:
        idl_dict = dict(idl_dict)
        idl_dict["address"] = PROGRAM_ID
    program_id, parser = _build_event_parser(idl_dict)
    global _PROGRAM_ID
    _PROGRAM_ID = program_id
    _repair_stored_incomplete_phase_changed_events()
    logging.info(
        "Starting event listener. IDL=%s WS=%s HTTP=%s poll=%ss",
        idl_path,
        SOLANA_WS_ENDPOINT,
        SOLANA_HTTP_ENDPOINT,
        POLL_INTERVAL_SECONDS,
    )

    await asyncio.gather(
        _listen_events(stop_event, program_id, parser),
        _poll_events(stop_event, program_id, parser),
    )
    logging.info("Worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
