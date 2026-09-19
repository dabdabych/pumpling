from sqlalchemy import Column, String, DateTime
from infrastructure.database.database import Base


class WalletAuthNonceModel(Base):
    __tablename__ = "wallet_auth_nonces"

    nonce = Column(String(255), primary_key=True)
    wallet_address = Column(String(255), nullable=False, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False)
