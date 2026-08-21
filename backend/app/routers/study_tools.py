from datetime import datetime, timedelta
import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.security import get_current_user
from app.services import questionnaire as questionnaire_service
from app.services import quiz_flashcards
from app.services.openrouter_client import OpenRouterError
from app.rate_limit import authenticated_user_key, limiter, request_has_byok

router = APIRouter(prefix="/api/study", tags=["study-tools"])


def _run_generation(func, *args, **kwargs):
    """Generation calls out to the LLM; surface a clear 502 instead of a
    bare 500 when the provider call itself fails (bad/missing key, rate
    limit, malformed JSON, etc.) so the frontend can show a real reason."""
    try:
        return func(*args, **kwargs)
    except (OpenRouterError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Generation failed: {exc}") from exc


def _assert_owned(db: Session, document_id: str, user_id: str) -> models.Document:
    doc = db.query(models.Document).filter(models.Document.id == document_id,
                                             models.Document.owner_id == user_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.status != models.DocumentStatus.READY:
        raise HTTPException(status_code=409, detail=f"Document is not ready yet (status={doc.status})")
    return doc


@router.post("/questionnaire")
@limiter.limit("30/minute", key_func=authenticated_user_key, exempt_when=request_has_byok)
def generate_questionnaire(request: Request, payload: schemas.QuestionnaireRequest, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    doc = _assert_owned(db, payload.document_id, current_user.id)
    api_key = payload.user_api_key.api_key if payload.user_api_key else None
    items = _run_generation(
        questionnaire_service.generate_questionnaire,
        db, payload.document_id, payload.num_questions, payload.difficulty,
        question_types=payload.question_types, api_key=api_key,
    )
    record = models.QuizFlashcardSet(owner_id=current_user.id, document_id=doc.id, kind="questionnaire",
                                       title=f"Questionnaire - {doc.filename}", items=items)
    db.add(record)
    db.commit()
    db.refresh(record)
    return {"set_id": record.id, "items": items}


@router.post("/quiz")
@limiter.limit("30/minute", key_func=authenticated_user_key, exempt_when=request_has_byok)
def generate_quiz(request: Request, payload: schemas.QuizRequest, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    doc = _assert_owned(db, payload.document_id, current_user.id)
    api_key = payload.user_api_key.api_key if payload.user_api_key else None
    items = _run_generation(quiz_flashcards.generate_quiz, db, payload.document_id, payload.num_questions,
                             payload.difficulty, api_key=api_key)
    record = models.QuizFlashcardSet(owner_id=current_user.id, document_id=doc.id, kind="quiz",
                                       title=f"Quiz - {doc.filename}", items=items)
    db.add(record)
    db.commit()
    db.refresh(record)
    return {"set_id": record.id, "items": items}


@router.post("/flashcards")
@limiter.limit("30/minute", key_func=authenticated_user_key, exempt_when=request_has_byok)
def generate_flashcards(request: Request, payload: schemas.FlashcardRequest, db: Session = Depends(get_db),
                         current_user: models.User = Depends(get_current_user)):
    doc = _assert_owned(db, payload.document_id, current_user.id)
    api_key = payload.user_api_key.api_key if payload.user_api_key else None
    items = _run_generation(quiz_flashcards.generate_flashcards, db, payload.document_id, payload.num_cards,
                             payload.difficulty, api_key=api_key)
    items = [
        {**item, "id": item.get("id") or str(uuid.uuid4())}
        for item in items
        if isinstance(item, dict)
    ]
    record = models.QuizFlashcardSet(owner_id=current_user.id, document_id=doc.id, kind="flashcards",
                                       title=f"Flashcards - {doc.filename}", items=items)
    db.add(record)
    db.commit()
    db.refresh(record)
    for item in items:
        db.add(
            models.FlashcardProgress(
                user_id=current_user.id,
                flashcard_id=item["id"],
                next_review_at=datetime.utcnow(),
            )
        )
    db.commit()
    return {"set_id": record.id, "items": items}


def _find_flashcard(db: Session, user_id: str, flashcard_id: str):
    sets = db.query(models.QuizFlashcardSet).filter(
        models.QuizFlashcardSet.owner_id == user_id,
        models.QuizFlashcardSet.kind == "flashcards",
    ).all()
    for record in sets:
        for item in record.items or []:
            if isinstance(item, dict) and item.get("id") == flashcard_id:
                return record, item
    return None, None


@router.post("/flashcards/{flashcard_id}/review", response_model=schemas.FlashcardProgressOut)
def review_flashcard(
    flashcard_id: str,
    payload: schemas.FlashcardReviewRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    record, item = _find_flashcard(db, current_user.id, flashcard_id)
    if not record or not item:
        raise HTTPException(status_code=404, detail="Flashcard not found")

    now = datetime.utcnow()
    progress = db.query(models.FlashcardProgress).filter(
        models.FlashcardProgress.user_id == current_user.id,
        models.FlashcardProgress.flashcard_id == flashcard_id,
    ).first()
    if not progress:
        progress = models.FlashcardProgress(
            user_id=current_user.id,
            flashcard_id=flashcard_id,
            next_review_at=now,
        )
        db.add(progress)
        db.flush()

    quality = payload.quality
    if quality < 3:
        # A failed recall is immediately due again. This keeps a hard card in
        # the due queue while still following SM-2's ease-factor adjustment.
        progress.interval_days = 0
        progress.ease_factor = max(
            1.3,
            progress.ease_factor - 0.2,
        )
    else:
        if progress.interval_days <= 0:
            interval_days = 1
        elif progress.interval_days == 1:
            interval_days = 6
        else:
            interval_days = max(1, math.ceil(progress.interval_days * progress.ease_factor))
        progress.interval_days = interval_days
        progress.ease_factor = max(
            1.3,
            progress.ease_factor + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02),
        )

    progress.last_reviewed_at = now
    progress.next_review_at = now + timedelta(days=progress.interval_days)
    db.commit()
    db.refresh(progress)
    return progress


@router.get("/flashcards/due", response_model=list[schemas.DueFlashcardOut])
def due_flashcards(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    now = datetime.utcnow()
    progress_rows = db.query(models.FlashcardProgress).filter(
        models.FlashcardProgress.user_id == current_user.id,
        models.FlashcardProgress.next_review_at <= now,
    ).order_by(models.FlashcardProgress.next_review_at.asc()).all()
    sets = db.query(models.QuizFlashcardSet).filter(
        models.QuizFlashcardSet.owner_id == current_user.id,
        models.QuizFlashcardSet.kind == "flashcards",
    ).all()
    cards = {
        item.get("id"): (record.id, item)
        for record in sets
        for item in (record.items or [])
        if isinstance(item, dict) and item.get("id")
    }
    return [
        {
            "flashcard_id": progress.flashcard_id,
            "set_id": cards[progress.flashcard_id][0],
            "front": cards[progress.flashcard_id][1].get("front", ""),
            "back": cards[progress.flashcard_id][1].get("back", ""),
            "source_page": cards[progress.flashcard_id][1].get("source_page"),
            "ease_factor": progress.ease_factor,
            "interval_days": progress.interval_days,
            "next_review_at": progress.next_review_at,
            "last_reviewed_at": progress.last_reviewed_at,
        }
        for progress in progress_rows
        if progress.flashcard_id in cards
    ]


@router.get("/sets", response_model=list[schemas.StudySetSummary])
def list_sets(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Recent quiz/flashcard/questionnaire sets for the History / Overview views."""
    records = (
        db.query(models.QuizFlashcardSet)
        .filter(models.QuizFlashcardSet.owner_id == current_user.id)
        .order_by(models.QuizFlashcardSet.created_at.desc())
        .limit(100)
        .all()
    )
    doc_ids = {record.document_id for record in records}
    docs = {
        doc.id: doc.filename
        for doc in db.query(models.Document).filter(models.Document.id.in_(doc_ids)).all()
    } if doc_ids else {}
    return [
        {
            "id": record.id,
            "kind": record.kind,
            "title": record.title,
            "document_id": record.document_id,
            "document_filename": docs.get(record.document_id),
            "item_count": len(record.items or []),
            "created_at": record.created_at,
        }
        for record in records
    ]


@router.get("/sets/{set_id}")
def get_set(set_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    record = db.query(models.QuizFlashcardSet).filter(models.QuizFlashcardSet.id == set_id,
                                                         models.QuizFlashcardSet.owner_id == current_user.id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Set not found")
    return {"set_id": record.id, "kind": record.kind, "title": record.title, "items": record.items}
