import uuid
import enum
from datetime import datetime

from sqlalchemy import (
    Column, String, Integer, Float, Text, Boolean, DateTime, ForeignKey,
    Enum, JSON, Uuid, Index, UniqueConstraint
)
from sqlalchemy.orm import relationship

from app.database import Base


def gen_uuid():
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    email = Column(String, unique=True, index=True, nullable=False)
    full_name = Column(String, nullable=True)
    hashed_password = Column(String, nullable=True)  # null if OAuth-only account
    oauth_provider = Column(String, nullable=True)    # "google" or None
    oauth_sub = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    is_verified = Column(Boolean, default=False, nullable=False)
    failed_login_count = Column(Integer, default=0, nullable=False)
    locked_until = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    documents = relationship("Document", back_populates="owner", cascade="all, delete-orphan")
    sessions = relationship("ChatSession", back_populates="owner", cascade="all, delete-orphan")


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"

    jti = Column(String, primary_key=True)
    user_id = Column(Uuid(as_uuid=False), nullable=True, index=True)
    expires_at = Column(DateTime, nullable=False)


class DocumentStatus(str, enum.Enum):
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class Document(Base):
    __tablename__ = "documents"

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    owner_id = Column(Uuid(as_uuid=False), ForeignKey("users.id"), nullable=False)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False)
    page_count = Column(Integer, default=0)
    used_ocr = Column(Boolean, default=False)
    status = Column(Enum(DocumentStatus), default=DocumentStatus.PROCESSING)
    collection_name = Column(String, nullable=False)  # chroma collection this doc's chunks live in
    doc_metadata = Column(JSON, default=dict)  # {title, author, summary, key_insights, ...}
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="documents")
    chunks = relationship("Chunk", back_populates="document", cascade="all, delete-orphan")


class Chunk(Base):
    """
    Mirrors what's stored in Chroma, but kept in Postgres too so we can do
    exact keyword/BM25 search and show precise citation metadata
    (page number + line range) without round-tripping through the vector DB.
    """
    __tablename__ = "chunks"

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    document_id = Column(Uuid(as_uuid=False), ForeignKey("documents.id"), nullable=False)
    chunk_index = Column(Integer, nullable=False)
    page_number = Column(Integer, nullable=False)
    line_start = Column(Integer, nullable=True)
    line_end = Column(Integer, nullable=True)
    text = Column(Text, nullable=False)
    is_ocr = Column(Boolean, default=False)

    document = relationship("Document", back_populates="chunks")


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    owner_id = Column(Uuid(as_uuid=False), ForeignKey("users.id"), nullable=False)
    title = Column(String, default="New Chat")
    document_ids = Column(JSON, default=list)  # list of document ids in scope for this session
    rolling_summary = Column(Text, nullable=True)
    rolling_summary_through = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("User", back_populates="sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan",
                             order_by="ChatMessage.created_at")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    session_id = Column(Uuid(as_uuid=False), ForeignKey("chat_sessions.id"), nullable=False)
    role = Column(String, nullable=False)  # "user" | "assistant"
    content = Column(Text, nullable=False)

    # assistant-only fields
    citations = Column(JSON, default=list)       # [{document_id, filename, page, line_start, line_end, snippet}]
    summary = Column(JSON, default=dict)          # {short_summary, key_insights[], conclusion}
    confidence_score = Column(Float, nullable=True)
    hallucination_flag = Column(Boolean, default=False)
    highlighted_sections = Column(JSON, default=list)

    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("ChatSession", back_populates="messages")


class QuizFlashcardSet(Base):
    __tablename__ = "quiz_flashcard_sets"

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    owner_id = Column(Uuid(as_uuid=False), ForeignKey("users.id"), nullable=False)
    document_id = Column(Uuid(as_uuid=False), ForeignKey("documents.id"), nullable=False)
    kind = Column(String, nullable=False)  # "quiz" | "flashcards" | "questionnaire"
    title = Column(String, default="Untitled Set")
    items = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow)


class FlashcardProgress(Base):
    __tablename__ = "flashcard_progress"
    __table_args__ = (
        UniqueConstraint("user_id", "flashcard_id", name="uq_flashcard_progress_user_card"),
        Index("ix_flashcard_progress_due", "user_id", "next_review_at"),
    )

    id = Column(Uuid(as_uuid=False), primary_key=True, default=gen_uuid)
    user_id = Column(Uuid(as_uuid=False), ForeignKey("users.id"), nullable=False)
    flashcard_id = Column(String, nullable=False)
    ease_factor = Column(Float, default=2.5, nullable=False)
    interval_days = Column(Integer, default=0, nullable=False)
    next_review_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_reviewed_at = Column(DateTime, nullable=True)
