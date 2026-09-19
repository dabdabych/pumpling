CREATE TABLE IF NOT EXISTS wallet_auth_nonces (
    nonce TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_auth_nonces_wallet_address
    ON wallet_auth_nonces (wallet_address);

CREATE INDEX IF NOT EXISTS idx_wallet_auth_nonces_expires_at
    ON wallet_auth_nonces (expires_at);
