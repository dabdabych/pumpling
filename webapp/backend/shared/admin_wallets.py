from __future__ import annotations

from typing import Any


def configured_admin_pubkeys(settings: Any | None = None) -> list[str]:
    if settings is None:
        from shared.settings import get_settings

        settings = get_settings()

    candidates: list[str] = []
    raw_list = (getattr(settings, "lottery_admin_pubkeys", "") or "").strip()
    if raw_list:
        for item in raw_list.split(","):
            value = item.strip()
            if value and value not in candidates:
                candidates.append(value)

    fallback = (getattr(settings, "lottery_admin_pubkey", "") or "").strip()
    if fallback and fallback not in candidates:
        candidates.insert(0, fallback)

    return candidates


def is_configured_admin_pubkey(wallet_address: str | None, settings: Any | None = None) -> bool:
    address = (wallet_address or "").strip()
    if not address:
        return False
    return address in configured_admin_pubkeys(settings)
