import asyncio
import logging
import os
from pathlib import Path
from typing import Optional

from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.signature import Signature

import events_worker as event_worker
from database.database import SessionLocal
from database.models.backfill_state_model import BackfillStateModel


def _default_solana_http_endpoint() -> str:
    network = (os.getenv("NETWORK") or os.getenv("SOLANA_NETWORK") or "").lower()
    if "mainnet" in network:
        return "https://api.mainnet-beta.solana.com/"
    return "https://api.devnet.solana.com/"


LOG_LEVEL = os.getenv("BACKFILL_LOG_LEVEL", os.getenv("WORKER_LOG_LEVEL", "INFO")).upper()
SOLANA_HTTP_ENDPOINT = os.getenv("SOLANA_HTTP_ENDPOINT", _default_solana_http_endpoint())
PROGRAM_ID = os.getenv("PROGRAM_ID") or os.getenv("LOTTERY_PROGRAM_ID")
PROGRAM_IDL_PATH = os.getenv("PROGRAM_IDL_PATH")
BACKFILL_INTERVAL_SECONDS = float(os.getenv("BACKFILL_INTERVAL_SECONDS", "60.0"))
BACKFILL_BATCH_LIMIT = int(os.getenv("BACKFILL_BATCH_LIMIT", "100"))
BACKFILL_MAX_SIGNATURES = int(os.getenv("BACKFILL_MAX_SIGNATURES", "500"))
BACKFILL_STATE_ID = os.getenv("BACKFILL_STATE_ID")


def setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )


def _resolve_idl_path() -> Path:
    if PROGRAM_IDL_PATH:
        return Path(PROGRAM_IDL_PATH).resolve()
    return event_worker._resolve_idl_path()


def _state_id(program_id: Pubkey) -> str:
    return BACKFILL_STATE_ID or f"lottery_program:{program_id}"


def _load_state(session, program_id: Pubkey) -> Optional[BackfillStateModel]:
    return session.query(BackfillStateModel).filter(
        BackfillStateModel.id == _state_id(program_id)
    ).first()


def _save_state(session, program_id: Pubkey, last_signature: str) -> None:
    state_id = _state_id(program_id)
    state = _load_state(session, program_id)
    if not state:
        state = BackfillStateModel(id=state_id, last_signature=last_signature)
        session.add(state)
    else:
        state.last_signature = last_signature
    session.commit()


async def _collect_new_signatures(client: AsyncClient, program_id: Pubkey, last_signature: Optional[str]) -> list[str]:
    collected: list[str] = []
    before: Optional[Signature] = None
    reached_last = False

    while len(collected) < BACKFILL_MAX_SIGNATURES:
        resp = await client.get_signatures_for_address(program_id, limit=BACKFILL_BATCH_LIMIT, before=before)
        sig_list = resp.value or []
        if not sig_list:
            break

        for sig_info in sig_list:
            sig_str = str(sig_info.signature)
            if last_signature and sig_str == last_signature:
                reached_last = True
                break
            collected.append(sig_str)

        if reached_last:
            break

        before = sig_list[-1].signature

    return collected


async def _process_signature(client: AsyncClient, program_id: Pubkey, parser, signature: str) -> None:
    tx_resp = await client.get_transaction(
        Signature.from_string(signature),
        encoding="jsonParsed",
        max_supported_transaction_version=0,
    )
    if event_worker._extract_transaction_error(tx_resp.value) is not None:
        logging.debug("Skipping failed transaction %s during backfill", signature)
        return
    log_messages = event_worker._extract_transaction_log_messages(tx_resp.value)
    if log_messages:
        event_worker._parse_logs(parser, log_messages, signature)
    else:
        logging.debug("No logs for signature %s", signature)


async def _backfill_once(client: AsyncClient, program_id: Pubkey, parser) -> None:
    session = SessionLocal()
    try:
        state = _load_state(session, program_id)
        last_signature = state.last_signature if state else None
    finally:
        session.close()

    new_signatures = await _collect_new_signatures(client, program_id, last_signature)
    if not new_signatures:
        return

    for sig in reversed(new_signatures):
        await _process_signature(client, program_id, parser, sig)
        session = SessionLocal()
        try:
            _save_state(session, program_id, sig)
        finally:
            session.close()


async def main() -> None:
    setup_logging()
    idl_path = _resolve_idl_path()
    idl_dict = event_worker._load_idl(idl_path)
    if PROGRAM_ID:
        idl_dict = dict(idl_dict)
        idl_dict["address"] = PROGRAM_ID
    program_id, parser = event_worker._build_event_parser(idl_dict)
    event_worker._PROGRAM_ID = program_id

    logging.info(
        "Starting backfill worker. IDL=%s HTTP=%s interval=%ss",
        idl_path,
        SOLANA_HTTP_ENDPOINT,
        BACKFILL_INTERVAL_SECONDS,
    )

    async with AsyncClient(SOLANA_HTTP_ENDPOINT) as client:
        while True:
            try:
                await _backfill_once(client, program_id, parser)
            except Exception as exc:  # noqa: BLE001
                logging.exception("Backfill error: %s", exc)
            await asyncio.sleep(BACKFILL_INTERVAL_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
