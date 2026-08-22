# Projects, chat sharing/organizing, and stability fixes

## 1. Confirmed bug: couldn't deselect a PDF in Chat

**Root cause**: in `Chat` (`frontend/src/App.tsx`), the "pick a default
document for a new chat" effect depended on `chosen.length`. Unchecking your
only selected document brought `chosen.length` back to `0`, which made the
*same* effect fire again and silently re-select a document - so it looked
like unchecking simply didn't work unless you first selected a second
document (which stopped the count from ever hitting zero on that render).

**Fix**: the auto-select now runs at most once per new chat (tracked with a
`useRef`, reset naturally because `Chat` remounts on `key={activeSessionId}`),
so a deliberate deselect down to zero documents is never overridden again.

## 2. "Aw, Snap! Out of memory" investigation

I don't have your Neon/SnapDeploy dashboards or browser console output (no
screenshots came through with the zip - only the project files), so I can't
give you a single confirmed root cause with certainty from static code
review alone. What I found and fixed, in order of likelihood:

- **Most likely**: `PdfViewer`'s source panel renders scanned/photographed
  pages (this app's own OCR fallback path) through PDF.js at a fairly large
  canvas width. Rendering a large raster image into an HTML canvas at a high
  `devicePixelRatio` is a well-documented way to blow past a tab's available
  memory and hit exactly this Chrome crash page - it gets worse the more
  citations you open in the same tab without a full reload. I lowered the
  max render width (`680` → `560`), turned off the unused annotation layer
  (one less thing PDF.js has to allocate per render), and gave the PDF
  `<Document>` an explicit `key` so switching between different source PDFs
  fully unmounts and releases the previous one instead of trying to reuse
  it in place.
- **Also worth checking on your end**: `CHROMA_PERSIST_DIR` and `UPLOAD_DIR`
  (`backend/app/config.py`) are local-disk paths. If SnapDeploy's container
  filesystem is ephemeral (wiped on redeploy/restart), your vector index and
  uploaded PDFs disappear even though the Postgres `documents` rows survive -
  the document still shows "Ready" but has nothing behind it. That would
  match "even a PDF that used to work now doesn't." If your dashboard shows
  memory *and* disk graphs, a disk-usage cliff right at redeploy time would
  confirm this - point SnapDeploy's volume mount at both directories if so.
- If it still reproduces after this, the most useful next step is the
  browser console (not just the crash page) and whether it happens with a
  freshly opened tab on the very first PDF you open, since that will tell us
  whether it's a one-shot allocation (points at one huge scanned PDF) or a
  slow leak across several actions (points at something not being released
  between renders).

## 3. Chat deletion now actually deletes from Postgres

There was no delete endpoint at all before this - History had no way to
remove a chat. Added `DELETE /api/chat/sessions/{id}`
(`backend/app/routers/chat.py`), wired to a real `db.delete(session)` +
`db.commit()`. `ChatSession.messages` already cascades with
`delete-orphan` (`backend/app/models.py`), so every `chat_messages` row for
that session is removed in the same transaction - not a soft-hide flag.
Covered by `test_deleting_a_chat_session_removes_it_and_its_messages_from_the_database`.

## 4. Checked: deleted PDFs and their vector data

`DELETE /api/documents/{id}` (`backend/app/routers/documents.py`) already
did this correctly before my changes: it drops the document's Chroma
collection, removes the file from `UPLOAD_DIR` on disk, and deletes the
Postgres row (which cascades to delete every `chunks` row for that
document). If a deleted PDF still shows up somewhere, it's most likely the
ephemeral-storage issue in section 2, not a soft-delete bug in the code.

## 5. New: Projects (folders), capped at 2

- `Project` model + `20260822_0006` migration (`backend/app/models.py`,
  `backend/alembic/versions/`): name, and an AI-maintained `memory_summary`.
- `backend/app/routers/projects.py`: create (capped at 2 per user, `400` past
  that), list, rename, delete. Deleting a project un-files its chats rather
  than deleting them - a folder is organizational, not a trash can.
- `services/memory.update_project_memory()`: regenerates the project's
  memory from the rolling summaries (or recent turns, for short chats) of
  every chat currently filed under it. Called automatically whenever a chat
  is added to or removed from a project (`PATCH /api/chat/sessions/{id}/project`)
  and after a chat inside a project is deleted, so the memory never drifts
  from what's actually in the folder.
- Frontend: new "Projects" sidebar entry and page (`frontend/src/App.tsx`) -
  create/rename/delete a project, expand it to see its chats, and see the
  AI memory block.

## 6. New: chat History row actions

Each row in History (and inside a Project's chat list) now has a "⋮" menu:

- **Rename** - `PATCH /api/chat/sessions/{id}`.
- **Share via link** - `POST /api/chat/sessions/{id}/share` issues a random,
  unguessable token; `GET /api/chat/shared/{token}` is a public (no-auth)
  read-only endpoint that returns only that chat's messages, never the
  owner's account/document/other-session data. The frontend exposes it at
  `/shared/:token`. Revoke anytime from the same menu.
- **Add to project** - lists your (up to 2) projects and moves the chat in
  or out via `PATCH /api/chat/sessions/{id}/project`.
- **Delete** - see section 3.

## Verified before packaging

- `tsc --noEmit` clean, full `vite build` succeeds (frontend).
- `pytest tests/test_api.py` → **18 passed** (12 original + 6 new covering
  project caps, session delete/rename, share/revoke, and project
  add/remove/delete).
- New Alembic revision `20260822_0006` chains cleanly off `20260812_0005`.
