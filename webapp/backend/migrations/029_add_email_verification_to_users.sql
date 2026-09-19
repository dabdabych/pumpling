ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT NULL,
    ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ NULL;

UPDATE users
SET email_verified_at = COALESCE(email_verified_at, updated_at, created_at, NOW())
WHERE is_active = TRUE
  AND is_email_verified = TRUE
  AND email_verified_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_verification_token_hash
    ON users (email_verification_token_hash)
    WHERE email_verification_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_email_verification_expires_at
    ON users (email_verification_expires_at);
