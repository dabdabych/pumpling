"""Who a commit goes to: the rules from shared/wallet_owner.py.

The test works against a real database, because the whole point of the module is
the unique index, the race between two writers and moving commits with one
UPDATE; there would be nothing to check against a fake. With no database the
test is skipped.
"""
from __future__ import annotations

import os
import sys
import uuid

import pytest
from sqlalchemy import text

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from infrastructure.database.database import SessionLocal  # noqa: E402
from shared.wallet_owner import (  # noqa: E402
    LINKED_VIA_DEPOSIT,
    LINKED_VIA_SIGNATURE,
    find_wallet_owner_id,
    link_wallet,
    resolve_wallet_owner_id,
    signature_account_email,
    wallet_account_email,
)


@pytest.fixture()
def db():
    session = SessionLocal()
    try:
        session.execute(text("SELECT 1 FROM users LIMIT 1"))
    except Exception:  # noqa: BLE001 - with no database there is nothing to check
        session.close()
        pytest.skip("database is not reachable")

    tag = uuid.uuid4().hex[:8]
    session.tag = tag  # type: ignore[attr-defined]
    try:
        yield session
    finally:
        session.rollback()
        session.execute(text("DELETE FROM bet_participations WHERE wallet_address LIKE :p"), {"p": f"Wal{tag}%"})
        session.execute(text("DELETE FROM user_wallets WHERE wallet_address LIKE :p"), {"p": f"Wal{tag}%"})
        session.execute(text("DELETE FROM users WHERE email LIKE :p"), {"p": f"%{tag}%"})
        session.commit()
        session.close()


def _make_user(db, kind: str) -> int:
    row = db.execute(
        text(
            """
            INSERT INTO users (email, nickname, hashed_password, is_active, role, is_email_verified)
            VALUES (:email, :nickname, 'x', TRUE, 'CUSTOMER', TRUE) RETURNING id
            """
        ),
        {"email": f"{kind}_{db.tag}@example.test", "nickname": f"{kind}_{db.tag}"},
    ).first()
    db.commit()
    return int(row[0])


def _make_bet(db, user_id: int, wallet: str) -> int:
    lottery_id = db.execute(text("SELECT id FROM lotteries ORDER BY id LIMIT 1")).scalar()
    if lottery_id is None:
        pytest.skip("no lottery in the database")
    row = db.execute(
        text(
            """
            INSERT INTO bet_participations
                (user_id, lottery_id, meme_coin_address, sol_amount, wallet_address, tx_signature, confirmation_status)
            VALUES (:user_id, :lottery_id, 'MintForTest111111111111111111111111111111', 1.5, :wallet, :sig, 'confirmed')
            RETURNING id
            """
        ),
        {"user_id": user_id, "lottery_id": lottery_id, "wallet": wallet, "sig": f"sig_{uuid.uuid4().hex}"},
    ).first()
    db.commit()
    return int(row[0])


def _bet_owner(db, bet_id: int) -> int:
    return int(db.execute(text("SELECT user_id FROM bet_participations WHERE id = :id"), {"id": bet_id}).scalar())


def test_unknown_wallet_gets_its_own_account(db):
    wallet = f"Wal{db.tag}Unknown11111111111111111111111111"
    owner = resolve_wallet_owner_id(db, wallet)

    email = db.execute(text("SELECT email FROM users WHERE id = :id"), {"id": owner}).scalar()
    assert email == wallet_account_email(wallet)
    assert resolve_wallet_owner_id(db, wallet) == owner


def test_signature_moves_the_wallet_and_its_bets(db):
    wallet = f"Wal{db.tag}Signature111111111111111111111111"
    shadow_owner = resolve_wallet_owner_id(db, wallet)
    bet = _make_bet(db, shadow_owner, wallet)
    real_user = _make_user(db, "real")

    assert link_wallet(db, user_id=real_user, address=wallet, linked_via=LINKED_VIA_SIGNATURE)
    assert find_wallet_owner_id(db, wallet) == real_user
    assert _bet_owner(db, bet) == real_user
    # Both writers now name the same owner.
    assert resolve_wallet_owner_id(db, wallet) == real_user


def test_deposit_links_a_free_wallet_but_cannot_steal_one(db):
    wallet = f"Wal{db.tag}Deposit11111111111111111111111111"
    owner = _make_user(db, "owner")
    stranger = _make_user(db, "stranger")

    assert link_wallet(db, user_id=owner, address=wallet, linked_via=LINKED_VIA_DEPOSIT)
    bet = _make_bet(db, owner, wallet)

    assert not link_wallet(db, user_id=stranger, address=wallet, linked_via=LINKED_VIA_DEPOSIT)
    assert find_wallet_owner_id(db, wallet) == owner
    assert _bet_owner(db, bet) == owner


def test_signature_beats_a_deposit_link(db):
    wallet = f"Wal{db.tag}Beats111111111111111111111111111"
    claimer = _make_user(db, "claimer")
    key_holder = _make_user(db, "keyholder")
    link_wallet(db, user_id=claimer, address=wallet, linked_via=LINKED_VIA_DEPOSIT)
    bet = _make_bet(db, claimer, wallet)

    assert link_wallet(db, user_id=key_holder, address=wallet, linked_via=LINKED_VIA_SIGNATURE)
    assert find_wallet_owner_id(db, wallet) == key_holder
    assert _bet_owner(db, bet) == key_holder


def test_legacy_sign_in_account_is_recognised(db):
    wallet = f"Wal{db.tag}Legacy1111111111111111111111111"
    legacy_id = db.execute(
        text(
            """
            INSERT INTO users (email, nickname, hashed_password, is_active, role, is_email_verified)
            VALUES (:email, :nickname, 'x', TRUE, 'CUSTOMER', TRUE) RETURNING id
            """
        ),
        {"email": signature_account_email(wallet), "nickname": f"legacy_{db.tag}"},
    ).scalar()
    db.commit()

    assert resolve_wallet_owner_id(db, wallet) == int(legacy_id)


def test_one_link_row_per_wallet(db):
    wallet = f"Wal{db.tag}Once111111111111111111111111111"

    first = resolve_wallet_owner_id(db, wallet)
    second = resolve_wallet_owner_id(db, wallet)

    assert first == second
    rows = db.execute(text("SELECT count(*) FROM user_wallets WHERE wallet_address = :w"), {"w": wallet}).scalar()
    assert rows == 1
