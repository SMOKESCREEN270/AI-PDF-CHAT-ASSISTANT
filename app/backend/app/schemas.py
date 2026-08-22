from typing import Optional, List, Any, Dict
from datetime import datetime
from pydantic import BaseModel, EmailStr, Field


# ---------- Auth ----------
class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: Optional[str] = None


class UserOut(BaseModel):
    id: str
    email: EmailStr
    full_name: Optional[str] = None
    is_verified: bool = False
    verification_token: Optional[str] = None

    class Config:
        from_attributes = True


class LoginResponse(UserOut):
    access_token: str
    token_type: str = "bearer"


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetSubmit(BaseModel):
    token: str
    new_password: str = Field(min_length=8)


class EmailVerificationRequest(BaseModel):
    token: str


class AuthMessage(BaseModel):
    message: str
    reset_token: Optional[str] = None
    reset_link: Optional[str] = None


class DeactivateAccountRequest(BaseModel):
    current_password: str = Field(min_length=8)


# ---------- Documents ----------
class DocumentOut(BaseModel):
    id: str
    filename: str
    page_count: int
    used_ocr: bool
    status: str
    doc_metadata: Dict[str, Any] = {}
    created_at: datetime

    class Config:
        from_attributes = True


# ---------- Projects (folders) ----------
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ProjectOut(BaseModel):
    id: str
    name: str
    memory_summary: Optional[str] = None
    memory_updated_at: Optional[datetime] = None
    chat_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


# ---------- Chat ----------
class UserApiKey(BaseModel):
    """Optional bring-your-own-key, used per-request only, never stored."""
    provider: str = "openrouter"   # "openrouter" | "gemini" | "openai" | "anthropic" (extensible)
    api_key: Optional[str] = None


class ChatRequest(BaseModel):
    session_id: Optional[str] = None
    document_ids: List[str] = []
    message: str
    user_api_key: Optional[UserApiKey] = None


class Citation(BaseModel):
    document_id: str
    filename: str
    page: int
    line_start: Optional[int] = None
    line_end: Optional[int] = None
    snippet: str
    relevance_score: float


class SummaryBlock(BaseModel):
    short_summary: str
    key_insights: List[str]
    conclusion: str


class ChatSessionRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class ChatSessionMove(BaseModel):
    # Explicit field so `null` (move out of any project) is distinguishable
    # from "not provided" - Pydantic still requires the key to be present.
    project_id: Optional[str] = None


class ShareLinkOut(BaseModel):
    share_token: str
    share_url: str


class ChatResponse(BaseModel):
    session_id: str
    message_id: str
    answer: str
    citations: List[Citation]
    summary: SummaryBlock
    confidence_score: float
    hallucination_flag: bool
    highlighted_sections: List[Citation]


# ---------- Questionnaire ----------
class QuestionnaireRequest(BaseModel):
    document_id: str
    num_questions: int = Field(default=10, ge=3, le=25)
    difficulty: str = "mixed"  # easy | intermediate | advanced | mixed
    # Category keys, any of: knowledge, understanding, application, analysis,
    # evaluation, creation. Empty/omitted = spread across all categories.
    question_types: List[str] = []
    user_api_key: Optional[UserApiKey] = None


# ---------- Quiz / Flashcards ----------
class QuizRequest(BaseModel):
    document_id: str
    num_questions: int = Field(default=10, ge=3, le=25)
    difficulty: str = "mixed"  # easy | intermediate | advanced | mixed
    user_api_key: Optional[UserApiKey] = None


class FlashcardRequest(BaseModel):
    document_id: str
    num_cards: int = Field(default=15, ge=3, le=25)
    difficulty: str = "mixed"  # easy | intermediate | advanced | mixed
    user_api_key: Optional[UserApiKey] = None


class FlashcardReviewRequest(BaseModel):
    quality: int = Field(ge=0, le=5)


class FlashcardProgressOut(BaseModel):
    flashcard_id: str
    ease_factor: float
    interval_days: int
    next_review_at: datetime
    last_reviewed_at: Optional[datetime] = None


class DueFlashcardOut(FlashcardProgressOut):
    set_id: str
    front: str
    back: str
    source_page: Optional[int] = None


class StudySetSummary(BaseModel):
    id: str
    kind: str
    title: str
    document_id: str
    document_filename: Optional[str] = None
    item_count: int
    created_at: datetime


# ---------- Comparison ----------
class CompareRequest(BaseModel):
    document_ids: List[str]
    scenario_context: Optional[str] = None  # e.g. "for a beginner ML student"
    user_api_key: Optional[UserApiKey] = None


# ---------- Export ----------
class ExportRequest(BaseModel):
    kind: str  # "chat" | "summary" | "quiz" | "flashcards" | "questionnaire" | "comparison"
    ref_id: str  # session_id or set_id
    format: str = "pdf"  # pdf | docx | markdown | json
    data: Optional[Dict[str, Any]] = None  # used for an already-rendered comparison result
