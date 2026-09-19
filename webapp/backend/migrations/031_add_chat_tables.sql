CREATE TABLE IF NOT EXISTS chats (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reply_to_id BIGINT NULL REFERENCES messages(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_messages_content_length CHECK (char_length(btrim(content)) BETWEEN 1 AND 2000)
);

-- Supports keyset pagination: GET /chats/{chat_id}/messages?before_id=...&limit=150
CREATE INDEX IF NOT EXISTS ix_messages_chat_id_id
    ON messages (chat_id, id DESC);

CREATE INDEX IF NOT EXISTS ix_messages_reply_to_id
    ON messages (reply_to_id)
    WHERE reply_to_id IS NOT NULL;

INSERT INTO chats (slug, title)
VALUES ('general', 'General chat')
ON CONFLICT (slug) DO NOTHING;
