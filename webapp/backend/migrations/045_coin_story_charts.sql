-- A coin's chart over its stay in a pool, for the window its bubble opens.
--
-- GeckoTerminal gives about ten calls a minute per address, and its history
-- does not go back for ever. So the candles are asked by one thread in the API
-- on a schedule (`application/lottery/coin_story.py`), kept here, and every
-- visitor reads them from here: no visitor's request reaches GeckoTerminal.
-- While the pool runs the row is refreshed; a quarter of an hour after the
-- pool's last buy of the coin it is fetched one last time and marked `final`,
-- with the buys and the share from the buyer's feed, and never asked again.
-- A row that is not final is deleted once its coin is out of the bubbles.
--
-- JSON rather than arrays: the tests run the same model on SQLite.
CREATE TABLE IF NOT EXISTS coin_story_charts (
    mint VARCHAR(64) NOT NULL,
    lottery_id BIGINT NOT NULL REFERENCES lotteries(id) ON DELETE CASCADE,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    pool_address VARCHAR(64),
    candle_minutes INTEGER,
    candles JSON,
    buys JSON,
    share_sol DOUBLE PRECISION,
    refunded_sol DOUBLE PRECISION,
    final BOOLEAN NOT NULL DEFAULT FALSE,
    tries INTEGER NOT NULL DEFAULT 0,
    fetched_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (mint, lottery_id)
);
