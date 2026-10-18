-- Two things kept with a coin's chart, both Georgiy's asks of 2026-10-18.
--
-- `burned`: how many of the coin's tokens the pool burned, in whole tokens,
-- from the buyer's feed (`burn.burnedRaw`); 0 when it burned none. The window
-- says it instead of the few lamports of SOL that went back.
--
-- `candles_filled`: the candles were asked with GeckoTerminal's
-- `include_empty_intervals`. By default it skips the minutes with no trades,
-- so a coin that came into the pool in a quiet minute had no candle for its
-- dot, and the chart, which draws candles side by side, showed sixteen trades
-- over an hour and a half as sixteen minutes. Charts kept before are asked
-- again once.
ALTER TABLE coin_story_charts ADD COLUMN IF NOT EXISTS burned DOUBLE PRECISION;
ALTER TABLE coin_story_charts ADD COLUMN IF NOT EXISTS candles_filled BOOLEAN NOT NULL DEFAULT FALSE;
