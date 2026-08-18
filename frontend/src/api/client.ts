export type User = {
  id: string;
  email: string;
  full_name?: string | null;
  is_active?: boolean;
  is_verified?: boolean;
  verification_token?: string | null;
};

export type Document = {
  id: string;
  filename: string;
  page_count: number;
  used_ocr: boolean;
  status: 'processing' | 'ready' | 'failed' | string;
  doc_metadata: Record<string, unknown>;
  created_at: string;
};

export type Citation = {
  document_id: string;
  filename: string;
  page: number;
  line_start?: number | null;
  line_end?: number | null;
  snippet: string;
  relevance_score: number;
};

export type SummaryBlock = {
  short_summary: string;
  key_insights: string[];
  conclusion: string;
};

export type ChatResponse = {
  session_id: string;
  message_id: string;
  answer: string;
  citations: Citation[];
  summary: SummaryBlock;
  confidence_score: number;
  hallucination_flag: boolean;
  highlighted_sections: Citation[];
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  summary?: SummaryBlock;
  confidence_score?: number;
  hallucination_flag?: boolean;
  highlighted_sections?: Citation[];
  created_at?: string;
};

export type ChatSessionSummary = {
  id: string;
  title: string;
  document_ids: string[];
  created_at: string;
};

export type AuthMessage = {
  message: string;
  reset_token?: string | null;
  reset_link?: string | null;
};

export type StudyResponse<T> = { set_id: string; items: T[] };
export type QuizItem = {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  difficulty?: string;
  source_page?: number;
};
export type FlashcardItem = { id?: string; front: string; back: string; source_page?: number };
export type DueFlashcard = FlashcardItem & {
  flashcard_id: string;
  set_id: string;
  ease_factor: number;
  interval_days: number;
  next_review_at: string;
  last_reviewed_at?: string | null;
};
export type QuestionnaireItem = {
  question: string;
  type: string;
  difficulty?: string;
  model_answer: string;
  source_page?: number;
};
export type ComparisonResponse = {
  dimensions: string[];
  table: Array<{ document: string; values: Record<string, string> }>;
  recommendations: Array<{ scenario: string; best_document: string; reason: string }>;
};

type RequestOptions = RequestInit;

// In local dev (Vite proxy) or same-origin deployments this can stay empty,
// which keeps requests relative ("/api/..."). For a split deployment
// (e.g. frontend on Cloudflare Pages, backend on Render) set
// VITE_API_BASE_URL to the backend's full origin, no trailing slash,
// e.g. https://your-backend.onrender.com
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    ...options,
    headers,
    credentials: options.credentials ?? 'include',
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) message = body.detail;
    } catch {
      // Keep the HTTP status message when the server did not return JSON.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const client = {
  register(payload: { email: string; password: string; full_name?: string }) {
    return request<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  login(email: string, password: string) {
    const body = new URLSearchParams({ username: email, password });
    return request<User>('/auth/login', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  },
  me() {
    return request<User>('/auth/me');
  },
  logout() {
    return request<void>('/auth/logout', { method: 'POST' });
  },
  deactivateAccount(currentPassword: string) {
    return request<void>('/auth/deactivate', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword }),
    });
  },
  requestPasswordReset(email: string) {
    return request<AuthMessage>('/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },
  resetPassword(token: string, newPassword: string) {
    return request<AuthMessage>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, new_password: newPassword }),
    });
  },
  verifyEmail(token: string) {
    return request<AuthMessage>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  },
  googleLoginRedirect() {
    window.location.assign(`${API_BASE_URL}/api/auth/google/login`);
  },
  uploadDocuments(files: File[], geminiApiKey?: string) {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    if (geminiApiKey) form.append('gemini_api_key', geminiApiKey);
    return request<Document[]>('/documents/upload', { method: 'POST', body: form });
  },
  listDocuments() {
    return request<Document[]>('/documents');
  },
  deleteDocument(id: string) {
    return request<{ status: string }>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  chat(payload: {
    document_ids: string[];
    message: string;
    session_id?: string | null;
    user_api_key?: { provider: string; api_key: string } | null;
  }) {
    return request<ChatResponse>('/chat', { method: 'POST', body: JSON.stringify(payload) });
  },
  listSessions() {
    return request<ChatSessionSummary[]>('/chat/sessions');
  },
  getSessionMessages(sessionId: string) {
    return request<ChatMessage[]>(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
  },
  generateQuestionnaire(payload: { document_id: string; num_questions?: number; difficulty?: string; user_api_key?: { provider: string; api_key: string } | null }) {
    return request<StudyResponse<QuestionnaireItem>>('/study/questionnaire', { method: 'POST', body: JSON.stringify(payload) });
  },
  generateQuiz(payload: { document_id: string; num_questions?: number; difficulty?: string; user_api_key?: { provider: string; api_key: string } | null }) {
    return request<StudyResponse<QuizItem>>('/study/quiz', { method: 'POST', body: JSON.stringify(payload) });
  },
  generateFlashcards(payload: { document_id: string; num_cards?: number; user_api_key?: { provider: string; api_key: string } | null }) {
    return request<StudyResponse<FlashcardItem>>('/study/flashcards', { method: 'POST', body: JSON.stringify(payload) });
  },
  reviewFlashcard(flashcardId: string, quality: number) {
    return request<{ flashcard_id: string; ease_factor: number; interval_days: number; next_review_at: string; last_reviewed_at?: string | null }>(
      `/study/flashcards/${encodeURIComponent(flashcardId)}/review`,
      { method: 'POST', body: JSON.stringify({ quality }) },
    );
  },
  getDueFlashcards() {
    return request<DueFlashcard[]>('/study/flashcards/due');
  },
  getStudySet(setId: string) {
    return request<{ set_id: string; kind: string; title: string; items: unknown[] }>(`/study/sets/${encodeURIComponent(setId)}`);
  },
  compareDocuments(payload: { document_ids: string[]; scenario_context?: string; user_api_key?: { provider: string; api_key: string } | null }) {
    return request<ComparisonResponse>('/compare', { method: 'POST', body: JSON.stringify(payload) });
  },
  exportArtifact(payload: { kind: string; ref_id: string; format?: string; data?: Record<string, unknown> }) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    return fetch(`${API_BASE_URL}/api/export`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(payload),
    }).then(async (response) => {
      if (!response.ok) {
        let detail = `Export failed (${response.status})`;
        try {
          const body = await response.json() as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {
          // Keep the status when the server did not return JSON.
        }
        throw new Error(detail);
      }
      return response.blob();
    });
  },
};