# AI PDF Chat Assistant

CyberSNova AI Engineering Internship — Advanced Level, Option 1.

An AI-powered app that lets you upload PDFs (including scanned/photographed
pages) and chat with them using a RAG pipeline with hybrid (keyword +
semantic) search, line-level citations, confidence scoring, and hallucination
guarding — plus study tools (questionnaires, quizzes, flashcards) and a
document comparison mode.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React + Tailwind CSS (shadcn-style components) |
| Backend | FastAPI |
| AI Model | Google Gemini API (default key, or bring-your-own-key) |
| RAG orchestration | Custom pipeline (see `backend/app/services/rag_pipeline.py`) |
| PDF processing | PyMuPDF + Tesseract OCR fallback |
| Embeddings | Gemini Embeddings (`text-embedding-004`) |
| Vector DB | ChromaDB (per-document collections) |
| Keyword search | BM25 (`rank_bm25`), fused with vector search via Reciprocal Rank Fusion |
| Database | PostgreSQL (SQLAlchemy ORM) |
| Auth | JWT (OAuth2 password flow) + optional Google OAuth2 login |

## Production operations

### Transactional email

Password-reset and email-verification messages are sent through SMTP. Copy
`backend/.env.example` to `backend/.env` and set `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM_EMAIL`. Set
`FRONTEND_URL` to the public HTTPS address so links point back to the deployed
frontend. `SMTP_USE_TLS=true` is appropriate for most port 587 providers;
use `SMTP_USE_SSL=true` for providers that require implicit TLS on port 465.

When SMTP is not configured in development, the existing test token/link
response remains available. Production responses stay generic and never expose
reset or verification tokens.

### Run the full stack with Docker Compose

```bash
cp backend/.env.example backend/.env
# Set production secrets, database credentials, CORS_ORIGINS, FRONTEND_URL,
# and SMTP settings in the environment used by Compose.
docker compose up --build
```

The frontend is available on `http://localhost:3000` and the backend health
endpoint is available on `http://localhost:8000/health` (also aliased at
`/api/health`). Compose starts PostgreSQL, ClamAV, the FastAPI backend, and
the frontend container together.

### HTTPS reverse proxy

`deploy/nginx.conf` is a reference Nginx configuration for a TLS-terminating
proxy. Replace `app.example.com` and the certificate paths, make sure Nginx
can resolve the `frontend` and `backend` Compose services, and mount the
configuration and certificates into the Nginx container or host installation.
It redirects HTTP to HTTPS, forwards `/api/` to FastAPI, and forwards the
frontend routes to the static frontend container.

## Feature checklist

**Product features**
- [x] Multi-file upload, normal text extraction + automatic OCR fallback per page
- [x] Citation-based answering — every claim links to a specific document, page, and line range
- [x] Summary dashboard on every response (short summary + key insights + conclusion)
- [x] Questionnaire generator for students (objective / methodology / critical-analysis + general questions)
- [x] PDF chat memory (persisted per session, last N turns fed back into prompts)
- [x] Document comparison mode (dimension table + "best for which scenario")
- [x] Flashcard generation + interactive quiz mode
- [x] Always-on highlighted "important sections"
- [x] Export (chat / summary / quiz / flashcards / questionnaire) to PDF, DOCX, Markdown, JSON

**Technical requirements**
- [x] RAG architecture (`services/rag_pipeline.py`)
- [x] Hybrid search — BM25 keyword + Gemini-embedding semantic search, fused with RRF (`services/hybrid_search.py`)
- [x] Confidence score — weighted blend of retrieval strength, source agreement, and grounding ratio (`utils/confidence.py`)
- [x] Hallucination prevention — grounded prompting + sentence-level post-hoc grounding check (`utils/hallucination_check.py`)

## How the RAG pipeline works (for your report)

1. **Ingest**: PDF pages are text-extracted with PyMuPDF; any page with too
   little native text (scanned/photographed page) is rasterized and run
   through Tesseract OCR instead. Extracted lines keep their page + line
   number so every downstream chunk carries exact provenance.
2. **Chunk**: Lines are grouped into ~800-character overlapping chunks,
   still tagged with `(page, line_start, line_end)`.
3. **Embed & index**: Each chunk is embedded with Gemini's embedding model
   and stored in a per-document ChromaDB collection; the same chunk text is
   also stored in Postgres for exact-match BM25 keyword search.
4. **Retrieve (hybrid search)**: A query is embedded and matched
   semantically in Chroma, *and* matched via BM25 keyword scoring over
   Postgres chunk text. Both ranked lists are merged with **Reciprocal Rank
   Fusion**, so a chunk that ranks well on either signal surfaces near the
   top without needing to normalize two very different score scales.
5. **Generate (grounded)**: The top fused chunks are numbered as `[S1]`,
   `[S2]`, ... and given to Gemini with a system prompt that requires every
   claim to cite a source number and requires the model to say "I don't
   have enough information" rather than guess.
6. **Hallucination guard**: After generation, each sentence of the answer
   is checked for lexical grounding against the retrieved context. Weakly
   grounded answers get a visible warning banner instead of being presented
   as fact silently.
7. **Confidence score**: Combines retrieval strength (how strong the fused
   hybrid scores were), source agreement (how many independent
   pages/documents corroborate the answer), and the grounding ratio from
   step 6 into a single 0–100% score shown in the UI.
8. **Citations + highlights**: The chunks actually cited by the model are
   returned as citation cards; the highest-scoring subset is also
   surfaced as "important highlighted sections."

## Local setup

### 1. Prerequisites
- Python 3.11+
- Node.js 18+
- PostgreSQL (or run `docker compose up -d` from the project root to get one instantly)
- Tesseract OCR installed on your system (`apt install tesseract-ocr` on Ubuntu, `brew install tesseract` on macOS)
- ClamAV's `clamd` daemon (the included Docker Compose service is recommended)
- A free-tier Google Gemini API key (https://aistudio.google.com/apikey) — per the internship guidelines, free tier is sufficient

### 2. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# edit .env: set DATABASE_URL, JWT_SECRET_KEY, and DEFAULT_GEMINI_API_KEY

# Create or update the database schema through Alembic migrations
alembic upgrade head

uvicorn app.main:app --reload --port 8000
```

For local development, start PostgreSQL and the malware scanner from the project
root before launching the API:

```bash
cp backend/.env.example backend/.env
# Set DATABASE_URL to match the POSTGRES_USER and POSTGRES_PASSWORD values.
# Change POSTGRES_PASSWORD before using this outside a private local machine.
docker compose --env-file backend/.env up -d postgres clamav
```

The backend connects to ClamAV at `CLAMD_HOST:CLAMD_PORT` (defaults to
`localhost:3310`). If the scanner cannot be reached, uploads fail closed rather
than being written to permanent storage. An infected upload returns
`400 File failed security scan`. The `clamav` image downloads its signature
database on first startup, so its first health check can take a few minutes.

To audit the pinned Python dependencies, install the development requirements
and run:

```bash
pip install -r requirements-dev.txt
pip-audit -r requirements.txt
```

The audit includes the pinned `PyMuPDF`, `python-jose`, and `authlib` versions.

Database schema changes are owned by Alembic migrations. API docs are then available
at `http://localhost:8000/docs`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Visit `http://localhost:5173`, register an account, and start uploading PDFs.

### 4. Bring-your-own API key (optional)

Users can paste their own Gemini API key in the upload panel or via the
"Use my own Gemini API key" toggle. It's sent per-request only and is
**never persisted** on the server or in the database — see
`app/services/embeddings.py` and `app/services/llm.py`, both of which accept
an optional `api_key` override and fall back to the platform's default key
when none is supplied.

## Project structure

```
backend/
  app/
    main.py              FastAPI app + router wiring and rate limiting
    config.py             Settings (env-driven)
    database.py / models.py / schemas.py
    security.py            JWT + password hashing
    routers/                auth, documents, chat, study_tools, compare, export
    services/
      pdf_processor.py      OCR-aware PDF text extraction
      chunking.py            Line-provenance-preserving chunking
      embeddings.py / llm.py Gemini wrappers (default or user key)
      vector_store.py        ChromaDB wrapper
      hybrid_search.py       BM25 + semantic search, fused with RRF
      rag_pipeline.py        End-to-end RAG orchestration
      summary.py              Per-response summary dashboard
      questionnaire.py        Student questionnaire generator
      quiz_flashcards.py      Quiz + flashcard generation
      comparison.py            Document comparison mode
      memory.py                 Chat session persistence/history
      export_service.py         PDF/DOCX/Markdown/JSON exporters
       malware_scanner.py        ClamAV-backed upload scanning
    alembic/                    Versioned database migrations
    tests/                      SQLite-isolated endpoint tests
    utils/
      confidence.py            Confidence score calculation
      hallucination_check.py   Sentence-level grounding check
      highlighting.py          Important-section selection
frontend/
  src/
    api/client.js              Axios client + BYOK helper
    context/AuthContext.jsx    JWT session state
    components/                ChatWindow, UploadPanel, QuizMode, FlashcardDeck,
                                ComparisonTable, QuestionnaireGenerator, Sidebar, etc.
    pages/                     Login, Register, Dashboard
```

## Notes on the internship report

Per the CyberSNova guidelines, your report should be written in your own
words with screenshots of every feature, and should not be a copy of this
codebase's comments. Use the "How the RAG pipeline works" section above as
a starting point to explain the architecture in your own understanding —
don't paste it verbatim.
