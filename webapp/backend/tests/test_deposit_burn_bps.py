"""Both paths that record a commit record the same burn choice.

A commit reaches the database twice over: the browser reports it to the backend
(`place_bet`, which reads the transaction), and the events worker sees the
deposit on chain (which has only the log, over a websocket). Whichever gets
there first writes the row. Both read the burn from the same log with the same
function, so the row says the same thing either way.

The log is a real commit to our program as the chain recorded it, with the
memo program's real frame for our text added after the deposit; see
`fixtures/burn_memo_logs.json`.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_WORKERS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "workers",
)
sys.path.insert(0, _WORKERS)

import events_worker as worker  # noqa: E402
from presentation.lottery import lottery_router as router  # noqa: E402

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "burn_memo_logs.json").read_text())
DEPOSIT = FIXTURE["deposit"]["logMessages"]


def with_memo(text: str) -> list[str]:
    return DEPOSIT[:-3] + FIXTURE["memo_frames"][text] + DEPOSIT[-3:]


# --- the events worker --------------------------------------------------------

class _Query:
    def __init__(self, result):
        self._result = result

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self._result


class _Session:
    def __init__(self, lottery):
        self.lottery = lottery
        self.added: list = []

    def query(self, model):
        if model is worker.LotteryModel:
            return _Query(self.lottery)
        return _Query(None)  # no bet with this signature yet

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        pass

    def rollback(self):
        pass


def _deposit_event() -> dict:
    # The real deposit's fields, decoded from its own log.
    decoded = router.decode_deposit_events_from_logs(DEPOSIT)
    assert decoded, "the fixture's deposit must decode"
    event = decoded[0]
    return {"lottery": event.lottery, "user": event.user, "mint": event.mint, "amount": event.amount_lamports, "ts": event.ts}


@pytest.mark.parametrize("logs, bps", [
    (DEPOSIT, 0),
    (with_memo("pumpling burn 25%"), 2500),
    (with_memo("pumpling burn 100%"), 10_000),
])
def test_the_events_worker_records_the_burn_from_the_log(monkeypatch, logs, bps):
    monkeypatch.setattr(worker, "_resolve_lottery_id_by_pubkey", lambda session, pubkey: 7)
    monkeypatch.setattr(worker, "resolve_wallet_owner_id", lambda session, wallet: 3)
    session = _Session(SimpleNamespace(id=7, status="created"))

    worker._handle_deposit(session, "Deposit", _deposit_event(), FIXTURE["deposit"]["signature"], logs)

    assert len(session.added) == 1
    assert session.added[0].burn_bps == bps


def test_the_events_worker_without_a_log_records_no_burn(monkeypatch):
    monkeypatch.setattr(worker, "_resolve_lottery_id_by_pubkey", lambda session, pubkey: 7)
    monkeypatch.setattr(worker, "resolve_wallet_owner_id", lambda session, wallet: 3)
    session = _Session(SimpleNamespace(id=7, status="created"))

    worker._handle_deposit(session, "Deposit", _deposit_event(), FIXTURE["deposit"]["signature"])

    assert session.added[0].burn_bps == 0


def test_persisting_an_event_hands_its_log_to_the_deposit_handler(monkeypatch):
    seen = {}

    def spy(session, event_name, event_data, signature, raw_logs=None):
        seen["logs"] = raw_logs

    class _Store:
        def add(self, _):
            pass

        def commit(self):
            pass

        def close(self):
            pass

        def rollback(self):
            pass

    monkeypatch.setattr(worker, "SessionLocal", lambda: _Store())
    for name in ("_handle_lottery_initialized", "_handle_phase2_started", "_handle_emergency_seed_used",
                 "_handle_vrf_fulfilled", "_handle_purchases_phase_started", "_handle_phase_changed"):
        monkeypatch.setattr(worker, name, lambda *args, **kwargs: None)
    monkeypatch.setattr(worker, "_handle_deposit", spy)

    logs = with_memo("pumpling burn 50%")
    worker._persist_event("Deposit", FIXTURE["deposit"]["signature"], _deposit_event(), logs)

    assert seen["logs"] == logs


# --- the backend --------------------------------------------------------------

class _Rpc:
    def __init__(self, transaction):
        self.transaction = transaction
        self.calls: list = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_transaction(self, signature, **options):
        self.calls.append(options)
        return self.transaction


@pytest.mark.parametrize("logs, bps", [
    (DEPOSIT, 0),
    (with_memo("pumpling burn 50%"), 5000),
])
def test_the_backend_reads_the_same_burn_from_the_same_transaction(monkeypatch, logs, bps):
    rpc = _Rpc({"meta": {"err": None, "logMessages": logs}})
    monkeypatch.setattr(router, "SolanaJsonRpc", lambda endpoint: rpc)

    event, burn_bps = asyncio.run(router._fetch_confirmed_deposit(FIXTURE["deposit"]["signature"]))

    assert event is not None
    assert burn_bps == bps
    # A wallet can build the commit as a v1 transaction.
    assert rpc.calls[0]["max_supported_transaction_version"] == 1


def test_both_paths_agree_on_every_fixture():
    for text in FIXTURE["memo_frames"]:
        logs = with_memo(text)
        assert worker.burn_bps_from_logs(logs) == router.burn_bps_from_logs(logs)
