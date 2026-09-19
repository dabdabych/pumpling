from sqlalchemy import Column, Integer, String, DateTime, JSON, UniqueConstraint
from sqlalchemy.sql import func
from infrastructure.database.database import Base


class SmartContractEventModel(Base):
    __tablename__ = "smart_contract_events"
    __table_args__ = (UniqueConstraint("signature", "event_name", name="uq_event_signature_name"),)

    id = Column(Integer, primary_key=True, index=True)
    signature = Column(String(128), nullable=True, index=True)
    event_name = Column(String(128), nullable=False, index=True)
    data = Column(JSON, nullable=True)
    raw_logs = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
