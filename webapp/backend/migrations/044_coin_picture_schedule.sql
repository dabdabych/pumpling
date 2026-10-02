-- When to look for a coin's picture again.
--
-- A coin search asks only the free sources, for two seconds at most, and a coin
-- can be committed to before its picture is anywhere. After a confirmed commit
-- the API looks again on a schedule (`shared/coin_picture_fill.py`). The
-- schedule used to live in the API's memory, ran only while the coin's pool was
-- on screen, and was lost on every restart; here it survives both.
ALTER TABLE token_metadata ADD COLUMN IF NOT EXISTS logo_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_metadata ADD COLUMN IF NOT EXISTS logo_next_attempt_at TIMESTAMPTZ;
