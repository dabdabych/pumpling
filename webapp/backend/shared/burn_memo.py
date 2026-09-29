"""The burn choice a commit carries, read from its own transaction.

A participant can ask for part of what is bought for them to be burned instead
of delivered. The choice is not a field of any request: it is a memo in the
commit transaction itself, signed by the wallet together with the deposit, so
it is as public and as final as the deposit is. The site adds it; nothing the
site says afterwards can change it.

    pumpling burn 50%

One module reads it for both paths that record a commit: the backend when the
browser reports the commit, the events worker when it sees the deposit on
chain. Both read the same thing, the transaction's log, so a commit recorded by
either carries the same choice whichever gets there first. The worker's
websocket path has nothing but the log, which is why the log is the source and
not the instruction list.

What counts, and why each rule is there:

* **Only the SPL Memo program at `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.**
  It sits under the non-upgradeable BPF loader, so nobody can change what it
  does. Other memo versions are ignored.
* **Only at the top level of the transaction** (`invoke [1]`). A memo made from
  inside another program is that program's doing, not the wallet's.
* **Log lines are attributed by call frame.** A program can log any text it
  likes, but only inside its own frame, prefixed "Program log:"; the frame
  lines ("Program X invoke [n]", "Program X success") come from the runtime.
  So a line counts as the memo only when the frame on top is the memo program.
* **Exactly one memo that says "pumpling burn N%"**, N from 0 to 100 with at most
  two decimals. None, garbage, or two of them: zero. Every doubt resolves
  towards the participant getting their tokens, never towards burning them.
* **A truncated log is not read at all**: whatever was cut could have been a
  second memo.

The format of the log was checked on mainnet transactions on 2026-09-29:

    Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]
    Program log: Signed by <wallet>
    Program log: Memo (len 17): "pumpling burn 50%"
    Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr consumed 22200 of 29700 compute units
    Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success

The quotes are Rust's debug formatting of the text; our text has nothing it
would escape, so a memo with escapes in it is not ours.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Iterable, Optional

MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

#: The whole text of the memo. The site offers 25, 50 and 100.
BURN_MEMO_RE = re.compile(r"^pumpling burn (100|[1-9]?\d(?:\.\d{1,2})?)%$")

_INVOKE_RE = re.compile(r"^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$")
_EXIT_RE = re.compile(r"^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed.*)$")
_MEMO_LOG_RE = re.compile(r'^Program log: Memo \(len (\d+)\): "(.*)"$')

FULL_BPS = 10_000


def memo_text(percent: int | float | Decimal) -> str:
    """The memo the site puts into a commit for this share, e.g. "pumpling burn 50%"."""
    value = Decimal(str(percent)).normalize()
    return f"pumpling burn {value:f}%"


def burn_bps_from_memo_text(text: str) -> Optional[int]:
    """The basis points one memo asks for, or None if it is not a burn memo."""
    match = BURN_MEMO_RE.match(text)
    if not match:
        return None
    bps = int((Decimal(match.group(1)) * 100).to_integral_value())
    return bps if 0 <= bps <= FULL_BPS else None


def top_level_memos(logs: Iterable[str]) -> Optional[list[str]]:
    """The texts of every top-level MemoSq4g memo in a transaction's log.

    None when the log cannot be trusted: it was truncated, or its frames do
    not add up.
    """
    memos: list[str] = []
    stack: list[str] = []
    for raw in logs:
        line = str(raw)
        if line.startswith("Log truncated"):
            return None
        invoke = _INVOKE_RE.match(line)
        if invoke:
            depth = int(invoke.group(2))
            if depth != len(stack) + 1:
                return None
            stack.append(invoke.group(1))
            continue
        exit_ = _EXIT_RE.match(line)
        if exit_:
            if not stack or stack[-1] != exit_.group(1):
                return None
            stack.pop()
            continue
        if len(stack) == 1 and stack[0] == MEMO_PROGRAM_ID:
            memo = _MEMO_LOG_RE.match(line)
            if memo:
                text = memo.group(2)
                # The length the program logs is in bytes of the text it got.
                if int(memo.group(1)) == len(text.encode("utf-8")):
                    memos.append(text)
    return memos


def burn_bps_from_logs(logs: Optional[Iterable[str]]) -> int:
    """The burn a commit asks for, in basis points, from its transaction's log.

    Zero unless there is exactly one top-level burn memo; see the module notes.
    """
    if not logs:
        return 0
    memos = top_level_memos(logs)
    if memos is None:
        return 0
    found = [bps for bps in (burn_bps_from_memo_text(text) for text in memos) if bps is not None]
    return found[0] if len(found) == 1 else 0
