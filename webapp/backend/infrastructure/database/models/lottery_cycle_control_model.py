from sqlalchemy import Boolean, Column, DateTime, String
from sqlalchemy.sql import func

from infrastructure.database.database import Base


class LotteryCycleControlModel(Base):
    __tablename__ = "lottery_cycle_controls"

    lottery_type = Column(String(32), primary_key=True)
    enabled = Column(Boolean, nullable=False, server_default="true", default=True)
    stop_requested_at = Column(DateTime(timezone=True), nullable=True)
    hype_launch_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
