"""A coin's stay in pumpling, for the window that opens from its bubble on the main page.

Asked for on 2026-10-16: pressing a coin's bubble shows its chart from the
moment it came into a pool to the moment the pool had bought it, with its
ticker, picture, mint and when it took part. A coin that took part more than
once is shown for the pool where the most SOL stood behind it.

The window is the coin's first counted commit in that pool to the pool's last
buy of it, with a few minutes either side; a finished pool that bought none of
it (or whose buys the buyer no longer has) ends when the pool closed. A pool
still open or still buying has no end yet: the window runs to now.

The candles are GeckoTerminal's. Its keyless API gives about ten calls a
minute per address ("GeckoTerminal endpoints: ~10 calls/min", CoinGecko's
"Keyless Public API" page, read 2026-10-18), refreshes candles every sixty
seconds, and keeps history for months, not for ever. So no visitor's request
reaches it. One thread in the API (`start`) asks it on a schedule, for the
coins in the bubbles, the only ones a window opens for, and keeps what it gets
in `coin_story_charts` (migration 045), which every visitor reads:

* while the coin's pool takes SOL, its chart is refreshed every five minutes;
  while the pool draws and buys, every three: that is when the pool moves
  the price, and what people look at;
* a quarter of an hour after the pool's last buy of it (GeckoTerminal's
  candles lag by up to its minute) the chart is fetched one last time with
  the buys and the share from the buyer's feed, marked final, and never asked
  again. A final chart is kept for good: it is small, GeckoTerminal's own
  history runs out, and it is the record of what the pool did;
* a chart that is not final is deleted once its coin leaves the bubbles.

Georgiy's design, 2026-10-18. Before it each visitor's window asked
GeckoTerminal itself, from a cache in memory that every deploy emptied.

It tracks pump.fun bonding curves as well as DEX pools: on 2026-10-18 it had
all four coins checked, three of them still on their curves, and the full
window of the launch pool, minute by minute.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from infrastructure.database.models.bet_participation_model import BetParticipationModel
from infrastructure.database.models.coin_story_chart_model import CoinStoryChartModel
from infrastructure.database.models.lottery_model import LotteryModel
from shared import gecko_budget
from shared.bet_confirmation import active_bet_condition

logger = logging.getLogger(__name__)

GECKO_API = "https://api.geckoterminal.com/api/v2/networks/solana"
GECKO_POOL_PAGE = "https://www.geckoterminal.com/solana/pools/{pool}"
#: Either side of the window, so the chart shows where the price came from and where it went.
PADDING = timedelta(minutes=5)
#: One candle a minute up to this long a window, five minutes beyond.
MINUTE_CANDLES_UP_TO = timedelta(hours=8)
#: The most candles one call returns.
GECKO_MAX_CANDLES = 1000
#: A coin's list of pools is asked again after this long: a coin can leave its curve for a new pool.
POOLS_SECONDS = 600
#: An empty list of pools, sooner: GeckoTerminal finds a new coin a little after it starts trading.
NO_POOLS_SECONDS = 180

#: How often a running pool's coin is fetched again: while the pool takes SOL,
#: and while it draws and buys (when the pool moves the price).
REFRESH_TAKING_SOL = timedelta(minutes=5)
REFRESH_BUYING = timedelta(minutes=3)
#: The last fetch, this long after the pool's last buy of the coin: its candles lag by up to a minute.
FINAL_AFTER = timedelta(minutes=15)
#: A final fetch that found no candles is tried again this long apart, this many times in all.
NOTHING_AGAIN_AFTER = timedelta(hours=1)
NOTHING_TRIES = 3

#: The bubbles: the page asks `/lottery/coins/backed?min_sol=1&limit=10&sort=recent`
#: (`backed-coins.service.ts`), and a window opens only from one of them.
BUBBLE_MIN_SOL = 1.0
BUBBLE_COUNT = 10
#: Calls of the minute's budget left to the hover chart on the pool page, which asks on demand.
LEAVES = 3
EVERY_SECONDS = 60

FINISHED_STATUSES = ("completed", "closed")


@dataclass(frozen=True)
class Stay:
    lottery_id: int
    sol: float
    entered_at: datetime
    status: str
    #: When the pool closed (or stopped taking SOL, if it has no close time).
    ended_at: Optional[datetime] = None

    @property
    def finished(self) -> bool:
        return self.status in FINISHED_STATUSES


@dataclass(frozen=True)
class Buy:
    at: datetime
    sol: float
    signature: str


@dataclass(frozen=True)
class Candles:
    pool: str
    #: [unix seconds, open, high, low, close, volume], oldest first, price in SOL.
    rows: list[list[float]]
    minutes: int


class GeckoBusy(Exception):
    """The minute's budget for GeckoTerminal is spent, or it said 429."""


def _utc(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def chosen_stay(db: Session, mint: str) -> Optional[Stay]:
    """The pool where the most SOL stood behind the coin; the later one when two are level."""
    total = func.sum(BetParticipationModel.sol_amount)
    rows = (
        db.query(BetParticipationModel.lottery_id, total, func.min(BetParticipationModel.created_at))
        .filter(active_bet_condition(BetParticipationModel), BetParticipationModel.meme_coin_address == mint)
        .group_by(BetParticipationModel.lottery_id)
        .all()
    )
    if not rows:
        return None
    lottery_id, sol, entered_at = max(rows, key=lambda row: (float(row[1] or 0), int(row[0])))
    lottery = (
        db.query(LotteryModel.status, LotteryModel.closed_at, LotteryModel.end_date)
        .filter(LotteryModel.id == lottery_id)
        .first()
    )
    status = getattr(lottery[0], "value", lottery[0]) if lottery else ""
    ended_at = _utc(lottery[1] or lottery[2]) if lottery else None
    return Stay(
        lottery_id=int(lottery_id),
        sol=round(float(sol or 0), 4),
        entered_at=_utc(entered_at),
        status=str(status),
        ended_at=ended_at,
    )


def _feed_time(raw: object) -> Optional[datetime]:
    """The buyer gives milliseconds; anything else is no time at all (not "now", as a feed row may)."""
    try:
        return datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def buys_of(feed: Optional[dict], mint: str) -> list[Buy]:
    """The pool's buys of this coin, oldest first, from the buyer's purchase feed (its raw answer)."""
    buys = []
    for item in (feed or {}).get("purchases") or []:
        if str(item.get("mint") or "") != mint:
            continue
        at = _feed_time(item.get("at"))
        try:
            sol = float(item.get("solAmount") or 0)
        except (TypeError, ValueError):
            continue
        signature = str(item.get("signature") or "")
        if at and sol > 0 and signature:
            buys.append(Buy(at=at, sol=sol, signature=signature))
    return sorted(buys, key=lambda buy: buy.at)


def share_of(feed: Optional[dict], mint: str) -> Optional[float]:
    """The SOL the draw gave the coin, from the buyer's feed; None when the feed has no coins at all.

    A coin with a share can still have no buys: on the stand the buyer, on
    devnet, cannot buy mainnet coins, and LETTER's 15 SOL went back to its
    backers. "The draw gave it no share" is only said when this is zero.
    """
    tokens = (feed or {}).get("tokens") or []
    if not tokens:
        return None
    for token in tokens:
        if isinstance(token, dict) and str(token.get("mint") or "") == mint:
            try:
                return max(0.0, float(token.get("targetSol") or 0))
            except (TypeError, ValueError):
                return None
    return 0.0


def refunded_of(feed: Optional[dict], mint: str) -> float:
    """The SOL of the coin's share that went back to its backers."""
    total = 0.0
    for refund in (feed or {}).get("refunds") or []:
        if not isinstance(refund, dict) or str(refund.get("mint") or "") != mint or not refund.get("signature"):
            continue
        try:
            sol = float(refund.get("sol"))
        except (TypeError, ValueError):
            continue
        if sol > 0:
            total += sol
    return total


def supply_from_feed(feed: Optional[dict], mint: str) -> Optional[float]:
    """The coin's supply before the pool burned any of it, in whole tokens; None when the feed does not say.

    The buyer records it for a coin it burns (`burn.supplyAtStart`, raw, with
    the coin's `decimals`). Read from the chain after the burn, the supply is
    smaller, and every candle from before the burn would show a market cap
    smaller than it was.
    """
    for token in (feed or {}).get("tokens") or []:
        if not isinstance(token, dict) or str(token.get("mint") or "") != mint:
            continue
        raw = (token.get("burn") or {}).get("supplyAtStart") if isinstance(token.get("burn"), dict) else None
        decimals = token.get("decimals")
        if isinstance(raw, str) and raw.isdigit() and isinstance(decimals, int) and not isinstance(decimals, bool) and 0 <= decimals <= 18:
            supply = int(raw) / 10 ** decimals
            return supply if supply > 0 else None
    return None


def burned_from_feed(feed: Optional[dict], mint: str) -> Optional[float]:
    """The tokens of the coin the pool burned, whole units; 0 when it burned none; None when the feed does not know the coin."""
    for token in (feed or {}).get("tokens") or []:
        if not isinstance(token, dict) or str(token.get("mint") or "") != mint:
            continue
        burn = token.get("burn") if isinstance(token.get("burn"), dict) else {}
        raw = burn.get("burnedRaw")
        decimals = token.get("decimals")
        if isinstance(raw, str) and raw.isdigit() and isinstance(decimals, int) and not isinstance(decimals, bool) and 0 <= decimals <= 18:
            return int(raw) / 10 ** decimals
        return 0.0
    return None


def left_at(stay: Stay, buys: list[Buy]) -> Optional[datetime]:
    """When the coin's stay ended: the pool's last buy of it, or the pool's close; None while it runs."""
    if not stay.finished:
        return None
    return buys[-1].at if buys else stay.ended_at


def window(stay: Stay, buys: list[Buy], now: datetime) -> tuple[datetime, datetime]:
    """From a little before the coin came in to a little after its stay ended; to now while the pool runs.

    A finished pool with no buys of the coin ran to now until 2026-10-18: on
    the stand that was two weeks of five-minute candles for a two-hour pool.
    """
    start = stay.entered_at - PADDING
    left = left_at(stay, buys)
    end = left + PADDING if left else now
    return start, max(start + PADDING, min(end, now))


class GeckoTerminal:
    """A coin's candles over a window, asked of GeckoTerminal within the API's one budget for it."""

    def __init__(
        self,
        fetch_json: Callable[[str], dict],
        clock: Callable[[], float] = time.monotonic,
        budget: gecko_budget.Budget = gecko_budget.BUDGET,
    ):
        self._fetch_json = fetch_json
        self._clock = clock
        self._budget = budget
        self._pools: dict[str, tuple[float, list[tuple[str, str, Optional[datetime]]]]] = {}
        self._lock = threading.Lock()

    def _ask(self, url: str) -> dict:
        if not self._budget.take():
            raise GeckoBusy("the minute's budget is spent")
        return self._fetch_json(url)

    def _pools_of(self, mint: str) -> list[tuple[str, str, Optional[datetime]]]:
        with self._lock:
            known = self._pools.get(mint)
        if known is not None and self._clock() - known[0] < (POOLS_SECONDS if known[1] else NO_POOLS_SECONDS):
            return known[1]
        body = self._ask(f"{GECKO_API}/tokens/{mint}/pools?page=1")
        pools = []
        for item in body.get("data") or []:
            attributes = item.get("attributes") or {}
            address = str(attributes.get("address") or "")
            dex = str((((item.get("relationships") or {}).get("dex") or {}).get("data") or {}).get("id") or "")
            created = attributes.get("pool_created_at")
            try:
                created_at = _utc(datetime.fromisoformat(str(created).replace("Z", "+00:00"))) if created else None
            except ValueError:
                created_at = None
            if address:
                pools.append((address, dex, created_at))
        with self._lock:
            self._pools[mint] = (self._clock(), pools)
            if len(self._pools) > 500:
                for old in sorted(self._pools, key=lambda key: self._pools[key][0])[:100]:
                    self._pools.pop(old, None)
        return pools

    def fetch(self, mint: str, start: datetime, end: datetime) -> Optional[Candles]:
        """The coin's candles over [start, end], from the pool that traded most in it; None when it has none.

        A coin that left its pump.fun curve inside the window traded on the
        curve and then on its new pool, one after the other: the two are one
        chart, as pump.fun draws it. Two pools trading side by side are not
        joined (their prices differ a little and the chart would saw), the
        one with the most volume is taken.
        """
        minutes = 1 if end - start <= MINUTE_CANDLES_UP_TO else 5
        bars = int((end - start).total_seconds() // (60 * minutes)) + 2
        limit = max(2, min(GECKO_MAX_CANDLES, bars))
        before = int(end.timestamp()) + 60 * minutes
        # A pool made after the window ends cannot hold it: a coin that graduated
        # later still traded on its curve then.
        candidates = [pool for pool in self._pools_of(mint) if pool[2] is None or pool[2] <= end][:2]
        found: list[tuple[str, str, list[list[float]], float]] = []
        for address, dex, _created in candidates:
            # The empty minutes too, as the previous close with no volume: by
            # default GeckoTerminal skips them, the coin's dot had no candle in
            # a quiet minute, and side by side the candles squeezed time.
            body = self._ask(
                f"{GECKO_API}/pools/{address}/ohlcv/minute?aggregate={minutes}&before_timestamp={before}"
                f"&limit={limit}&currency=token&token=base&include_empty_intervals=true"
            )
            rows = (((body.get("data") or {}).get("attributes") or {}).get("ohlcv_list")) or []
            inside = sorted(
                [[float(value) for value in row[:6]] for row in rows
                 if isinstance(row, list) and len(row) >= 6 and start.timestamp() - 60 * minutes <= float(row[0]) <= end.timestamp()]
            )
            if inside:
                found.append((address, dex, inside, sum(row[5] for row in inside)))
        if not found:
            return None
        most = max(found, key=lambda pool: pool[3])
        if len(found) == 2:
            # Filled, both pools run the whole window; what counts is where
            # each one traded: the curve up to its last trade, then the new
            # pool from its first.
            first, then = sorted(found, key=lambda pool: _first_trade(pool[2]))
            curve, new = _until_last_trade(first[2]), _from_first_trade(then[2])
            if first[1] == "pump-fun" and curve and new and new[0][0] >= curve[-1][0]:
                return Candles(pool=most[0], rows=_joined(curve, new), minutes=minutes)
        return Candles(pool=most[0], rows=most[2], minutes=minutes)


def _first_trade(rows: list[list[float]]) -> float:
    return next((row[0] for row in rows if row[5] > 0), float("inf"))


def _until_last_trade(rows: list[list[float]]) -> list[list[float]]:
    last = max((index for index, row in enumerate(rows) if row[5] > 0), default=-1)
    return rows[: last + 1]


def _from_first_trade(rows: list[list[float]]) -> list[list[float]]:
    first = next((index for index, row in enumerate(rows) if row[5] > 0), len(rows))
    return rows[first:]


def _joined(curve: list[list[float]], then: list[list[float]]) -> list[list[float]]:
    """The curve's candles, then the new pool's; the minute it moved in is one candle of both."""
    last = curve[-1]
    if then[0][0] == last[0]:
        shared = then[0]
        merged = [last[0], last[1], max(last[2], shared[2]), min(last[3], shared[3]), shared[4], last[5] + shared[5]]
        return curve[:-1] + [merged] + then[1:]
    return curve + then


def fetch_json_with(context: object, timeout: float) -> Callable[[str], dict]:
    """A GeckoTerminal reader over `fast_http.urlopen`, as every outside call is; a 429 becomes `GeckoBusy`."""
    import urllib.error
    import urllib.request

    from shared import fast_http

    def fetch(url: str) -> dict:
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "pumpling/1.0"})
        try:
            with fast_http.urlopen(request, timeout=timeout, context=context) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise GeckoBusy("GeckoTerminal said 429") from exc
            if exc.code == 404:
                # A coin or pool it does not know: no chart, not a failure.
                return {}
            raise
    return fetch


def stored_buys(row: CoinStoryChartModel) -> list[Buy]:
    """The buys kept with a final chart."""
    buys = []
    for item in row.buys or []:
        try:
            at = _utc(datetime.fromisoformat(str(item["at"]).replace("Z", "+00:00")))
            buys.append(Buy(at=at, sol=float(item["sol"]), signature=str(item["signature"])))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(buys, key=lambda buy: buy.at)


@dataclass(frozen=True)
class Target:
    """A coin in the bubbles, its stay, and what is kept of its chart (None when nothing)."""

    mint: str
    stay: Stay
    final: Optional[bool] = None
    has_candles: bool = False
    has_supply: bool = False
    has_burned: bool = False
    filled: bool = False
    tries: int = 0
    fetched_at: Optional[datetime] = None
    window_start: Optional[datetime] = None
    window_end: Optional[datetime] = None


def targets(db: Session) -> list[Target]:
    """The coins in the bubbles, with what is kept for each; non-final charts of other coins are deleted.

    The deleting happens here, with the list in hand: a coin that left the
    bubbles has no window to open, and its half-made chart would never be
    finished. A final chart stays.
    """
    from application.lottery import backed_coins
    from shared.settings import get_settings

    found: list[Target] = []
    hidden = get_settings().coin_bubbles_hidden_mints
    for coin in backed_coins.backed_coins(db, BUBBLE_MIN_SOL, BUBBLE_COUNT, backed_coins.SORT_RECENT, hidden=hidden):
        stay = chosen_stay(db, coin.mint)
        if stay is None:
            continue
        row = db.get(CoinStoryChartModel, (coin.mint, stay.lottery_id))
        if row is None:
            found.append(Target(coin.mint, stay))
        else:
            found.append(Target(
                coin.mint, stay, final=bool(row.final), has_candles=row.candles is not None,
                has_supply=row.supply is not None, has_burned=row.burned is not None,
                filled=bool(row.candles_filled), tries=int(row.tries or 0),
                fetched_at=_utc(row.fetched_at), window_start=_utc(row.window_start), window_end=_utc(row.window_end),
            ))
    keep = {(target.mint, target.stay.lottery_id) for target in found}
    for row in db.query(CoinStoryChartModel).filter(CoinStoryChartModel.final.is_(False)).all():
        if (row.mint, int(row.lottery_id)) not in keep:
            db.delete(row)
    db.commit()
    return found


def _order(target: Target) -> tuple:
    """Finished coins first, to make their final charts; then the longest without a fetch."""
    never = datetime.min.replace(tzinfo=timezone.utc)
    return (0 if target.stay.finished else 1, target.fetched_at or never)


def _save(
    session_factory: Callable[[], Session],
    target: Target,
    start: datetime,
    end: datetime,
    candles: Optional[Candles],
    now: datetime,
    final: bool,
    feed: Optional[dict] = None,
    buys: Optional[list[Buy]] = None,
    tries: int = 0,
    supply: Optional[float] = None,
) -> None:
    session = session_factory()
    try:
        row = session.get(CoinStoryChartModel, (target.mint, target.stay.lottery_id))
        if row is None:
            row = CoinStoryChartModel(mint=target.mint, lottery_id=target.stay.lottery_id)
            session.add(row)
        row.window_start, row.window_end = start, end
        row.pool_address = candles.pool if candles else None
        row.candle_minutes = candles.minutes if candles else None
        row.candles = candles.rows if candles else None
        row.final, row.tries, row.fetched_at = final, tries, now
        row.supply = supply
        row.candles_filled = True
        if feed is not None:
            row.burned = burned_from_feed(feed, target.mint)
        if final and feed is not None:
            row.buys = [{"at": buy.at.isoformat(), "sol": buy.sol, "signature": buy.signature} for buy in buys or []]
            row.share_sol = share_of(feed, target.mint)
            row.refunded_sol = refunded_of(feed, target.mint)
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def run_once(
    found: list[Target],
    gecko: GeckoTerminal,
    budget: gecko_budget.Budget,
    feed_of: Callable[[int], Optional[dict]],
    session_factory: Callable[[], Session],
    now: datetime,
    supply_of: Callable[[str], Optional[float]] = lambda mint: None,
) -> int:
    """Fetches what is due, within the budget less `LEAVES`; returns how many charts were saved.

    `supply_of` reads a coin's supply from the chain, for its market cap.
    """
    def supply_for(mint: str, feed: Optional[dict]) -> Optional[float]:
        try:
            return supply_from_feed(feed, mint) or supply_of(mint)
        except Exception:
            logger.warning("coin story: supply not read (mint=%s)", mint, exc_info=True)
            return None

    saved = 0
    for target in sorted(found, key=_order):
        stay = target.stay
        if target.final and target.has_candles and not (target.has_supply and target.has_burned):
            # A final chart kept before its supply or its burn was: only those
            # are asked for, from the buyer's feed or the chain; GeckoTerminal is not.
            try:
                feed = feed_of(stay.lottery_id)
            except Exception:
                feed = None
            supply = None if target.has_supply else supply_for(target.mint, feed)
            burned = None if target.has_burned else burned_from_feed(feed, target.mint)
            if supply is not None or burned is not None:
                session = session_factory()
                try:
                    row = session.get(CoinStoryChartModel, (target.mint, stay.lottery_id))
                    if row is not None:
                        if supply is not None:
                            row.supply = supply
                        if burned is not None:
                            row.burned = burned
                        session.commit()
                finally:
                    session.close()
        if target.final and not target.filled:
            # Kept before the empty minutes were asked for: asked again once,
            # over the window it was kept for. Nothing back keeps what was there.
            if budget.left() <= LEAVES:
                break
            try:
                candles = gecko.fetch(target.mint, target.window_start, target.window_end)
            except GeckoBusy:
                break
            except Exception:
                logger.warning("coin story: candles not read again (mint=%s)", target.mint, exc_info=True)
                continue
            session = session_factory()
            try:
                row = session.get(CoinStoryChartModel, (target.mint, stay.lottery_id))
                if row is not None:
                    if candles is not None:
                        row.pool_address, row.candle_minutes, row.candles = candles.pool, candles.minutes, candles.rows
                    row.candles_filled = True
                    session.commit()
            finally:
                session.close()
            saved += 1
            continue
        if target.final:
            # Final. Asked again only when GeckoTerminal had nothing, an hour apart, three times.
            if target.has_candles or target.tries >= NOTHING_TRIES or (target.fetched_at and now - target.fetched_at < NOTHING_AGAIN_AFTER):
                continue
            if budget.left() <= LEAVES:
                break
            try:
                candles = gecko.fetch(target.mint, target.window_start, target.window_end)
            except GeckoBusy:
                break
            except Exception:
                logger.warning("coin story: candles not read (mint=%s)", target.mint, exc_info=True)
                continue
            session = session_factory()
            try:
                row = session.get(CoinStoryChartModel, (target.mint, stay.lottery_id))
                if row is not None:
                    row.pool_address = candles.pool if candles else None
                    row.candle_minutes = candles.minutes if candles else None
                    row.candles = candles.rows if candles else None
                    row.tries = target.tries + (0 if candles else 1)
                    row.fetched_at = now
                    row.candles_filled = True
                    session.commit()
            finally:
                session.close()
            saved += 1
            continue

        try:
            feed = feed_of(stay.lottery_id)
        except Exception:
            feed = None
        buys = buys_of(feed, target.mint)
        left = left_at(stay, buys)
        make_final = stay.finished and feed is not None and left is not None and now >= left + FINAL_AFTER
        if not make_final:
            if stay.finished and feed is None:
                # Without the buys its window is not known: wait for the buyer.
                continue
            every = REFRESH_TAKING_SOL if stay.status == "created" else REFRESH_BUYING
            if target.fetched_at and now - target.fetched_at < every:
                continue
        if budget.left() <= LEAVES:
            break
        start, end = window(stay, buys, now)
        try:
            candles = gecko.fetch(target.mint, start, end)
        except GeckoBusy:
            break
        except Exception:
            logger.warning("coin story: candles not read (mint=%s)", target.mint, exc_info=True)
            continue
        _save(session_factory, target, start, end, candles, now, make_final, feed, buys,
              tries=0 if candles or not make_final else 1, supply=supply_for(target.mint, feed) if candles else None)
        saved += 1
    return saved


_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def start(
    session_factory: Callable[[], Session],
    gecko: GeckoTerminal,
    feed_of: Callable[[int], Optional[dict]],
    budget: gecko_budget.Budget = gecko_budget.BUDGET,
    supply_of: Callable[[str], Optional[float]] = lambda mint: None,
) -> None:
    """The thread in the API that keeps the bubbles' charts, once a minute."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()

    def loop() -> None:
        while not _stop.wait(EVERY_SECONDS):
            session = session_factory()
            try:
                found = targets(session)
            except Exception:
                session.rollback()
                logger.warning("coin story: no bubbles", exc_info=True)
                continue
            finally:
                # The network is waited on with the connection handed back.
                session.close()
            try:
                run_once(found, gecko, budget, feed_of, session_factory, datetime.now(timezone.utc), supply_of)
            except Exception:
                logger.warning("coin story pass failed", exc_info=True)

    _thread = threading.Thread(target=loop, name="coin-story-charts", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()
