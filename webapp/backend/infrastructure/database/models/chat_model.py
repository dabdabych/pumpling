from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    desc,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from infrastructure.database.database import Base


class ChatModel(Base):
    __tablename__ = "chats"

    id = Column(Integer, primary_key=True)
    slug = Column(String(64), unique=True, nullable=False, index=True)
    title = Column(String(128), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ChatMessageModel(Base):
    __tablename__ = "messages"
    __table_args__ = (
        CheckConstraint(
            "char_length(btrim(content)) <= 2000 AND "
            "(char_length(btrim(content)) >= 1 OR attachment_id IS NOT NULL)",
            name="ck_messages_content_length",
        ),
        Index("ix_messages_chat_id_id", "chat_id", desc("id")),
        Index("ux_messages_sender_chat_client_message_id", "sender_id", "chat_id", "client_message_id", unique=True),
    )

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    chat_id = Column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    sender_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    reply_to_id = Column(BigInteger, ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    client_message_id = Column(UUID(as_uuid=False), nullable=False)
    attachment_id = Column(UUID(as_uuid=False), ForeignKey("chat_attachments.id", ondelete="RESTRICT"), nullable=True)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ChatAttachmentModel(Base):
    __tablename__ = "chat_attachments"
    __table_args__ = (
        CheckConstraint(
            "mime_type IN ('image/gif', 'image/png', 'image/jpeg', 'image/webp')",
            name="ck_chat_attachments_mime_type",
        ),
        CheckConstraint(
            "byte_size > 0 AND byte_size <= 5242880",
            name="ck_chat_attachments_byte_size",
        ),
    )

    id = Column(UUID(as_uuid=False), primary_key=True)
    chat_id = Column(Integer, ForeignKey("chats.id", ondelete="CASCADE"), nullable=False)
    uploader_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    mime_type = Column(String(64), nullable=False)
    byte_size = Column(Integer, nullable=False)
    content = Column(LargeBinary, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
