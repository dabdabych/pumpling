-- A coin's red-flag check, once per coin per pool, at the first commit to it.
--
-- The coin-screening worker makes a pending row for every coin that gets a
-- confirmed commit, checks it once and records the outcome: `clean`, `flagged`
-- with the reasons, or `unavailable` when there was nothing to go on. The site
-- shows the first two next to the ticker and nothing for the last. The rule
-- and its sources are in `shared/coin_screening.py`.
--
-- JSON for the two lists rather than arrays: the tests run the same model on
-- SQLite.
CREATE TABLE IF NOT EXISTS coin_screenings (
    lottery_id BIGINT NOT NULL REFERENCES lotteries(id) ON DELETE CASCADE,
    mint VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    reasons JSON NOT NULL DEFAULT '[]',
    missing JSON NOT NULL DEFAULT '[]',
    source VARCHAR(32),
    first_commit_at TIMESTAMPTZ NOT NULL,
    checked_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lottery_id, mint),
    CONSTRAINT coin_screenings_status_known CHECK (status IN ('pending', 'clean', 'flagged', 'unavailable'))
);

-- The worker's queue: pending rows by when they are due.
CREATE INDEX IF NOT EXISTS ix_coin_screenings_due
    ON coin_screenings (next_attempt_at)
    WHERE status = 'pending';
