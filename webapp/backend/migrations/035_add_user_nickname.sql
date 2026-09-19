ALTER TABLE users
    ADD COLUMN IF NOT EXISTS nickname VARCHAR(32);

UPDATE users
SET nickname = 'user_' || id
WHERE nickname IS NULL OR btrim(nickname) = '';

ALTER TABLE users
    ALTER COLUMN nickname SET NOT NULL;

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS ck_users_nickname_format;

ALTER TABLE users
    ADD CONSTRAINT ck_users_nickname_format
    CHECK (nickname ~ '^[A-Za-z0-9_]{3,32}$');

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_nickname_lower
    ON users (lower(nickname));
