from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class ChatResponse(BaseModel):
    id: int
    slug: str
    title: str


class MessageAuthorResponse(BaseModel):
    id: int
    name: str


class ReplyPreviewResponse(BaseModel):
    id: int
    author_name: str
    content: str


class ChatAttachmentResponse(BaseModel):
    id: str
    mime_type: str


class ChatMessageResponse(BaseModel):
    id: int
    chat_id: int
    content: str
    created_at: datetime
    author: MessageAuthorResponse
    reply_to: Optional[ReplyPreviewResponse] = None
    attachment: Optional[ChatAttachmentResponse] = None


class ChatMessagesPageResponse(BaseModel):
    items: list[ChatMessageResponse]
    has_more: bool


class WebSocketCreateMessage(BaseModel):
    type: str
    client_message_id: UUID
    content: str = Field(default="", max_length=2000)
    reply_to_id: Optional[int] = Field(default=None, gt=0)
    attachment_id: Optional[UUID] = None
