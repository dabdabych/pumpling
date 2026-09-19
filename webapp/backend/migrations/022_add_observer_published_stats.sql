CREATE TABLE IF NOT EXISTS observer_published_stats (
    id SERIAL PRIMARY KEY,
    lottery_id BIGINT NOT NULL,
    mint VARCHAR(255) NOT NULL,
    observed_from BIGINT NOT NULL,
    initial_price DOUBLE PRECISION NOT NULL,
    max_price DOUBLE PRECISION NOT NULL,
    growth_pct DOUBLE PRECISION NOT NULL,
    display_growth_pct DOUBLE PRECISION NOT NULL,
    publish BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL,
    CONSTRAINT uq_observer_published_stats_lottery_mint UNIQUE (lottery_id, mint)
);

CREATE INDEX IF NOT EXISTS ix_observer_published_stats_lottery_id
    ON observer_published_stats (lottery_id);

CREATE INDEX IF NOT EXISTS ix_observer_published_stats_mint
    ON observer_published_stats (mint);
