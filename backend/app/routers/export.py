from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.security import get_current_user
from app.services import export_service

router = APIRouter(prefix="/api/export", tags=["export"])

MEDIA_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "markdown": "text/markdown",
    "json": "application/json",
}


def _build_payload(db: Session, kind: str, ref_id: str, user_id: str) -> dict:
    if kind == "chat":
        session = db.query(models.ChatSession).filter(models.ChatSession.id == ref_id,
                                                         models.ChatSession.owner_id == user_id).first()
        if not session:
            raise HTTPException(status_code=404, detail="Chat session not found")
        return {"messages": [
            {"role": m.role, "content": m.content, "citations": m.citations} for m in session.messages
        ]}

    if kind == "summary":
        message = db.query(models.ChatMessage).join(models.ChatSession).filter(
            models.ChatMessage.id == ref_id, models.ChatSession.owner_id == user_id
        ).first()
        if not message:
            raise HTTPException(status_code=404, detail="Message not found")
        return message.summary or {}

    if kind in ("quiz", "flashcards", "questionnaire"):
        record = db.query(models.QuizFlashcardSet).filter(
            models.QuizFlashcardSet.id == ref_id, models.QuizFlashcardSet.owner_id == user_id
        ).first()
        if not record:
            raise HTTPException(status_code=404, detail="Set not found")
        return {"items": record.items}

    if kind == "comparison":
        raise HTTPException(status_code=400, detail="Comparison exports require the comparison result payload")

    raise HTTPException(status_code=400, detail=f"Unknown export kind: {kind}")


@router.post("")
def export_artifact(payload: schemas.ExportRequest, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    data = payload.data if payload.kind == "comparison" and payload.data is not None else _build_payload(
        db, payload.kind, payload.ref_id, current_user.id
    )
    out_name = f"{payload.kind}_{payload.ref_id}"
    try:
        path = export_service.export(payload.kind, data, payload.format, out_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return FileResponse(path, media_type=MEDIA_TYPES[payload.format], filename=path.split("/")[-1])
