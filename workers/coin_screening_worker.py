"""Checks each coin for obvious red flags once, at the first commit to it in a pool.

The rule and its sources are in `webapp/backend/shared/coin_screening.py`, the
queue in `shared/coin_screening_store.py`. This process only runs the loop:
every few seconds it queues the coins that got a first confirmed commit and
runs the checks that are due.

The mint is read from mainnet. On the stand the node is devnet while the coins
people commit to are mainnet addresses (the coin data comes from DexScreener
and pump.fun, which know only mainnet), so a devnet node would answer that no
such mint exists. COIN_SCREENING_RPC_URL overrides it.

With neither provider key set the worker still runs and still flags what the
mint itself shows; it can just never call a coin clean.
"""
import asyncio
import logging
import os
import signal
import time
from contextlib import suppress
from datetime import datetime, timezone

import httpx

from infrastructure.database.database import SessionLocal
from infrastructure.database.models.lottery_model import LotteryModel  # noqa: F401 - registers lotteries for the FK
from infrastructure.database.models.user_model import UserModel  # noqa: F401 - registers users for bet_participations
from shared.coin_screening import SOURCE_SOLANA_TRACKER, ChainRead, DailyBudget, ProviderAnswer, ask_providers, read_chain, read_curve, screening_enabled
from shared.coin_screening_store import enqueue_new, run_due
from shared.log_redaction import install_log_redaction
from shared.settings import get_settings
from shared.solana_rpc import SolanaJsonRpc
from telegram_error_handler import TelegramLogHandler

MAINNET_PUBLIC_RPC = "https://api.mainnet-beta.solana.com"
LOG_LEVEL = os.getenv("COIN_SCREENING_LOG_LEVEL", "INFO").upper()
POLL_SECONDS = float(os.getenv("COIN_SCREENING_POLL_SECONDS", "10"))
PROVIDER_TIMEOUT_SECONDS = float(os.getenv("COIN_SCREENING_PROVIDER_TIMEOUT_SECONDS", "8"))
#: tracced allows five requests a second; one check is one request.
PAUSE_BETWEEN_CHECKS_SECONDS = 0.3
#: A rejected key is said once in this long, not once per coin.
REJECTED_KEY_ALERT_EVERY_SECONDS = 3600
#: Calls a day to Solana Tracker, the fallback: its free plan is 2,500 a month.
SOLANA_TRACKER_DAILY_LIMIT = int(os.getenv("SOLANA_TRACKER_DAILY_LIMIT", "75"))

logger = logging.getLogger("coin_screening_worker")


def screening_rpc_url() -> str:
    explicit = (os.getenv("COIN_SCREENING_RPC_URL") or "").strip()
    if explicit:
        return explicit
    node = (os.getenv("SOLANA_HTTP_ENDPOINT") or "").strip()
    if not node or "devnet" in node:
        return MAINNET_PUBLIC_RPC
    return node


def setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, LOG_LEVEL, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    settings = get_settings()
    if settings.telegram_error_bot_token and settings.telegram_error_chat_id:
        root = logging.getLogger()
        if not any(isinstance(handler, TelegramLogHandler) for handler in root.handlers):
            handler = TelegramLogHandler(
                settings.telegram_error_bot_token,
                settings.telegram_error_chat_id,
                application="coin-screening-worker",
                level=logging.ERROR,
                api_base_url=settings.telegram_api_base_url,
            )
            handler.setFormatter(logging.Formatter("%(message)s"))
            root.addHandler(handler)
    # The RPC endpoint carries its API key in the query string.
    install_log_redaction()


def _install_signal_handlers(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)


class Checker:
    """One coin's check: the mint from the chain, the holders from the providers."""

    def __init__(self, rpc: SolanaJsonRpc, http: httpx.AsyncClient):
        self.rpc = rpc
        self.http = http
        self.tracced_key = (os.getenv("TRACCED_API_KEY") or "").strip() or None
        self.solana_tracker_key = (os.getenv("SOLANA_TRACKER_API_KEY") or "").strip() or None
        self.solana_tracker_budget = DailyBudget(SOLANA_TRACKER_DAILY_LIMIT)
        self._rejected_said_at: dict[str, float] = {}
        self._budget_said_on: str | None = None

    async def __call__(self, mint: str) -> tuple[ChainRead, ProviderAnswer, bool | None]:
        chain = await read_chain(self.rpc, mint)
        if chain.state == "missing":
            return chain, ProviderAnswer("no_data"), None
        on_curve = await read_curve(self.rpc, mint)
        fallback = self.solana_tracker_key if self.solana_tracker_budget.available() else None
        if self.solana_tracker_key and not fallback:
            self._say_budget_spent()
        answer, attempts = await ask_providers(
            self.http, mint, tracced_key=self.tracced_key, solana_tracker_key=fallback,
        )
        for source, attempt in attempts:
            if source == SOURCE_SOLANA_TRACKER:
                self.solana_tracker_budget.spend()
                if attempt.status_code == 429:
                    self.solana_tracker_budget.spent_out()
            if attempt.kind == "rejected":
                self._say_rejected("Solana Tracker" if source == SOURCE_SOLANA_TRACKER else "tracced", attempt.status_code)
        await asyncio.sleep(PAUSE_BETWEEN_CHECKS_SECONDS)
        return chain, answer, on_curve

    def _say_budget_spent(self) -> None:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        if self._budget_said_on != today:
            self._budget_said_on = today
            logger.warning(
                "Solana Tracker's allowance for today is used (%s calls a day): no fallback until 00:00 UTC.",
                SOLANA_TRACKER_DAILY_LIMIT,
            )

    def _say_rejected(self, name: str, status_code: int | None) -> None:
        now = time.monotonic()
        if now - self._rejected_said_at.get(name, -REJECTED_KEY_ALERT_EVERY_SECONDS) < REJECTED_KEY_ALERT_EVERY_SECONDS:
            return
        self._rejected_said_at[name] = now
        logger.error(
            "%s refused our API key (HTTP %s): coin checks fall back to the other source or to the mint alone.",
            name, status_code,
        )


async def run_once(checker: Checker) -> None:
    session = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        added = enqueue_new(session, now)
        if added:
            logger.info("queued %s coin(s) for screening", added)
        await run_due(session, now, checker)
    except Exception:
        session.rollback()
        logger.exception("coin screening pass failed")
    finally:
        session.close()


async def main() -> None:
    setup_logging()
    stop_event = asyncio.Event()
    _install_signal_handlers(stop_event)
    if not screening_enabled():
        # Off on this server: no provider is asked and nothing is queued. The
        # process stays up rather than exiting, or compose would restart it in
        # a loop; it just waits to be stopped.
        logger.info("coin screening is off on this server (COIN_SCREENING_ENABLED=false): nothing is checked")
        await stop_event.wait()
        return
    rpc_url = screening_rpc_url()
    async with SolanaJsonRpc(rpc_url, timeout=PROVIDER_TIMEOUT_SECONDS) as rpc, \
            httpx.AsyncClient(timeout=PROVIDER_TIMEOUT_SECONDS) as http:
        checker = Checker(rpc, http)
        logger.info(
            "coin screening worker started (tracced=%s, solana_tracker=%s, %s a day, poll=%ss)",
            "on" if checker.tracced_key else "off",
            "on" if checker.solana_tracker_key else "off",
            SOLANA_TRACKER_DAILY_LIMIT,
            POLL_SECONDS,
        )
        while not stop_event.is_set():
            await run_once(checker)
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop_event.wait(), timeout=POLL_SECONDS)


if __name__ == "__main__":
    asyncio.run(main())
