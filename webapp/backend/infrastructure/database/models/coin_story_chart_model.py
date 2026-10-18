from sqlalchemy import JSON, BigInteger, Boolean, Column, DateTime, Float, ForeignKey, Integer, String

from infrastructure.database.database import Base


class CoinStoryChartModel(Base):
    """A coin's chart over its stay in a pool (migration 045, `application/lottery/coin_story.py`).

    Fetched from GeckoTerminal by one thread on a schedule and read by every
    visitor. `final` once the pool's buys of the coin are a quarter of an hour
    old: then it carries the buys and the share too, and is never asked again.
    `candles` is null when GeckoTerminal had none for the window.
    """

    __tablename__ = "coin_story_charts"

    mint = Column(String(64), primary_key=True)
    lottery_id = Column(BigInteger, ForeignKey("lotteries.id", ondelete="CASCADE"), primary_key=True)
    window_start = Column(DateTime(timezone=True), nullable=False)
    window_end = Column(DateTime(timezone=True), nullable=False)
    pool_address = Column(String(64), nullable=True)
    candle_minutes = Column(Integer, nullable=True)
    #: [unix seconds, open, high, low, close, volume], oldest first, price in SOL.
    candles = Column(JSON, nullable=True)
    #: Final rows only: [{"at": iso, "sol": float, "signature": str}], from the buyer's feed.
    buys = Column(JSON, nullable=True)
    share_sol = Column(Float, nullable=True)
    refunded_sol = Column(Float, nullable=True)
    final = Column(Boolean, nullable=False, default=False, server_default="false")
    #: Final fetches that found no candles; asked again an hour apart, three times at most.
    tries = Column(Integer, nullable=False, default=0, server_default="0")
    fetched_at = Column(DateTime(timezone=True), nullable=False)
