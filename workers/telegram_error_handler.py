from __future__ import annotations

import json
import logging
import queue
import socket
import sys
import threading
import time
from urllib import error, request


_TELEGRAM_MESSAGE_LIMIT = 4096
_MESSAGE_CHUNK_SIZE = 3900
_BATCH_WINDOW_SECONDS = 1.0


def _level_marker(level: int) -> str:
    if level >= logging.CRITICAL:
        return "🆘🆘"
    if level >= logging.ERROR:
        return "🚨🚨"
    if level >= logging.WARNING:
        return "⚠️"
    return ""


def _batch_title(application: str, level: int) -> str:
    if level >= logging.CRITICAL:
        return f"🆘🆘 CRITICAL | [{application}] 🆘🆘"
    if level >= logging.ERROR:
        return f"🚨🚨 ERROR | [{application}] 🚨🚨"
    if level >= logging.WARNING:
        return f"⚠️ WARNING | [{application}]"
    return f"[{application}]"


class TelegramLogHandler(logging.Handler):
    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        *,
        application: str,
        level: int = logging.INFO,
        timeout_seconds: float = 10.0,
        api_base_url: str = "https://api.telegram.org",
    ) -> None:
        super().__init__(level=level)
        self._url = f"{api_base_url.rstrip('/')}/bot{bot_token}/sendMessage"
        self._chat_id = chat_id
        self._application = application
        self._host = socket.gethostname()
        self._timeout_seconds = timeout_seconds
        self._queue: queue.Queue[tuple[int, str] | None] = queue.Queue(maxsize=1000)
        self._closed = False
        self._sender = threading.Thread(
            target=self._run_sender,
            name="telegram-log-sender",
            daemon=True,
        )
        self._sender.start()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
            marker = _level_marker(record.levelno)
            marker_prefix = f"{marker} " if marker else ""
            event = (
                f"{marker_prefix}"
                f"{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(record.created))}"
                f" | {record.levelname} | {record.name}\n{message}"
            )
            self._queue.put_nowait((record.levelno, event))
        except queue.Full:
            self._write_stderr("Telegram log queue is full; dropping notification")
        except Exception as exc:
            self.handleError(record)
            self._write_stderr(f"Failed to enqueue Telegram notification: {exc}")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        self._sender.join(timeout=self._timeout_seconds + 1)
        super().close()

    def _run_sender(self) -> None:
        while True:
            first_event = self._queue.get()
            queued_items = 1
            stop_requested = first_event is None
            events = [] if first_event is None else [first_event]
            try:
                deadline = time.monotonic() + _BATCH_WINDOW_SECONDS
                while not stop_requested:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        next_event = self._queue.get(timeout=remaining)
                    except queue.Empty:
                        break
                    queued_items += 1
                    if next_event is None:
                        stop_requested = True
                        break
                    events.append(next_event)

                if events:
                    highest_level = max(level for level, _ in events)
                    message = (
                        f"{_batch_title(self._application, highest_level)}\n"
                        f"host: {self._host}\n"
                        f"events: {len(events)}\n\n"
                        + "\n\n".join(event for _, event in events)
                    )
                    for chunk in self._split_message(message):
                        self._send_message(chunk)
                if stop_requested:
                    return
            except Exception as exc:
                self._write_stderr(f"Telegram notification failed: {exc}")
            finally:
                for _ in range(queued_items):
                    self._queue.task_done()

    def _send_message(self, text: str) -> None:
        payload = json.dumps(
            {
                "chat_id": self._chat_id,
                "text": text,
                "disable_web_page_preview": True,
            }
        ).encode("utf-8")
        req = request.Request(
            self._url,
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with request.urlopen(req, timeout=self._timeout_seconds) as response:
                response.read()
        except error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Telegram HTTP {exc.code}: {response_body}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Telegram API is unavailable: {exc}") from exc

    @staticmethod
    def _split_message(message: str) -> list[str]:
        if len(message) <= _TELEGRAM_MESSAGE_LIMIT:
            return [message]
        return [
            message[index:index + _MESSAGE_CHUNK_SIZE]
            for index in range(0, len(message), _MESSAGE_CHUNK_SIZE)
        ]

    @staticmethod
    def _write_stderr(message: str) -> None:
        print(message, file=sys.stderr, flush=True)
