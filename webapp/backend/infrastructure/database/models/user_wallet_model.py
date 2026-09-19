from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.sql import func

from infrastructure.database.database import Base


class UserWalletModel(Base):
    """A wallet attached to an account. One wallet, one owner."""

    __tablename__ = "user_wallets"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    wallet_address = Column(String(64), nullable=False)
    linked_via = Column(String(16), nullable=False, default="signature", server_default="signature")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (UniqueConstraint("wallet_address", name="uq_user_wallets_address"),)
