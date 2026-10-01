"""Keeps the secrets that travel inside URLs out of the logs.

The RPC endpoints are Helius URLs with the key in the query string
(`?api-key=...`). Every worker printed its endpoint on startup, so the key sat
in `docker logs`, in Loki and in Grafana on the mainnet server (found on
2026-09-29: five lines, one per worker start). An HTTP client error carries the
full URL in its text as well, so a failed call would have put it there again,
and into the Telegram alert channel.

So the redaction is not left to each log line. A filter goes on every handler
of the root logger and rewrites what the record will print: the message and
the traceback. A handler filter sees records from every logger that propagates
to the root, which a filter on the root logger itself would not.
"""
from __future__ import annotations

import logging
import re

#: A query parameter that carries a credential. The value is what a URL may
#: carry unescaped or percent-encoded, plus the base64 alphabet, so it ends at
#: the first character a log line or a JSON string puts after it: a comma, a
#: bracket, a quote, a backslash (an escaped quote stays whole). The buyer
#: scrubs with the same pattern (`offchain/logger.ts`).
_SECRET_PARAMETER = re.compile(
    r"(?i)\b(api[-_]?key|access[-_]?token|token|secret)=([A-Za-z0-9._~%+/=-]+)"
)

_REDACTED = "***"


def redact(text: str) -> str:
    """The text with every credential parameter's value replaced."""
    return _SECRET_PARAMETER.sub(lambda match: f"{match.group(1)}={_REDACTED}", text)


class RedactSecretsFilter(logging.Filter):
    """Rewrites a record so that nothing a handler prints carries a credential."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        cleaned = redact(message)
        if cleaned != message:
            # The message is formatted once here, so the arguments go: the
            # cleaned text is final, and a `%` left in it must stay literal.
            record.msg = cleaned
            record.args = None
        if record.exc_info and not record.exc_text:
            # A formatter would render the traceback later, unredacted, and
            # cache it here. Rendering it first means the cached copy is clean.
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact(record.exc_text)
        if record.stack_info:
            record.stack_info = redact(record.stack_info)
        return True


def install_log_redaction(logger: logging.Logger | None = None) -> None:
    """Puts the filter on every handler the logger has now. Safe to call twice."""
    target = logger or logging.getLogger()
    for handler in target.handlers:
        if not any(isinstance(existing, RedactSecretsFilter) for existing in handler.filters):
            handler.addFilter(RedactSecretsFilter())
