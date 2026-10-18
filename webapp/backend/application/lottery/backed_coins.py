"""The coins people have backed with SOL, for the bubbles on the main page.

Every coin whose confirmed commits add up to at least `min_sol`, across every
pool, with how much went in and where the coin trades. The main page draws them
as bubbles, the bigger the more SOL, and each one opens the coin where it trades.
The point is trust: a visitor sees real coins that have been through the pools,
and can open any of them.

Where a coin trades is pump.fun when it was made there and DexScreener
otherwise. pump.fun keeps a page for its coins after they graduate, while
DexScreener does not list coins still on a pump.fun curve: of the six coins
over 1 SOL on mainnet on 2026-10-16 it knew two. Whether a coin was made on
pump.fun is read from the chain, its bonding-curve account, which stays after
graduation; that never changes, so each answer is kept for the life of the
process.
"""
from __future__ import annotations

import base64
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Iterable, Optional

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

from infrastructure.database.models.bet_participation_model import BetParticipationModel
from shared.bet_confirmation import active_bet_condition

logger = logging.getLogger(__name__)

#: The public node, for a stand on devnet: the coins are mainnet addresses there too.
MAINNET_PUBLIC_RPC = "https://api.mainnet-beta.solana.com"
PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
#: getMultipleAccounts takes at most a hundred addresses.
RPC_BATCH = 100
RPC_TIMEOUT_SECONDS = 4.0

VENUE_PUMP = "pump.fun"
VENUE_DEXSCREENER = "DexScreener"


@dataclass(frozen=True)
class BackedCoin:
    mint: str
    sol: float
    pools: int
    last_at: Optional[datetime]


SORT_SOL = "sol"
SORT_RECENT = "recent"


def backed_coins(db: Session, min_sol: float, limit: int, sort: str = SORT_SOL) -> list[BackedCoin]:
    """Coins with at least `min_sol` of counted commits: the most SOL first, or
    with `sort="recent"` the ones committed to most lately first. The main page
    asks for the ten most recent (Georgiy, 2026-10-16).

    Counted is what the rest of the site counts: confirmed or finalized, never
    an orphaned or unconfirmed one (`active_bet_condition`).
    """
    total = func.sum(BetParticipationModel.sol_amount)
    latest = func.max(BetParticipationModel.created_at)
    order = (latest.desc(), total.desc()) if sort == SORT_RECENT else (total.desc(), latest.desc())
    rows = (
        db.query(
            BetParticipationModel.meme_coin_address,
            total,
            func.count(func.distinct(BetParticipationModel.lottery_id)),
            latest,
        )
        .filter(active_bet_condition(BetParticipationModel))
        .group_by(BetParticipationModel.meme_coin_address)
        .having(total >= min_sol)
        .order_by(*order, BetParticipationModel.meme_coin_address)
        .limit(limit)
        .all()
    )
    coins = []
    for mint, sol, pools, last_at in rows:
        mint = str(mint or "").strip()
        if not mint:
            continue
        coins.append(BackedCoin(mint=mint, sol=round(float(sol or 0), 4), pools=int(pools or 0), last_at=last_at))
    return coins


def trade_link(mint: str, made_on_pump: Optional[bool]) -> tuple[str, str]:
    """Where to open a coin to trade it, and that place's name.

    Unknown (the node did not answer) falls back to the address: pump.fun gives
    its coins addresses that end in "pump". Not all of them, which is why the
    chain decides when it can.
    """
    if made_on_pump is None:
        made_on_pump = mint.endswith("pump")
    if made_on_pump:
        return f"https://pump.fun/coin/{mint}", VENUE_PUMP
    return f"https://dexscreener.com/solana/{mint}", VENUE_DEXSCREENER


def _curve_address(mint: str) -> Optional[str]:
    from solders.pubkey import Pubkey

    try:
        address, _bump = Pubkey.find_program_address(
            [b"bonding-curve", bytes(Pubkey.from_string(mint))], Pubkey.from_string(PUMP_PROGRAM)
        )
    except ValueError:
        return None
    return str(address)


def read_made_on_pump(rpc_url: str, mints: list[str], *, client: Optional[httpx.Client] = None) -> dict[str, Optional[bool]]:
    """For each mint, whether it has a pump.fun bonding curve; None where the node did not answer."""
    answers: dict[str, Optional[bool]] = {mint: None for mint in mints}
    curves = {mint: _curve_address(mint) for mint in mints}
    for mint, curve in curves.items():
        if curve is None:
            answers[mint] = False
    asked = [(mint, curve) for mint, curve in curves.items() if curve is not None]
    own_client = client is None
    http = client or httpx.Client(timeout=RPC_TIMEOUT_SECONDS)
    try:
        for start in range(0, len(asked), RPC_BATCH):
            batch = asked[start:start + RPC_BATCH]
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getMultipleAccounts",
                "params": [[curve for _mint, curve in batch], {"encoding": "base64", "dataSlice": {"offset": 0, "length": 0}}],
            }
            try:
                response = http.post(rpc_url, json=payload)
                response.raise_for_status()
                values = response.json()["result"]["value"]
            except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
                # The URL can carry an API key; the exception type is enough.
                logger.warning("backed coins: curve accounts not read (%s)", type(exc).__name__)
                continue
            for (mint, _curve), account in zip(batch, values):
                answers[mint] = bool(account) and account.get("owner") == PUMP_PROGRAM
    finally:
        if own_client:
            http.close()
    return answers


class MadeOnPumpCache:
    """Answers that are known stay known; unknown ones are asked again next time."""

    def __init__(self, reader: Callable[[list[str]], dict[str, Optional[bool]]]):
        self._reader = reader
        self._known: dict[str, bool] = {}
        self._lock = threading.Lock()

    def get(self, mints: Iterable[str]) -> dict[str, Optional[bool]]:
        mints = list(dict.fromkeys(mints))
        with self._lock:
            missing = [mint for mint in mints if mint not in self._known]
        fresh = self._reader(missing) if missing else {}
        with self._lock:
            for mint, value in fresh.items():
                if value is not None:
                    self._known[mint] = value
            return {mint: self._known.get(mint, fresh.get(mint)) for mint in mints}


class TimedCache:
    """One value per key for `seconds`: the bubbles change when someone commits, not every second.

    At most `max_items` keys. The key comes from the query (`min_sol`, `limit`,
    `sort`), so anyone can make up new ones: with nothing ever thrown out, a
    script walking `min_sol` through 1.0001, 1.0002... grew it for as long as
    it ran.
    """

    def __init__(self, seconds: float, clock: Callable[[], float] = time.monotonic, max_items: int = 64):
        self._seconds = seconds
        self._clock = clock
        self._max_items = max_items
        self._items: dict[object, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def get(self, key: object) -> Optional[object]:
        with self._lock:
            item = self._items.get(key)
            if item is None or self._clock() - item[0] > self._seconds:
                return None
            return item[1]

    def put(self, key: object, value: object) -> None:
        with self._lock:
            now = self._clock()
            self._items[key] = (now, value)
            if len(self._items) > self._max_items:
                self._items = {k: item for k, item in self._items.items() if now - item[0] <= self._seconds}
            while len(self._items) > self._max_items:
                del self._items[min(self._items, key=lambda k: self._items[k][0])]

    def clear(self) -> None:
        with self._lock:
            self._items.clear()
