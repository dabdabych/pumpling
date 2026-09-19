ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT NULL,
    ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_password_reset_token_hash
    ON users (password_reset_token_hash)
    WHERE password_reset_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_expires_at
    ON users (password_reset_expires_at);
