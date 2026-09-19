from sqlalchemy import Column, DateTime, String
from sqlalchemy.sql import func

from infrastructure.database.database import Base


class TokenMetadataModel(Base):
    __tablename__ = "token_metadata"

    mint = Column(String(64), primary_key=True, index=True)
    name = Column(String(255), nullable=True)
    symbol = Column(String(64), nullable=True)
    logo_url = Column(String(1024), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
