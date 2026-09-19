CREATE TABLE IF NOT EXISTS chat_attachments (
    id UUID PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    mime_type VARCHAR(64) NOT NULL,
    byte_size INTEGER NOT NULL,
    content BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_chat_attachments_gif_mime_type CHECK (mime_type = 'image/gif'),
    CONSTRAINT ck_chat_attachments_byte_size CHECK (byte_size > 0 AND byte_size <= 5242880)
);

ALTER TABLE chat_attachments
    DROP CONSTRAINT IF EXISTS ck_chat_attachments_gif_mime_type,
    DROP CONSTRAINT IF EXISTS ck_chat_attachments_byte_size;

ALTER TABLE chat_attachments
    ADD CONSTRAINT ck_chat_attachments_gif_mime_type CHECK (mime_type = 'image/gif'),
    ADD CONSTRAINT ck_chat_attachments_byte_size CHECK (byte_size > 0 AND byte_size <= 5242880);

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS attachment_id UUID NULL REFERENCES chat_attachments(id) ON DELETE RESTRICT;

ALTER TABLE messages
    DROP CONSTRAINT IF EXISTS ck_messages_content_length;

ALTER TABLE messages
    ADD CONSTRAINT ck_messages_content_length CHECK (
        char_length(btrim(content)) <= 2000
        AND (char_length(btrim(content)) >= 1 OR attachment_id IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS ix_chat_attachments_chat_id_id
    ON chat_attachments (chat_id, id);
