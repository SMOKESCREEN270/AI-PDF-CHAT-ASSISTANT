# Review-round changes

## Root causes found & fixed

1. **Comparisons page failing ("Comparisons is not giving output... shows failed")**
   `Comparisons` never sent your BYOK OpenRouter key, unlike Chat and Study
   Tools — so it always fell back to the shared platform default key, and
   broke whenever that key was missing/expired/rate-limited.
   Fixed in `frontend/src/App.tsx` (`Comparisons`) — it now sends the stored
   key from `sessionStorage`, same as everywhere else. Also hardened
   `backend/app/routers/compare.py` to return a real `502` with a message
   instead of a bare `500` if the AI call itself ever fails again, so it's
   diagnosable at a glance next time.

2. **Sessions always labelled "New Chat"**
   `ChatSession.title` had a hardcoded default and nothing ever updated it.
   Added `memory.maybe_title_session()` (`backend/app/services/memory.py`),
   wired into `POST /api/chat` — the first message in a session now becomes
   its title, Claude-style. Never overwrites a title that's already set.

3. **Error boundary crash on resuming an old chat**
   `Chat` reset ~6 pieces of local state by hand in an effect whenever the
   active session changed, which is a classic source of stale-state bugs.
   Replaced with a `key={activeSessionId ?? 'new'}` remount (see `ChatRoute`
   in `App.tsx`) so switching sessions always starts from a clean slate by
   construction, and added a per-route `ErrorBoundary` in `Shell` so a crash
   on one page no longer needs a full reload to recover from.

## Frontend

- **Export buttons everywhere** (Quiz, Flashcards, Questionnaire, Chat):
  replaced the plain `<select>` + text-link with a colored segmented
  "PDF / Markdown / Word / JSON" pill picker plus a solid gold "Export…"
  button (`ExportControl` / `CombinedExportControl`, new `.export-bar` /
  `.format-pill` / `.export-go-button` styles in `index.css`).
- **Quiz / Flashcards / Questionnaire generation config**: added a
  number-of-questions slider (3–25), a difficulty picker (Easy /
  Intermediate / Advanced / Mixed), and — for Questionnaire — a checklist
  of the six question-type categories you specified (Knowledge,
  Understanding, Application, Analysis, Evaluation, Creation/problem-solving).
  Leaving all types unchecked spreads questions across every category.
- **One-question-at-a-time flow** for Quiz, Flashcards, and Questionnaire,
  replacing the grid. Each type now has a proper "submit" step that locks
  the answer/rating so it can't be changed after the fact, then a "Next"
  button to advance. Progress dots show where you are in the set.
- **Loading feedback**: generating a set or running a comparison now shows
  a spinner + "this can take a minute or two" message instead of leaving
  you guessing whether anything happened.
- **"Due for review" renamed to "Recall Queue"**.
- **New Overview page** (sidebar nav): recent chats and generated
  quiz/flashcard/questionnaire sets in one place, due-flashcard count, and
  one click back into any of them. This is the "dashboard" you asked for.

## Backend

- `schemas.py`: added `difficulty` to flashcard requests, `question_types`
  to questionnaire requests, and bounded all count fields to 3–25.
- `services/questionnaire.py`: rewritten to build prompts from your six
  category definitions and the requested difficulty.
- `services/quiz_flashcards.py`: flashcards now honor `difficulty` too.
- `routers/study_tools.py`: new `GET /api/study/sets` endpoint (title, kind,
  item count, source document name, created date) powering the Overview
  page's history list. Generation failures now surface as `502` with a
  real message instead of an opaque `500`.
- Backend test suite: **12/12 passing** (the original 8 plus 4 new
  regression tests covering session auto-titling, the `/study/sets`
  endpoint's per-user scoping, and the questionnaire category prompt
  builder). `pip-audit` still reports zero known vulnerabilities — no new
  dependencies were added.

## Verified before packaging

- `tsc --noEmit` clean, full `vite build` succeeds (frontend).
- `pytest tests/test_api.py` → 12 passed.
- `pip-audit -r requirements.txt` → no known vulnerabilities.

## Still worth doing (not in this pass — flagged, not forgotten)

- Reset-password page still shows the token in a visible field — flagged
  before as intentional/low-priority polish, unchanged here.
- `DEFAULT_GEMINI_API_KEY`/OpenRouter default-key health on SnapDeploy is a
  hosting/env-var concern, not a code bug — worth a fresh redeploy check
  now that Comparisons will actually surface *why* it fails if it ever does.
