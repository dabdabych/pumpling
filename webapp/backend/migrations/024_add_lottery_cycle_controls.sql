CREATE TABLE IF NOT EXISTS lottery_cycle_controls (
    lottery_type VARCHAR(32) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    stop_requested_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO lottery_cycle_controls (lottery_type, enabled)
VALUES ('pumpfun', TRUE), ('dex', TRUE)
ON CONFLICT (lottery_type) DO NOTHING;

