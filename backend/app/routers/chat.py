from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.security import get_current_user
from app.services import memory
from app.services.rag_pipeline import run_rag_turn
from app.services.summary import generate_summary_block
from app.rate_limit import authenticated_user_key, limiter, request_has_byok

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.post("", response_model=schemas.ChatResponse)
@limiter.limit("30/minute", key_func=authenticated_user_key, exempt_when=request_has_byok)
def chat_turn(request: Request, payload: schemas.ChatRequest, db: Session = Depends(get_db),
              current_user: models.User = Depends(get_current_user)):
    if not payload.document_ids:
        raise HTTPException(status_code=400, detail="Select at least one document to chat with")

    docs = db.query(models.Document).filter(
        models.Document.id.in_(payload.document_ids),
        models.Document.owner_id == current_user.id,
    ).all()
    if len(docs) != len(payload.document_ids):
        raise HTTPException(status_code=404, detail="One or more documents not found")

    api_key = payload.user_api_key.api_key if payload.user_api_key else None

    session = memory.get_or_create_session(db, current_user.id, payload.session_id, payload.document_ids)
    history = memory.build_history_string(db, session.id)

    rag_result = run_rag_turn(db, payload.document_ids, payload.message, api_key=api_key, chat_history=history)

    summary_block = generate_summary_block(payload.message, rag_result.answer_text,
                                            rag_result.used_chunks, api_key=api_key)

    assistant_msg = memory.save_turn(db, session.id, payload.message, rag_result)
    memory.update_rolling_summary(db, session, api_key=api_key)
    assistant_msg.summary = summary_block
    db.commit()

    return schemas.ChatResponse(
        session_id=session.id,
        message_id=assistant_msg.id,
        answer=rag_result.answer_text,
        citations=rag_result.citations,
        summary=schemas.SummaryBlock(**summary_block),
        confidence_score=rag_result.confidence_score,
        hallucination_flag=rag_result.hallucination_flag,
        highlighted_sections=rag_result.highlighted,
    )


@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    sessions = db.query(models.ChatSession).filter(models.ChatSession.owner_id == current_user.id).all()
    return [{"id": s.id, "title": s.title, "document_ids": s.document_ids, "created_at": s.created_at} for s in sessions]


@router.get("/sessions/{session_id}/messages")
def get_session_messages(session_id: str, db: Session = Depends(get_db),
                          current_user: models.User = Depends(get_current_user)):
    session = db.query(models.ChatSession).filter(models.ChatSession.id == session_id,
                                                     models.ChatSession.owner_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return [
        {
            "role": m.role, "content": m.content, "citations": m.citations,
            "summary": m.summary, "confidence_score": m.confidence_score,
            "hallucination_flag": m.hallucination_flag,
            "highlighted_sections": m.highlighted_sections,
            "created_at": m.created_at,
        }
        for m in session.messages
    ]
