from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc
from sqlalchemy.orm import Session

from infrastructure.database.database import get_db
from infrastructure.database.models.smart_contract_event_model import SmartContractEventModel
from presentation.auth.auth_router import get_current_user
from pydantic import BaseModel


class SmartContractEventResponse(BaseModel):
    id: int
    signature: Optional[str]
    event_name: str
    data: Optional[Dict[str, Any]]
    raw_logs: Optional[List[str]]
    created_at: datetime

    class Config:
        from_attributes = True


class PagedSmartContractEventResponse(BaseModel):
    items: List[SmartContractEventResponse]
    total_count: int


router = APIRouter(prefix="/smart-contract-events", tags=["smart-contract-events"])


@router.get("", response_model=PagedSmartContractEventResponse)
async def list_events(
    page_index: int = Query(0, ge=0),
    page_size: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user_id: int = Depends(get_current_user),
):
    skip = page_index * page_size
    query = db.query(SmartContractEventModel).order_by(desc(SmartContractEventModel.created_at))
    total_count = query.count()
    events = query.offset(skip).limit(page_size).all()
    items = [SmartContractEventResponse.model_validate(event) for event in events]
    return PagedSmartContractEventResponse(items=items, total_count=total_count)
