ALTER TABLE chat_attachments
    DROP CONSTRAINT IF EXISTS ck_chat_attachments_gif_mime_type,
    DROP CONSTRAINT IF EXISTS ck_chat_attachments_mime_type;

ALTER TABLE chat_attachments
    ADD CONSTRAINT ck_chat_attachments_mime_type
    CHECK (mime_type IN ('image/gif', 'image/png', 'image/jpeg', 'image/webp'));
