import asyncio
import json
import os
import time
from uuid import uuid4
from collections import defaultdict, deque
from dataclasses import dataclass
from threading import Lock
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from application.chat.schemas import (
    ChatAttachmentResponse,
    ChatMessageResponse,
    ChatMessagesPageResponse,
    ChatResponse,
    MessageAuthorResponse,
    ReplyPreviewResponse,
    WebSocketCreateMessage,
)
from infrastructure.database.database import SessionLocal, get_db
from infrastructure.database.models.chat_model import ChatAttachmentModel, ChatMessageModel, ChatModel
from infrastructure.database.models.user_model import UserModel
from presentation.auth.auth_router import get_current_user, jwt_handler


router = APIRouter(prefix="/chats", tags=["chat"])
ws_router = APIRouter(tags=["chat"])

DEFAULT_CHAT_SLUG = "general"
DEFAULT_CHAT_TITLE = "General chat"
MAX_MESSAGE_LENGTH = 2000
MAX_WS_PAYLOAD_BYTES = 8 * 1024
MAX_GIF_UPLOAD_BYTES = 5 * 1024 * 1024
ALLOWED_IMAGE_MIME_TYPES = {"image/gif", "image/png", "image/jpeg", "image/webp"}
GIF_UPLOAD_RATE_LIMIT_COUNT = max(1, int(os.getenv("CHAT_GIF_UPLOAD_RATE_LIMIT_COUNT", "6")))
GIF_UPLOAD_RATE_LIMIT_WINDOW_SECONDS = max(1, int(os.getenv("CHAT_GIF_UPLOAD_RATE_LIMIT_WINDOW_SECONDS", "60")))
GIF_UPLOAD_HOURLY_LIMIT_COUNT = max(1, int(os.getenv("CHAT_GIF_UPLOAD_HOURLY_LIMIT_COUNT", "30")))
MESSAGE_RATE_LIMIT_COUNT = max(1, int(os.getenv("CHAT_MESSAGE_RATE_LIMIT_COUNT", "6")))
MESSAGE_RATE_LIMIT_WINDOW_SECONDS = max(1, int(os.getenv("CHAT_MESSAGE_RATE_LIMIT_WINDOW_SECONDS", "10")))
MESSAGE_HOURLY_LIMIT_COUNT = max(1, int(os.getenv("CHAT_MESSAGE_HOURLY_LIMIT_COUNT", "120")))


def _author_name(user: Optional[UserModel]) -> str:
    if not user:
        return "Deleted user"
    return user.nickname or f"User {user.id}"


def _get_or_create_default_chat(db: Session) -> ChatModel:
    chat = db.query(ChatModel).filter(ChatModel.slug == DEFAULT_CHAT_SLUG).first()
    if chat:
        return chat

    chat = ChatModel(slug=DEFAULT_CHAT_SLUG, title=DEFAULT_CHAT_TITLE)
    db.add(chat)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent first request may have created the singleton chat.
        db.rollback()
        chat = db.query(ChatModel).filter(ChatModel.slug == DEFAULT_CHAT_SLUG).first()
        if chat:
            return chat
        raise
    db.refresh(chat)
    return chat


def _get_chat_or_404(db: Session, chat_id: int) -> ChatModel:
    chat = db.get(ChatModel, chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


def _detect_image_mime_type(content: bytes) -> Optional[str]:
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        return "image/webp"
    return None


def get_active_chat_user(
    current_user_id: int = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> int:
    if not db.query(UserModel.id).filter(UserModel.id == current_user_id, UserModel.is_active.is_(True)).first():
        raise HTTPException(status_code=403, detail="User is not active")
    return current_user_id


def _serialize_messages(db: Session, messages: list[ChatMessageModel]) -> list[ChatMessageResponse]:
    if not messages:
        return []

    sender_ids = {message.sender_id for message in messages}
    reply_ids = {message.reply_to_id for message in messages if message.reply_to_id is not None}
    replies = {
        reply.id: reply
        for reply in db.query(ChatMessageModel).filter(ChatMessageModel.id.in_(reply_ids)).all()
    } if reply_ids else {}
    attachment_ids = {message.attachment_id for message in messages if message.attachment_id is not None}
    attachments = {
        attachment.id: attachment
        for attachment in db.query(ChatAttachmentModel).filter(ChatAttachmentModel.id.in_(attachment_ids)).all()
    } if attachment_ids else {}
    sender_ids.update(reply.sender_id for reply in replies.values())
    users = {
        user.id: user
        for user in db.query(UserModel).filter(UserModel.id.in_(sender_ids)).all()
    }

    return [
        ChatMessageResponse(
            id=message.id,
            chat_id=message.chat_id,
            content=message.content,
            created_at=message.created_at,
            author=MessageAuthorResponse(
                id=message.sender_id,
                name=_author_name(users.get(message.sender_id)),
            ),
            reply_to=(
                ReplyPreviewResponse(
                    id=replies[message.reply_to_id].id,
                    author_name=_author_name(users.get(replies[message.reply_to_id].sender_id)),
                    content=replies[message.reply_to_id].content,
                )
                if message.reply_to_id in replies
                else None
            ),
            attachment=(
                ChatAttachmentResponse(
                    id=str(attachments[message.attachment_id].id),
                    mime_type=attachments[message.attachment_id].mime_type,
                )
                if message.attachment_id in attachments
                else None
            ),
        )
        for message in messages
    ]


@router.get("/default", response_model=ChatResponse)
def get_default_chat(
    db: Session = Depends(get_db),
):
    chat = _get_or_create_default_chat(db)
    return ChatResponse(id=chat.id, slug=chat.slug, title=chat.title)


@router.get("/{chat_id}/messages", response_model=ChatMessagesPageResponse)
def get_chat_messages(
    chat_id: int,
    before_id: Optional[int] = Query(default=None, gt=0),
    limit: int = Query(default=150, ge=1, le=150),
    db: Session = Depends(get_db),
):
    _get_chat_or_404(db, chat_id)
    query = db.query(ChatMessageModel).filter(ChatMessageModel.chat_id == chat_id)
    if before_id is not None:
        query = query.filter(ChatMessageModel.id < before_id)

    newest_first = query.order_by(ChatMessageModel.id.desc()).limit(limit + 1).all()
    has_more = len(newest_first) > limit
    messages = list(reversed(newest_first[:limit]))
    return ChatMessagesPageResponse(items=_serialize_messages(db, messages), has_more=has_more)


@router.post("/{chat_id}/attachments", response_model=ChatAttachmentResponse)
async def upload_chat_attachment(
    chat_id: int,
    file: UploadFile = File(...),
    current_user_id: int = Depends(get_active_chat_user),
    db: Session = Depends(get_db),
):
    _get_chat_or_404(db, chat_id)
    try:
        rate_limiter.check_attachment_upload(current_user_id)
    except _RateLimitError as exc:
        raise HTTPException(
            status_code=429,
            detail="Too many image uploads. Please wait before uploading another one.",
            headers={"Retry-After": str(exc.retry_after_seconds)},
        )
    if file.content_type not in ALLOWED_IMAGE_MIME_TYPES:
        raise HTTPException(status_code=400, detail="Only GIF, PNG, JPEG, and WebP files are allowed")

    content = await file.read(MAX_GIF_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Image file is empty")
    if len(content) > MAX_GIF_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image must not exceed 5 MB")
    mime_type = _detect_image_mime_type(content)
    if mime_type is None:
        raise HTTPException(status_code=400, detail="Invalid image file")

    attachment = ChatAttachmentModel(
        id=str(uuid4()),
        chat_id=chat_id,
        uploader_id=current_user_id,
        mime_type=mime_type,
        byte_size=len(content),
        content=content,
    )
    db.add(attachment)
    db.commit()
    return ChatAttachmentResponse(id=str(attachment.id), mime_type=attachment.mime_type)


@router.get("/{chat_id}/attachments/{attachment_id}")
def get_chat_attachment(
    chat_id: int,
    attachment_id: str,
    db: Session = Depends(get_db),
):
    attachment = db.get(ChatAttachmentModel, attachment_id)
    if not attachment or attachment.chat_id != chat_id:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return Response(
        content=attachment.content,
        media_type=attachment.mime_type,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/{chat_id}/messages/{message_id}", response_model=ChatMessageResponse)
def get_chat_message(
    chat_id: int,
    message_id: int,
    db: Session = Depends(get_db),
):
    _get_chat_or_404(db, chat_id)
    message = (
        db.query(ChatMessageModel)
        .filter(ChatMessageModel.id == message_id, ChatMessageModel.chat_id == chat_id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    return _serialize_messages(db, [message])[0]


@dataclass
class _RateLimitError(Exception):
    retry_after_seconds: int


class ChatRateLimiter:
    """Process-local sliding-window limiter. Docker runs one API process by default."""

    def __init__(self) -> None:
        self._recent_messages: dict[int, deque[float]] = defaultdict(deque)
        self._hourly_messages: dict[int, deque[float]] = defaultdict(deque)
        self._recent_attachment_uploads: dict[int, deque[float]] = defaultdict(deque)
        self._hourly_attachment_uploads: dict[int, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, user_id: int) -> None:
        now = time.monotonic()

        with self._lock:
            recent = self._recent_messages[user_id]
            while recent and recent[0] <= now - MESSAGE_RATE_LIMIT_WINDOW_SECONDS:
                recent.popleft()
            if len(recent) >= MESSAGE_RATE_LIMIT_COUNT:
                raise _RateLimitError(max(1, int(MESSAGE_RATE_LIMIT_WINDOW_SECONDS - (now - recent[0])) + 1))

            hourly = self._hourly_messages[user_id]
            while hourly and hourly[0] <= now - 3600:
                hourly.popleft()
            if len(hourly) >= MESSAGE_HOURLY_LIMIT_COUNT:
                raise _RateLimitError(max(1, int(3600 - (now - hourly[0])) + 1))

            recent.append(now)
            hourly.append(now)

    def check_attachment_upload(self, user_id: int) -> None:
        now = time.monotonic()
        with self._lock:
            recent = self._recent_attachment_uploads[user_id]
            while recent and recent[0] <= now - GIF_UPLOAD_RATE_LIMIT_WINDOW_SECONDS:
                recent.popleft()
            if len(recent) >= GIF_UPLOAD_RATE_LIMIT_COUNT:
                raise _RateLimitError(max(1, int(GIF_UPLOAD_RATE_LIMIT_WINDOW_SECONDS - (now - recent[0])) + 1))

            hourly = self._hourly_attachment_uploads[user_id]
            while hourly and hourly[0] <= now - 3600:
                hourly.popleft()
            if len(hourly) >= GIF_UPLOAD_HOURLY_LIMIT_COUNT:
                raise _RateLimitError(max(1, int(3600 - (now - hourly[0])) + 1))

            recent.append(now)
            hourly.append(now)


rate_limiter = ChatRateLimiter()


class ChatConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, chat_id: int, websocket: WebSocket, protocol: Optional[str]) -> None:
        if protocol:
            await websocket.accept(subprotocol=protocol)
        else:
            await websocket.accept()
        async with self._lock:
            self._connections[chat_id].add(websocket)

    async def disconnect(self, chat_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            connections = self._connections.get(chat_id)
            if not connections:
                return
            connections.discard(websocket)
            if not connections:
                self._connections.pop(chat_id, None)

    async def broadcast(self, chat_id: int, event: dict) -> None:
        async with self._lock:
            connections = list(self._connections.get(chat_id, set()))
        if not connections:
            return

        results = await asyncio.gather(
            *(connection.send_json(event) for connection in connections),
            return_exceptions=True,
        )
        for connection, result in zip(connections, results):
            if isinstance(result, Exception):
                await self.disconnect(chat_id, connection)


connection_manager = ChatConnectionManager()


def _websocket_token(websocket: WebSocket) -> tuple[Optional[str], Optional[str]]:
    """Read the JWT from a WebSocket subprotocol so it is not put in URLs or proxy logs."""
    for protocol in websocket.headers.get("sec-websocket-protocol", "").split(","):
        protocol = protocol.strip()
        if protocol.startswith("chat-jwt."):
            return protocol.removeprefix("chat-jwt."), protocol
    return None, None


def _create_message(
    db: Session,
    chat_id: int,
    user_id: int,
    payload: WebSocketCreateMessage,
) -> tuple[ChatMessageResponse, bool]:
    content = payload.content.strip()
    if not content and payload.attachment_id is None:
        raise ValueError("Message cannot be empty")
    if len(content) > MAX_MESSAGE_LENGTH:
        raise ValueError(f"Message must not exceed {MAX_MESSAGE_LENGTH} characters")

    _get_chat_or_404(db, chat_id)
    if not db.query(UserModel.id).filter(UserModel.id == user_id, UserModel.is_active.is_(True)).first():
        raise PermissionError("User is not active")

    existing_message = (
        db.query(ChatMessageModel)
        .filter(
            ChatMessageModel.sender_id == user_id,
            ChatMessageModel.chat_id == chat_id,
            ChatMessageModel.client_message_id == str(payload.client_message_id),
        )
        .first()
    )
    if existing_message:
        return _serialize_messages(db, [existing_message])[0], False

    if payload.reply_to_id is not None:
        reply_target = db.get(ChatMessageModel, payload.reply_to_id)
        if not reply_target or reply_target.chat_id != chat_id:
            raise ValueError("Reply target was not found in this chat")

    if payload.attachment_id is not None:
        attachment = db.get(ChatAttachmentModel, str(payload.attachment_id))
        if not attachment or attachment.chat_id != chat_id or attachment.uploader_id != user_id:
            raise ValueError("Attachment was not found in this chat")

    rate_limiter.check(user_id)
    message = ChatMessageModel(
        chat_id=chat_id,
        sender_id=user_id,
        reply_to_id=payload.reply_to_id,
        client_message_id=str(payload.client_message_id),
        attachment_id=str(payload.attachment_id) if payload.attachment_id else None,
        content=content,
    )
    db.add(message)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # If a retry raced with the first request, return the already persisted message.
        existing_message = (
            db.query(ChatMessageModel)
            .filter(
                ChatMessageModel.sender_id == user_id,
                ChatMessageModel.chat_id == chat_id,
                ChatMessageModel.client_message_id == str(payload.client_message_id),
            )
            .first()
        )
        if existing_message:
            return _serialize_messages(db, [existing_message])[0], False
        raise
    except Exception:
        db.rollback()
        raise
    db.refresh(message)
    return _serialize_messages(db, [message])[0], True


async def _send_error(
    websocket: WebSocket,
    code: str,
    message: str,
    client_message_id: Optional[str] = None,
    **details: int,
) -> None:
    event = {"type": "error", "code": code, "message": message, **details}
    if client_message_id is not None:
        event["client_message_id"] = client_message_id
    await websocket.send_json(event)


@ws_router.websocket("/ws/chats/{chat_id}")
async def chat_websocket(websocket: WebSocket, chat_id: int):
    token, protocol = _websocket_token(websocket)
    user_id = jwt_handler.verify_token(token) if token else None

    db = SessionLocal()
    try:
        if not db.get(ChatModel, chat_id):
            await websocket.close(code=1008, reason="Chat not found")
            return
        if user_id is not None and not db.query(UserModel.id).filter(UserModel.id == user_id, UserModel.is_active.is_(True)).first():
            user_id = None
    finally:
        db.close()

    await connection_manager.connect(chat_id, websocket, protocol)
    try:
        while True:
            raw_message = await websocket.receive_text()
            if user_id is None:
                await _send_error(websocket, "authentication_required", "Sign in to send chat messages")
                continue
            if len(raw_message.encode("utf-8")) > MAX_WS_PAYLOAD_BYTES:
                await _send_error(websocket, "payload_too_large", "Message payload is too large")
                continue
            payload: Optional[WebSocketCreateMessage] = None
            try:
                payload = WebSocketCreateMessage.model_validate(json.loads(raw_message))
                if payload.type != "message.create":
                    raise ValueError("Unsupported event type")
                db = SessionLocal()
                try:
                    message, was_created = _create_message(db, chat_id, user_id, payload)
                finally:
                    db.close()
            except json.JSONDecodeError:
                await _send_error(websocket, "invalid_payload", "Invalid JSON payload")
                continue
            except ValidationError as exc:
                await _send_error(websocket, "invalid_payload", "Invalid message payload")
                continue
            except _RateLimitError as exc:
                await _send_error(
                    websocket,
                    "rate_limited",
                    "Too many messages. Please wait before sending another one.",
                    client_message_id=str(payload.client_message_id) if payload else None,
                    retry_after_seconds=exc.retry_after_seconds,
                )
                continue
            except PermissionError:
                await _send_error(
                    websocket,
                    "forbidden",
                    "Your account cannot send chat messages",
                    client_message_id=str(payload.client_message_id) if payload else None,
                )
                continue
            except (ValueError, HTTPException) as exc:
                message_text = exc.detail if isinstance(exc, HTTPException) else str(exc)
                await _send_error(
                    websocket,
                    "invalid_message",
                    message_text,
                    client_message_id=str(payload.client_message_id) if payload else None,
                )
                continue

            await websocket.send_json(
                {
                    "type": "message.ack",
                    "client_message_id": str(payload.client_message_id),
                    "message": message.model_dump(mode="json"),
                }
            )
            if was_created:
                await connection_manager.broadcast(
                    chat_id,
                    {"type": "message.created", "message": message.model_dump(mode="json")},
                )
    except WebSocketDisconnect:
        pass
    finally:
        await connection_manager.disconnect(chat_id, websocket)
