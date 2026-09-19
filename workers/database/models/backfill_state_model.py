from sqlalchemy import Column, String, DateTime
from sqlalchemy.sql import func
from database.database import Base


class BackfillStateModel(Base):
    __tablename__ = "backfill_state"

    id = Column(String(128), primary_key=True)
    last_signature = Column(String(128), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
