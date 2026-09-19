from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from typing import Iterable

from solders.pubkey import Pubkey


DEPOSIT_EVENT_DISCRIMINATOR = hashlib.sha256(b"event:Deposit").digest()[:8]


@dataclass(frozen=True)
class DepositEvent:
    lottery: str
    user: str
    mint: str
    amount_lamports: int
    ts: int


def decode_deposit_events_from_logs(logs: Iterable[str] | None) -> list[DepositEvent]:
    if not logs:
        return []

    events: list[DepositEvent] = []
    marker = "Program data: "
    for line in logs:
        if marker not in line:
            continue

        encoded = str(line).split(marker, 1)[1].strip()
        if not encoded:
            continue

        try:
            raw = base64.b64decode(encoded)
        except Exception:
            continue

        event = decode_deposit_event(raw)
        if event is not None:
            events.append(event)

    return events


def decode_deposit_event(raw: bytes) -> DepositEvent | None:
    expected_len = 8 + 32 + 32 + 32 + 8 + 8
    if len(raw) < expected_len or raw[:8] != DEPOSIT_EVENT_DISCRIMINATOR:
        return None

    offset = 8

    def take(size: int) -> bytes:
        nonlocal offset
        value = raw[offset:offset + size]
        offset += size
        return value

    try:
        lottery = str(Pubkey.from_bytes(take(32)))
        user = str(Pubkey.from_bytes(take(32)))
        mint = str(Pubkey.from_bytes(take(32)))
    except Exception:
        return None

    amount_lamports = int.from_bytes(take(8), byteorder="little", signed=False)
    ts = int.from_bytes(take(8), byteorder="little", signed=True)
    return DepositEvent(
        lottery=lottery,
        user=user,
        mint=mint,
        amount_lamports=amount_lamports,
        ts=ts,
    )
