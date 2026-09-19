"""Who a wallet belongs to, and therefore whose commits come from it.

A commit reaches the database two ways: through `POST /lottery/bet` from the
browser, and through the events worker that reads deposits from the chain. Each
path used to derive the owner its own way — the API took the account from the
token, the worker created `wallet_<address>@onchain.local`, and wallet sign-in
lived under `wallet_<lowercased address>@wallet.local`. Whoever recorded the
commit first decided the `user_id`, so the field lied.

Now both paths ask here and the answer is one: the wallet's owner. The link
between a wallet and an account lives in `user_wallets` and appears when someone
signed in with that wallet (`signature`) or committed SOL from it while signed
in (`deposit`). With no link the wallet gets an account of its own: the commit
was made and has to be recorded against somebody, even if the person never
registered. When an owner turns up, the earlier commits move to them.

Models are deliberately not imported here: the backend and the workers use this
same code and they have their own copies of the models on different `Base`es.
"""

from __future__ import annotations

import logging
import secrets
from typing import Optional

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

LINKED_VIA_SIGNATURE = "signature"
LINKED_VIA_DEPOSIT = "deposit"

# An account created for the wallet itself: no password gets in, only a
# signature from that same wallet. Such a link may be moved to a real account.
_WALLET_ACCOUNT_SUFFIXES = ("@onchain.local", "@wallet.local")

_TABLE_READY = False


def wallet_account_email(address: str) -> str:
    """The email of the wallet's own account. Case matters: it is base58."""
    return f"wallet_{address}@onchain.local"


def signature_account_email(address: str) -> str:
    """The email of a sign-in-by-signature account (historically a lowercased address)."""
    return f"wallet_{address.lower()}@wallet.local"


def ensure_user_wallets_table(session: Session) -> None:
    """The table may not exist: the worker starts before the backend migrations."""
    global _TABLE_READY
    if _TABLE_READY:
        return

    session.execute(text("""
        CREATE TABLE IF NOT EXISTS user_wallets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            wallet_address VARCHAR(64) NOT NULL,
            linked_via VARCHAR(16) NOT NULL DEFAULT 'signature',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_user_wallets_address UNIQUE (wallet_address)
        )
    """))
    session.execute(text("CREATE INDEX IF NOT EXISTS ix_user_wallets_user_id ON user_wallets (user_id)"))
    session.commit()
    _TABLE_READY = True


def find_wallet_owner_id(session: Session, address: str) -> Optional[int]:
    """The account a wallet is attached to, or None."""
    ensure_user_wallets_table(session)
    row = session.execute(
        text("SELECT user_id FROM user_wallets WHERE wallet_address = :address"),
        {"address": address},
    ).first()
    return int(row[0]) if row else None


def resolve_wallet_owner_id(session: Session, address: str) -> int:
    """The wallet's owner; with no link, creates the wallet's own account.

    Called from the worker and from the API, so it is built for a race: the
    unique index on the address settles it for us and the loser re-reads the row.
    """
    owner_id = find_wallet_owner_id(session, address)
    if owner_id is not None:
        return owner_id

    legacy_id, linked_via = _find_legacy_account(session, address)
    user_id = legacy_id if legacy_id is not None else _create_wallet_account(session, address)
    link_wallet(session, user_id=user_id, address=address, linked_via=linked_via)
    return find_wallet_owner_id(session, address) or user_id


def link_wallet(session: Session, *, user_id: int, address: str, linked_via: str) -> bool:
    """Attach a wallet to an account. False means the wallet belongs to someone else.

    A signature beats a deposit. A deposit link only says "this wallet committed
    SOL while the person was signed in"; a signature link proves ownership of the
    key, so it overrides both that and the link to the wallet's own account.
    Otherwise the first person to point at someone else's deposit would lock the
    wallet to themselves forever.
    """
    ensure_user_wallets_table(session)
    row = session.execute(
        text("SELECT user_id, linked_via FROM user_wallets WHERE wallet_address = :address"),
        {"address": address},
    ).first()

    if row is not None:
        current_owner_id, current_via = int(row[0]), row[1]
        if current_owner_id == int(user_id):
            if current_via != LINKED_VIA_SIGNATURE and linked_via == LINKED_VIA_SIGNATURE:
                session.execute(
                    text("UPDATE user_wallets SET linked_via = :via WHERE wallet_address = :address"),
                    {"via": LINKED_VIA_SIGNATURE, "address": address},
                )
                session.commit()
            return True

        takeover = _is_wallet_account(session, current_owner_id) or (
            current_via == LINKED_VIA_DEPOSIT and linked_via == LINKED_VIA_SIGNATURE
        )
        if not takeover:
            logger.info("wallet %s stays with user %s; user %s asked to link it", address, current_owner_id, user_id)
            return False

        session.execute(
            text("UPDATE user_wallets SET user_id = :user_id, linked_via = :via WHERE wallet_address = :address"),
            {"user_id": int(user_id), "via": linked_via, "address": address},
        )
        session.commit()
        _move_bets(session, address=address, user_id=int(user_id))
        return True

    session.execute(
        text("INSERT INTO user_wallets (user_id, wallet_address, linked_via) VALUES (:user_id, :address, :via)"),
        {"user_id": int(user_id), "address": address, "via": linked_via},
    )
    try:
        session.commit()
    except IntegrityError:
        # The same wallet was attached by a parallel request.
        session.rollback()
        return find_wallet_owner_id(session, address) == int(user_id)

    _move_bets(session, address=address, user_id=int(user_id))
    return True


def _find_legacy_account(session: Session, address: str) -> tuple[Optional[int], str]:
    """Accounts created before the links existed: first by signature, then by the worker."""
    row = session.execute(
        text("SELECT id FROM users WHERE email = :email"),
        {"email": signature_account_email(address)},
    ).first()
    if row:
        return int(row[0]), LINKED_VIA_SIGNATURE

    row = session.execute(
        text("SELECT id FROM users WHERE email = :email"),
        {"email": wallet_account_email(address)},
    ).first()
    if row:
        return int(row[0]), LINKED_VIA_DEPOSIT

    return None, LINKED_VIA_DEPOSIT


def _is_wallet_account(session: Session, user_id: int) -> bool:
    row = session.execute(text("SELECT email FROM users WHERE id = :id"), {"id": int(user_id)}).first()
    email = (row[0] if row else "") or ""
    return email.lower().endswith(_WALLET_ACCOUNT_SUFFIXES)


def _move_bets(session: Session, *, address: str, user_id: int) -> None:
    """The wallet's earlier commits move to the owner."""
    moved = session.execute(
        text("UPDATE bet_participations SET user_id = :user_id WHERE wallet_address = :address AND user_id <> :user_id"),
        {"user_id": int(user_id), "address": address},
    ).rowcount
    if moved:
        session.commit()
        logger.info("moved %s bets of wallet %s to user %s", moved, address, user_id)


def _create_wallet_account(session: Session, address: str) -> int:
    """An account for the wallet itself. The nickname is unique, so on a clash we try again."""
    email = wallet_account_email(address)
    for attempt in range(3):
        suffix = "" if attempt == 0 else f"_{secrets.token_hex(2)}"
        try:
            row = session.execute(
                text("""
                    INSERT INTO users (email, nickname, hashed_password, is_active, role, is_email_verified)
                    VALUES (:email, :nickname, 'onchain', TRUE, 'CUSTOMER', FALSE)
                    RETURNING id
                """),
                {"email": email, "nickname": f"wallet_{address[:16]}{suffix}"},
            ).first()
            session.commit()
        except IntegrityError:
            # Either the account was created in parallel, or the nickname collided.
            session.rollback()
            existing = session.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email}).first()
            if existing:
                return int(existing[0])
            continue
        if row:
            return int(row[0])

    raise RuntimeError(f"failed to create an account for wallet {address}")
