"""The burn choice, read from a commit's transaction log.

The logs are real: a commit to our program as the chain recorded it, the memo
program's own frame for our text (from simulating MemoSq4g on mainnet), and
other people's memos taken from the chain. See `fixtures/burn_memo_logs.json`.
"""

import json
from pathlib import Path

import pytest

from shared.burn_memo import (
    MEMO_PROGRAM_ID,
    burn_bps_from_logs,
    burn_bps_from_memo_text,
    memo_text,
    top_level_memos,
)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "burn_memo_logs.json").read_text())
DEPOSIT = FIXTURE["deposit"]["logMessages"]
FRAMES = FIXTURE["memo_frames"]


def commit_with(*frames: list[str]) -> list[str]:
    """The real commit with memo frames placed after the deposit, before the wallet's last assertion."""
    tail = 3  # the Lighthouse assertion Phantom appends after our instruction
    return DEPOSIT[:-tail] + [line for frame in frames for line in frame] + DEPOSIT[-tail:]


def memo_frame(text: str, program: str = MEMO_PROGRAM_ID, depth: int = 1, length: int | None = None) -> list[str]:
    size = len(text.encode("utf-8")) if length is None else length
    return [
        f"Program {program} invoke [{depth}]",
        "Program log: Signed by 7Yb3kP5nWq2Lx9mZcVtRdF4gHjKsA8uE6NiBoC1pQrTs",
        f'Program log: Memo (len {size}): "{text}"',
        f"Program {program} consumed 21042 of 59850 compute units",
        f"Program {program} success",
    ]


# --- the real thing -----------------------------------------------------------

def test_a_commit_without_a_memo_burns_nothing():
    assert burn_bps_from_logs(DEPOSIT) == 0


@pytest.mark.parametrize("text, bps", [
    ("pumpling burn 25%", 2500),
    ("pumpling burn 50%", 5000),
    ("pumpling burn 100%", 10_000),
])
def test_the_memo_the_site_sends_is_read_from_the_real_program_frame(text, bps):
    assert burn_bps_from_logs(commit_with(FRAMES[text])) == bps


def test_other_peoples_memos_on_chain_are_seen_and_not_taken_for_ours():
    for sample in FIXTURE["others"]:
        memos = top_level_memos(sample["logMessages"])
        assert memos and len(memos) == 1
        assert burn_bps_from_logs(sample["logMessages"]) == 0


# --- what must not count ------------------------------------------------------

def test_two_burn_memos_are_doubt_and_doubt_means_nothing_burned():
    assert burn_bps_from_logs(commit_with(FRAMES["pumpling burn 50%"], FRAMES["pumpling burn 100%"])) == 0
    assert burn_bps_from_logs(commit_with(FRAMES["pumpling burn 50%"], FRAMES["pumpling burn 50%"])) == 0


def test_an_unrelated_memo_beside_ours_does_not_get_in_the_way():
    assert burn_bps_from_logs(commit_with(memo_frame("hello"), FRAMES["pumpling burn 25%"])) == 2500


def test_a_memo_made_from_inside_another_program_is_not_the_wallets():
    inner = [
        "Program 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin invoke [1]",
        *memo_frame("pumpling burn 100%", depth=2),
        "Program 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin success",
    ]
    assert burn_bps_from_logs(commit_with(inner)) == 0


def test_a_program_logging_memo_text_in_its_own_frame_is_not_a_memo():
    forged = [
        "Program 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin invoke [1]",
        'Program log: Memo (len 18): "pumpling burn 100%"',
        f"Program log: Program {MEMO_PROGRAM_ID} invoke [1]",
        "Program 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin success",
    ]
    assert burn_bps_from_logs(commit_with(forged)) == 0


@pytest.mark.parametrize("program", [
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",  # memo v1
    "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",  # any other program id
])
def test_other_memo_programs_are_ignored(program):
    assert burn_bps_from_logs(commit_with(memo_frame("pumpling burn 50%", program=program))) == 0


def test_a_truncated_log_is_not_read():
    logs = commit_with(FRAMES["pumpling burn 50%"]) + ["Log truncated"]
    assert burn_bps_from_logs(logs) == 0


def test_frames_that_do_not_add_up_are_not_read():
    broken = [f"Program {MEMO_PROGRAM_ID} invoke [2]", *FRAMES["pumpling burn 50%"][1:]]
    assert burn_bps_from_logs(commit_with(broken)) == 0


def test_a_length_that_does_not_match_the_text_is_not_ours():
    assert burn_bps_from_logs(commit_with(memo_frame("pumpling burn 50%", length=18))) == 0


def test_no_logs_at_all():
    assert burn_bps_from_logs(None) == 0
    assert burn_bps_from_logs([]) == 0


# --- the text ----------------------------------------------------------------

@pytest.mark.parametrize("text, bps", [
    ("pumpling burn 0%", 0),
    ("pumpling burn 1%", 100),
    ("pumpling burn 33.33%", 3333),
    ("pumpling burn 12.5%", 1250),
    ("pumpling burn 99.99%", 9999),
    ("pumpling burn 100%", 10_000),
])
def test_accepted_texts(text, bps):
    assert burn_bps_from_memo_text(text) == bps


@pytest.mark.parametrize("text", [
    "pumpling burn 150%",
    "pumpling burn 100.5%",
    "pumpling burn 0.001%",
    "pumpling burn 05%",
    "pumpling burn 50",
    "pumpling burn -50%",
    "Pumpling burn 50%",
    " pumpling burn 50%",
    "pumpling burn 50% ",
    "pumpling  burn 50%",
    "pumpling burn 5e1%",
    "pumpling burn 50%%",
    "",
])
def test_refused_texts(text):
    assert burn_bps_from_memo_text(text) is None


@pytest.mark.parametrize("percent, text", [
    (25, "pumpling burn 25%"),
    (50, "pumpling burn 50%"),
    (100, "pumpling burn 100%"),
    ("33.33", "pumpling burn 33.33%"),
    ("12.50", "pumpling burn 12.5%"),
])
def test_memo_text_round_trips(percent, text):
    assert memo_text(percent) == text
    assert burn_bps_from_memo_text(memo_text(percent)) is not None
