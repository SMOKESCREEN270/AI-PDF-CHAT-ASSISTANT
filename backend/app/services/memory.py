"""Persistent chat memory with a rolling summary for older turns."""
from typing import List
from sqlalchemy.orm import Session

from app import models
from app.services import llm

MAX_HISTORY_TURNS = 6
SUMMARY_AFTER_TURNS = 10

MEMORY_SUMMARY_SYSTEM_INSTRUCTION = (
    "You maintain a compact, factual memory of a document-chat conversation. "
    "Preserve facts, definitions, decisions, names, numbers, and unresolved "
    "questions that may be needed in later turns. Do not invent information. "
    "Return only a concise plain-text context block, without headings or "
    "commentary about the summarization process."
)


def get_or_create_session(db: Session, owner_id: str, session_id: str = None,
                           document_ids: List[str] = None) -> models.ChatSession:
    if session_id:
        session = (
            db.query(models.ChatSession)
            .filter(models.ChatSession.id == session_id, models.ChatSession.owner_id == owner_id)
            .first()
        )
        if session:
            return session

    session = models.ChatSession(owner_id=owner_id, document_ids=document_ids or [])
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def maybe_title_session(db: Session, session: "models.ChatSession", first_message: str) -> None:
    """Give a new session a real title from its first message, Claude-style,
    instead of leaving every session labelled with the generic default. Only
    fires once - on the very first turn - so it never overwrites a title a
    later feature (or the user) sets explicitly."""
    if session.title and session.title != "New Chat":
        return
    cleaned = " ".join((first_message or "").split())
    if not cleaned:
        return
    title = cleaned if len(cleaned) <= 60 else cleaned[:57].rstrip() + "..."
    session.title = title
    db.add(session)


def build_history_string(db: Session, session_id: str) -> str:
    session = db.query(models.ChatSession).filter(models.ChatSession.id == session_id).first()
    messages = (
        db.query(models.ChatMessage)
        .filter(models.ChatMessage.session_id == session_id)
        .order_by(models.ChatMessage.created_at.desc())
        .limit(MAX_HISTORY_TURNS * 2)
        .all()
    )
    messages = list(reversed(messages))
    lines = []
    if session and session.rolling_summary:
        lines.append(f"ROLLING CONVERSATION MEMORY:\n{session.rolling_summary}")
    for m in messages:
        speaker = "User" if m.role == "user" else "Assistant"
        lines.append(f"{speaker}: {m.content}")
    return "\n".join(lines)


def _format_messages(messages: List[models.ChatMessage]) -> str:
    return "\n".join(
        f"{'User' if message.role == 'user' else 'Assistant'}: {message.content}"
        for message in messages
    )


def update_rolling_summary(
    db: Session, session: models.ChatSession, api_key: str = None
) -> None:
    """Summarize newly archived turns once a session grows beyond recent memory."""
    messages = (
        db.query(models.ChatMessage)
        .filter(models.ChatMessage.session_id == session.id)
        .order_by(models.ChatMessage.created_at.asc())
        .all()
    )
    recent_message_count = MAX_HISTORY_TURNS * 2
    archive_count = max(0, len(messages) - recent_message_count)
    if len(messages) <= SUMMARY_AFTER_TURNS * 2:
        return

    summarized_through = session.rolling_summary_through or 0
    if archive_count <= summarized_through:
        return

    newly_archived = messages[summarized_through:archive_count]
    prior_summary = session.rolling_summary or "(No earlier memory has been recorded.)"
    prompt = (
        f"PREVIOUS ROLLING MEMORY:\n{prior_summary}\n\n"
        "NEWLY ARCHIVED CONVERSATION TURNS:\n"
        f"{_format_messages(newly_archived)}\n\n"
        "Update the rolling memory so it retains the important facts from both "
        "the previous memory and these newly archived turns."
    )
    try:
        summary = llm.generate(
            prompt,
            api_key=api_key,
            system_instruction=MEMORY_SUMMARY_SYSTEM_INSTRUCTION,
            temperature=0.1,
        ).strip()
    except Exception:
        # A memory refresh must never make an otherwise successful chat turn fail.
        return

    if summary:
        session.rolling_summary = summary
        session.rolling_summary_through = archive_count
        db.add(session)


def save_turn(db: Session, session_id: str, user_message: str, rag_result) -> models.ChatMessage:
    # citations/summary/highlighted_sections are assistant-only fields. Leave
    # them as None (not the column's empty-dict/list default) on the user
    # message - an empty dict is still truthy, and the frontend's `message.summary && ...`
    # check would otherwise treat every reloaded user message as if it had
    # a real summary to render, crashing on the missing nested fields.
    user_msg = models.ChatMessage(
        session_id=session_id, role="user", content=user_message,
        citations=None, summary=None, highlighted_sections=None,
    )
    db.add(user_msg)

    assistant_msg = models.ChatMessage(
        session_id=session_id,
        role="assistant",
        content=rag_result.answer_text,
        citations=rag_result.citations,
        confidence_score=rag_result.confidence_score,
        hallucination_flag=rag_result.hallucination_flag,
        highlighted_sections=rag_result.highlighted,
    )
    db.add(assistant_msg)
    db.commit()
    db.refresh(assistant_msg)
    return assistant_msg
