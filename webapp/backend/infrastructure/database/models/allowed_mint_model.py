from sqlalchemy import Column, DateTime, Enum as SQLEnum, Integer, String, UniqueConstraint
from sqlalchemy.sql import func

from domain.lottery.entities.allowed_mint import NetworkType
from infrastructure.database.database import Base


class AllowedMintModel(Base):
    __tablename__ = "allowed_mints"
    __table_args__ = (
        UniqueConstraint("mint", "network_type", name="uq_allowed_mints_mint_network"),
    )

    id = Column(Integer, primary_key=True, index=True)
    mint = Column(String(64), nullable=False, index=True)
    network_type = Column(SQLEnum(NetworkType), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
