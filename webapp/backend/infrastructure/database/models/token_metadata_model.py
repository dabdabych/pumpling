from sqlalchemy import Column, DateTime, Integer, String
from sqlalchemy.sql import func

from infrastructure.database.database import Base


class TokenMetadataModel(Base):
    __tablename__ = "token_metadata"

    mint = Column(String(64), primary_key=True, index=True)
    name = Column(String(255), nullable=True)
    symbol = Column(String(64), nullable=True)
    logo_url = Column(String(1024), nullable=True)
    #: Tries at finding the picture after a commit, and when the next one is due
    #: (`shared/coin_picture_fill.py`, migration 044). Null: not scheduled.
    logo_attempts = Column(Integer, nullable=False, default=0, server_default="0")
    logo_next_attempt_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
