-- A wallet belongs to an account. Before this, a commit's owner was derived
-- from the address two incompatible ways: wallet sign-in created a user
-- wallet_<lowercased address>@wallet.local, while the events worker created
-- wallet_<address>@onchain.local. Whoever recorded the commit first decided the
-- user_id, so the field lied.

CREATE TABLE IF NOT EXISTS user_wallets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    wallet_address VARCHAR(64) NOT NULL,
    -- 'signature' — the person signed in with this wallet,
    -- 'deposit' — the wallet committed SOL while the person was signed in.
    linked_via VARCHAR(16) NOT NULL DEFAULT 'signature',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_wallets_address UNIQUE (wallet_address)
);

CREATE INDEX IF NOT EXISTS ix_user_wallets_user_id ON user_wallets (user_id);

-- Old accounts created by signature sign-in: we take the address from the
-- commits, because in the email it is lowercased and base58 is case sensitive.
INSERT INTO user_wallets (user_id, wallet_address, linked_via)
SELECT DISTINCT ON (b.wallet_address) u.id, b.wallet_address, 'signature'
FROM bet_participations b
JOIN users u ON u.email = 'wallet_' || lower(b.wallet_address) || '@wallet.local'
ORDER BY b.wallet_address, u.id
ON CONFLICT (wallet_address) DO NOTHING;

-- Commits from the same wallet that the worker recorded against a shadow
-- account move to the real one.
UPDATE bet_participations b
SET user_id = w.user_id
FROM user_wallets w
WHERE b.wallet_address = w.wallet_address
  AND b.user_id <> w.user_id;
