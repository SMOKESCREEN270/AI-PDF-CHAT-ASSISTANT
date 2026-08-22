import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app import models, schemas
from app.security import get_current_user
from app.services import memory
from app.services.rag_pipeline import run_rag_turn
from app.services.summary import generate_summary_block
from app.rate_limit import authenticated_user_key, limiter, request_has_byok

router = APIRouter(prefix="/api/chat", tags=["chat"])


def _get_owned_session(db: Session, session_id: str, owner_id: str) -> models.ChatSession:
    session = db.query(models.ChatSession).filter(
        models.ChatSession.id == session_id, models.ChatSession.owner_id == owner_id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


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
    memory.maybe_title_session(db, session, payload.message)
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
    return [
        {
            "id": s.id, "title": s.title, "document_ids": s.document_ids,
            "created_at": s.created_at, "project_id": s.project_id,
            "share_token": s.share_token,
        }
        for s in sessions
    ]


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


@router.patch("/sessions/{session_id}")
def rename_session(session_id: str, payload: schemas.ChatSessionRename, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    session = _get_owned_session(db, session_id, current_user.id)
    session.title = payload.title.strip() or session.title
    db.add(session)
    db.commit()
    return {"id": session.id, "title": session.title}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """Permanently deletes the chat session and every message in it.

    This is a real DB delete (`db.delete` + `db.commit`), not a soft/hide
    flag - `ChatSession.messages` cascades with `delete-orphan` (see
    models.py), so the row and all its `chat_messages` rows are gone from
    Postgres once this returns, not just hidden from the sidebar.
    """
    session = _get_owned_session(db, session_id, current_user.id)
    project = session.project
    db.delete(session)
    db.commit()
    if project:
        memory.update_project_memory(db, project)
        db.commit()
    return {"status": "deleted"}


@router.post("/sessions/{session_id}/share", response_model=schemas.ShareLinkOut)
def share_session(session_id: str, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    session = _get_owned_session(db, session_id, current_user.id)
    if not session.share_token:
        session.share_token = secrets.token_urlsafe(24)
        db.add(session)
        db.commit()
    share_url = f"{settings.FRONTEND_URL.rstrip('/')}/shared/{session.share_token}"
    return schemas.ShareLinkOut(share_token=session.share_token, share_url=share_url)


@router.delete("/sessions/{session_id}/share")
def unshare_session(session_id: str, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    session = _get_owned_session(db, session_id, current_user.id)
    session.share_token = None
    db.add(session)
    db.commit()
    return {"status": "unshared"}


@router.get("/shared/{share_token}")
def get_shared_session(share_token: str, db: Session = Depends(get_db)):
    """Public, read-only view of a shared chat - intentionally has no auth
    dependency, since the whole point of a share link is that anyone holding
    it can open it. Only the messages are exposed, never the owner's other
    sessions/documents/account details."""
    session = db.query(models.ChatSession).filter(models.ChatSession.share_token == share_token).first()
    if not session:
        raise HTTPException(status_code=404, detail="This share link is invalid or has been revoked")
    return {
        "title": session.title,
        "created_at": session.created_at,
        "messages": [
            {
                "role": m.role, "content": m.content, "citations": m.citations,
                "summary": m.summary, "confidence_score": m.confidence_score,
                "hallucination_flag": m.hallucination_flag,
                "highlighted_sections": m.highlighted_sections,
                "created_at": m.created_at,
            }
            for m in session.messages
        ],
    }


@router.patch("/sessions/{session_id}/project")
def move_session_to_project(session_id: str, payload: schemas.ChatSessionMove, db: Session = Depends(get_db),
                             current_user: models.User = Depends(get_current_user)):
    """Adds/removes a chat to a project/folder. Both the old and new
    project's AI memory are regenerated so a project's memory never lags
    behind which chats actually belong to it."""
    session = _get_owned_session(db, session_id, current_user.id)
    old_project = session.project

    new_project = None
    if payload.project_id:
        new_project = db.query(models.Project).filter(
            models.Project.id == payload.project_id, models.Project.owner_id == current_user.id,
        ).first()
        if not new_project:
            raise HTTPException(status_code=404, detail="Project not found")

    session.project_id = new_project.id if new_project else None
    db.add(session)
    db.commit()

    if old_project and (not new_project or old_project.id != new_project.id):
        memory.update_project_memory(db, old_project)
    if new_project:
        memory.update_project_memory(db, new_project)
    db.commit()

    return {"id": session.id, "project_id": session.project_id}
