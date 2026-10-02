"""Red flags on a coin, checked once, at the first commit to it in a pool.

What this is for. A pool is an announced buy that cannot be called off, which
makes it perfect exit liquidity for whoever holds a lot of the coin. The screen
shows the obvious cases on the site, in the card behind the mark next to the
ticker, and nothing more: the pool still buys a flagged coin, the commits are
the participants' own call. It
does not play cat and mouse with careful launchers. A launcher who spreads the
supply across fresh wallets will pass, and that is accepted.

The rule. Each of these is a flag on its own:

- the creator holds over 20% of the supply;
- launch bundles still hold over 20%;
- bundled wallets bought over half the supply at launch and still hold over 5%;
- wallets linked to the creator hold over 15%;
- on a live pump.fun curve, the ten largest holders hold over 40%;
- off the curve, the liquidity was pulled;
- the mint lets its issuer freeze holders, mint more, take or burn holders'
  tokens, block transfers or start new accounts frozen (`mint_validator.
  mint_red_flags`, read from the chain, no provider involved).

Why these. The first version needed a cluster backed by a top ten over 40%. On
2026-10-02 it called Krackpot (7vG1Dr…NB7i) clean while pump.fun showed its
bundlers at 30% and its top ten at 28%, both in red: 79 bundled wallets had
bought 78.5% of the supply at launch and were selling it into the buyers.
Bundlers over 20% is the top level of tracced's own cut, and pump.fun showed
Krackpot's 30% in red, so it flags on its own now. A bundled launch alone is
not: it was over half the supply on 62 of 127 live coins, GOIF, UDR and AROS
among them. With bundlers still holding a
share, it is the Krackpot pattern, and it stays visible after they have sold
most of it.

The top ten counts only on the curve. There, every holder is a buyer of the
coin. Off it, exchanges, lockers and vesting put every large coin over 20%
(BONK, WIF, POPCAT, Fartcoin, PUMP). Over 20% on the curve was a quarter of all
fresh coins, which would make the mark mean nothing; over 40% is plain.

Liquidity counts only off the curve: a pump.fun curve cannot be pulled, and a
provider's `rugged` on one means it was sold out, which a coin at $4 shows
without our help.

On the 127 live coins of the calibration it flags 18: 14 for a bundled launch
whose bundlers still held a share (all of them under a day old), 4 for
bundlers over 20%, 1 for a creator with 79%. Of the 20 coins over $100k and
older than a day, it flags one, VSOF, whose bundlers still held over 20%.

Where the holdings come from. tracced (tracced.xyz) first, Solana Tracker's
Data API directly when tracced does not answer. tracced is a layer over the
same Solana Tracker endpoint, so both give the same numbers; the levels below
use tracced's cuts, so a coin gets the same answer from either path. A source
that has no data on a coin is not asked twice: the other one reads the same data.

What a check can end as: `clean` (no flag, and the creator's share was known),
`flagged`, or `unavailable` (nothing to show). The site shows nothing for the
last one, exactly as before the screen existed. Either way the levels are kept,
so the site can show what was read, not a verdict.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

TRACCED_URL = "https://tracced.xyz/api/v1/check"
SOLANA_TRACKER_URL = "https://data.solanatracker.io/tokens/{mint}"

#: The shares that make a level, in percent of the supply: under the first is
#: low, up to the second is medium, above it high. tracced's own cuts
#: (`partner_api.CUTS` in its source), so both paths agree.
CUTS = {
    "dev": (5.0, 20.0),
    "bundle": (5.0, 20.0),
    "bundled_launch": (20.0, 50.0),
    "top10": (20.0, 40.0),
    "insiders": (5.0, 15.0),
}
HOLDER_RULES = tuple(CUTS)

#: A coin younger than this is checked when it reaches this age: a launch bundle
#: lands over a few blocks, and a check in the first seconds would see half of it.
MIN_AGE_MINUTES = 2.0

#: Every reason a coin can be flagged for, in the order the site lists them.
REASONS = (
    "creator_over_20",
    "bundles_over_20",
    "bundled_launch",
    "insiders_over_15",
    "top10_over_40_on_curve",
    "liquidity_pulled",
    "freeze_authority",
    "mint_authority",
    "permanent_delegate",
    "non_transferable",
    "frozen_by_default",
    "pausable",
)

SOURCE_TRACCED = "tracced"
SOURCE_SOLANA_TRACKER = "solana_tracker"
SOURCE_CHAIN = "chain"


@dataclass(frozen=True)
class HolderView:
    """What a provider says about who holds the coin, as levels."""

    dev: str
    bundle: str
    top10: str
    insiders: str
    rugged: bool
    age_minutes: Optional[float]
    source: str
    bundled_launch: str = "unknown"

    def missing(self) -> list[str]:
        """The holder rules the provider had no data for."""
        return [rule for rule in HOLDER_RULES if getattr(self, rule) == "unknown"]

    def levels(self) -> dict[str, str]:
        return {rule: getattr(self, rule) for rule in HOLDER_RULES}


@dataclass(frozen=True)
class ChainRead:
    """The mint account as read: `read` with its flags, `missing` (no such mint
    on this network), or `failed` (the node did not answer)."""

    state: str
    flags: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Decision:
    """`clean`, `flagged`, or None when there is not enough to say either."""

    status: Optional[str]
    reasons: list[str] = field(default_factory=list)
    source: Optional[str] = None


def _pct(value: Any) -> Optional[float]:
    """A share in percent; None when unknown. Over 100 is a source glitch, so it is capped."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    return max(0.0, min(100.0, float(value)))


def level(rule: str, value: Any) -> str:
    share = _pct(value)
    if share is None:
        return "unknown"
    low, high = CUTS[rule]
    if share < low:
        return "low"
    return "medium" if share <= high else "high"


def _known_level(value: Any) -> str:
    return value if value in ("low", "medium", "high") else "unknown"


def holders_from_tracced(body: Any) -> Optional[HolderView]:
    """tracced's answer as levels, or None if it is not an answer."""
    if not isinstance(body, dict) or not isinstance(body.get("levels"), dict):
        return None
    levels = body["levels"]
    failed = body.get("failed") if isinstance(body.get("failed"), list) else []
    age = body.get("age_minutes")
    return HolderView(
        dev=_known_level(levels.get("dev")),
        bundle=_known_level(levels.get("bundle")),
        bundled_launch=_known_level(levels.get("bundled_launch")),
        top10=_known_level(levels.get("top10")),
        insiders=_known_level(levels.get("insiders")),
        rugged="rugged" in failed,
        age_minutes=float(age) if isinstance(age, (int, float)) and not isinstance(age, bool) else None,
        source=SOURCE_TRACCED,
    )


def holders_from_solana_tracker(body: Any, now_s: Optional[float] = None) -> Optional[HolderView]:
    """Solana Tracker's `/tokens/{mint}` as levels, with tracced's cuts; None if it has no risk data.

    The fields are the ones tracced reads (`partner_api.facts` in its source).
    """
    if not isinstance(body, dict):
        return None
    risk = body.get("risk")
    if not isinstance(risk, dict) or not risk:
        return None
    bundlers = risk.get("bundlers") if isinstance(risk.get("bundlers"), dict) else {}
    created = ((body.get("token") or {}).get("creation") or {}).get("created_time")
    now_s = time.time() if now_s is None else now_s
    age = (now_s - created) / 60 if isinstance(created, (int, float)) and not isinstance(created, bool) else None
    return HolderView(
        dev=level("dev", (risk.get("dev") or {}).get("percentage")),
        bundle=level("bundle", bundlers.get("totalPercentage")),
        bundled_launch=level("bundled_launch", bundlers.get("totalInitialPercentage")),
        top10=level("top10", risk.get("top10")),
        insiders=level("insiders", (risk.get("insiders") or {}).get("totalPercentage")),
        rugged=bool(risk.get("rugged")),
        age_minutes=age,
        source=SOURCE_SOLANA_TRACKER,
    )


def decide(chain_flags: Optional[list[str]], holders: Optional[HolderView], on_curve: Optional[bool] = None) -> Decision:
    """The rule. `chain_flags` is None when the mint could not be read;
    `on_curve` is whether the coin trades on a live pump.fun curve, None if unknown.

    Clean needs both halves: the mint read, and the creator's share known.
    """
    reasons: list[str] = []
    if holders is not None:
        if holders.dev == "high":
            reasons.append("creator_over_20")
        if holders.bundle == "high":
            reasons.append("bundles_over_20")
        elif holders.bundled_launch == "high" and holders.bundle == "medium":
            reasons.append("bundled_launch")
        if holders.insiders == "high":
            reasons.append("insiders_over_15")
        if on_curve is True and holders.top10 == "high":
            reasons.append("top10_over_40_on_curve")
        if on_curve is False and holders.rugged:
            reasons.append("liquidity_pulled")
    holder_reasons = bool(reasons)
    reasons.extend(flag for flag in (chain_flags or []) if flag in REASONS)
    reasons = [reason for reason in REASONS if reason in reasons]
    if reasons:
        return Decision("flagged", reasons, holders.source if holder_reasons and holders is not None else SOURCE_CHAIN)
    if chain_flags is not None and holders is not None and holders.dev != "unknown":
        return Decision("clean", [], holders.source)
    return Decision(None)


# ----------------------------------------------------------------- providers

@dataclass(frozen=True)
class ProviderAnswer:
    """`answer` with holders, `no_data` (the source does not know the coin),
    `rejected` (our key is not accepted) or `failed` (try again later)."""

    kind: str
    holders: Optional[HolderView] = None
    status_code: Optional[int] = None


async def ask_tracced(client: httpx.AsyncClient, mint: str, key: str) -> ProviderAnswer:
    try:
        response = await client.get(TRACCED_URL, params={"mint": mint}, headers={"Authorization": f"Bearer {key}"})
    except httpx.HTTPError as exc:
        logger.warning("tracced did not answer (mint=%s): %s", mint, type(exc).__name__)
        return ProviderAnswer("failed")
    code = response.status_code
    if code == 200:
        try:
            holders = holders_from_tracced(response.json())
        except ValueError:
            holders = None
        return ProviderAnswer("answer", holders, code) if holders else ProviderAnswer("failed", status_code=code)
    if code in (400, 404):
        return ProviderAnswer("no_data", status_code=code)
    if code in (401, 403):
        return ProviderAnswer("rejected", status_code=code)
    return ProviderAnswer("failed", status_code=code)


async def ask_solana_tracker(client: httpx.AsyncClient, mint: str, key: str) -> ProviderAnswer:
    try:
        response = await client.get(SOLANA_TRACKER_URL.format(mint=mint), headers={"x-api-key": key})
    except httpx.HTTPError as exc:
        logger.warning("Solana Tracker did not answer (mint=%s): %s", mint, type(exc).__name__)
        return ProviderAnswer("failed")
    code = response.status_code
    if code == 200:
        try:
            holders = holders_from_solana_tracker(response.json())
        except ValueError:
            return ProviderAnswer("failed", status_code=code)
        return ProviderAnswer("answer", holders, code) if holders else ProviderAnswer("no_data", status_code=code)
    if code in (400, 404):
        return ProviderAnswer("no_data", status_code=code)
    if code in (401, 403):
        return ProviderAnswer("rejected", status_code=code)
    return ProviderAnswer("failed", status_code=code)


async def ask_providers(
    client: httpx.AsyncClient,
    mint: str,
    *,
    tracced_key: Optional[str],
    solana_tracker_key: Optional[str],
) -> tuple[ProviderAnswer, list[tuple[str, ProviderAnswer]]]:
    """tracced, then Solana Tracker. The first answer, plus every attempt by source.

    `no_data` from one source ends it: the other reads the same data.
    """
    attempts: list[tuple[str, ProviderAnswer]] = []
    if tracced_key:
        answer = await ask_tracced(client, mint, tracced_key)
        attempts.append((SOURCE_TRACCED, answer))
        if answer.kind in ("answer", "no_data"):
            return answer, attempts
    if solana_tracker_key:
        answer = await ask_solana_tracker(client, mint, solana_tracker_key)
        attempts.append((SOURCE_SOLANA_TRACKER, answer))
        return answer, attempts
    return (attempts[-1][1] if attempts else ProviderAnswer("failed")), attempts


class DailyBudget:
    """Calls a day to a source with a monthly allowance, counted in UTC days.

    Solana Tracker's free plan is 2,500 requests a month, about 80 a day, and
    it is the fallback: it is asked only when tracced does not answer. A day
    tracced is down would otherwise send every retry of every coin there and
    spend the month in a few days. Kept in memory: a restart starts the day's
    count again, which a deploy a day cannot turn into much.
    """

    def __init__(self, per_day: int):
        self.per_day = max(0, int(per_day))
        self._day: Optional[str] = None
        self._used = 0
        self._spent_out = False

    def _roll(self, now_s: float) -> None:
        day = time.strftime("%Y-%m-%d", time.gmtime(now_s))
        if day != self._day:
            self._day, self._used, self._spent_out = day, 0, False

    def available(self, now_s: Optional[float] = None) -> bool:
        self._roll(time.time() if now_s is None else now_s)
        return not self._spent_out and self._used < self.per_day

    def spend(self, now_s: Optional[float] = None) -> None:
        self._roll(time.time() if now_s is None else now_s)
        self._used += 1

    def spent_out(self, now_s: Optional[float] = None) -> None:
        """The source said the allowance is gone (429): no more calls today."""
        self._roll(time.time() if now_s is None else now_s)
        self._spent_out = True


# ----------------------------------------------------------------- the chain

async def read_chain(rpc: Any, mint: str) -> ChainRead:
    """The mint's own red flags (`mint_validator.mint_red_flags`), read with `rpc.get_account`.

    An address that is no mint on this network is `missing`, not `failed`:
    asking again would not change it.
    """
    from solders.pubkey import Pubkey

    from mint_validator import mint_red_flags
    from shared.solana_rpc import SolanaRpcError, SolanaRpcTransportError

    try:
        account = await rpc.get_account(mint)
    except (SolanaRpcError, SolanaRpcTransportError) as exc:
        logger.warning("mint not read (mint=%s): %s", mint, exc)
        return ChainRead("failed")
    if account is None:
        return ChainRead("missing")
    owner, data = account
    try:
        flags = mint_red_flags(Pubkey.from_string(owner), data)
    except ValueError:
        return ChainRead("missing")
    return ChainRead("missing") if flags is None else ChainRead("read", flags)


async def read_curve(rpc: Any, mint: str) -> Optional[bool]:
    """Whether the coin trades on a live pump.fun curve: its bonding curve exists and is not complete.

    False for a coin with no pump.fun curve or one that has graduated, None
    when the node did not answer.
    """
    from solders.pubkey import Pubkey

    from mint_validator import PUMP_PROGRAM_ID, is_bonding_curve_complete
    from shared.solana_rpc import SolanaRpcError, SolanaRpcTransportError

    try:
        curve, _bump = Pubkey.find_program_address([b"bonding-curve", bytes(Pubkey.from_string(mint))], PUMP_PROGRAM_ID)
    except ValueError:
        return False
    try:
        account = await rpc.get_account(str(curve))
    except (SolanaRpcError, SolanaRpcTransportError) as exc:
        logger.warning("curve not read (mint=%s): %s", mint, exc)
        return None
    if account is None:
        return False
    owner, data = account
    if owner != str(PUMP_PROGRAM_ID):
        return False
    return not is_bonding_curve_complete(data)

