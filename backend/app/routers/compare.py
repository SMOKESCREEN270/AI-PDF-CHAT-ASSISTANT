from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.security import get_current_user
from app.services import comparison as comparison_service
from app.rate_limit import authenticated_user_key, limiter, request_has_byok

router = APIRouter(prefix="/api/compare", tags=["compare"])


@router.post("")
@limiter.limit("30/minute", key_func=authenticated_user_key, exempt_when=request_has_byok)
def compare_documents(request: Request, payload: schemas.CompareRequest, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    if len(payload.document_ids) < 2:
        raise HTTPException(status_code=400, detail="Select at least 2 documents to compare")

    docs = db.query(models.Document).filter(
        models.Document.id.in_(payload.document_ids),
        models.Document.owner_id == current_user.id,
    ).all()
    if len(docs) != len(payload.document_ids):
        raise HTTPException(status_code=404, detail="One or more documents not found")

    api_key = payload.user_api_key.api_key if payload.user_api_key else None
    result = comparison_service.compare_documents(db, payload.document_ids, payload.scenario_context, api_key=api_key)
    return result
