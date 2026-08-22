# Chat answer UX fixes

## 1. Markdown wasn't rendered — answers showed raw `**bold**`, `| table |` syntax

`frontend/src/App.tsx` was printing `message.content` as a plain string, so any
Markdown the model produced (tables, headings, bold, lists) showed up as raw
syntax instead of being formatted. Assistant messages now render through
`MarkdownMessage` (`frontend/src/components/markdown-message.tsx`), which
parses headings, bold/italic, ordered/unordered lists, blockquotes, code
blocks, and — importantly — **tables**, so a requested comparison/chart
actually renders as a real `<table>` with clear row/column separation
(`.md-table` styles in `index.css`) instead of collapsing into unreadable
inline text.

## 2. Citations ate too much vertical space

Previously every citation was a full card (filename, page, full snippet)
stacked one after another under the answer — for an answer with 5+ sources
that's a wall of repeated cards.

Replaced with a Wikipedia-style footnote pattern:

- **Backend** (`backend/app/services/rag_pipeline.py`): the model's
  `[S1]`, `[S2]`... markers are no longer stripped out. They're renumbered
  to sequential `[1]`, `[2]`... matching the `citations` array position, and
  kept inline in the answer text — right where that source was actually used.
- **Frontend** (`markdown-message.tsx`): each inline `[n]` renders as a small
  numbered chip (`.citation-marker`). Hovering (or focusing, for
  keyboard/touch users) pops up a lightweight floating card
  (`.citation-popover`) with the filename, page, line range, and a short
  excerpt — no navigation away from the chat, and it disappears when the
  cursor moves off, exactly like a Wikipedia footnote preview. Clicking it
  (or the "Open source" link in the popover) still opens the full source in
  the PDF viewer.
- A compact one-line "Sources" chip row (`.source-chip-row`) still sits under
  the answer as a fallback/quick-jump so every source stays reachable even if
  it wasn't cited inline, without going back to full-size cards.

## 3. Confidence score placement

The confidence pill now renders after the answer, the hallucination warning
(if any), the summary block, and the sources row — i.e. at the very end of
the assistant's message, not sandwiched in the middle.
