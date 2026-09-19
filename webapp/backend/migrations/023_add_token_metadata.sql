CREATE TABLE IF NOT EXISTS token_metadata (
    mint VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255),
    symbol VARCHAR(64),
    logo_url VARCHAR(1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_token_metadata_mint ON token_metadata (mint);
