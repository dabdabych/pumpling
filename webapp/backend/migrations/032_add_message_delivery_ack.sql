ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS client_message_id UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_sender_chat_client_message_id
    ON messages (sender_id, chat_id, client_message_id)
    WHERE client_message_id IS NOT NULL;
