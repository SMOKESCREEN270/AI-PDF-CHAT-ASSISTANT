"""
Turns PageResult objects (page -> lines) into overlapping text chunks while
preserving exact (page_number, line_start, line_end) provenance for every
chunk, which is what powers line-level citations later on.
"""
from dataclasses import dataclass
from typing import List

from app.services.pdf_processor import PageResult
from app.config import settings


@dataclass
class TextChunk:
    chunk_index: int
    page_number: int
    line_start: int
    line_end: int
    text: str
    is_ocr: bool


def chunk_pages(pages: List[PageResult],
                 chunk_size: int = None,
                 overlap: int = None) -> List[TextChunk]:
    chunk_size = chunk_size or settings.CHUNK_SIZE
    overlap = overlap or settings.CHUNK_OVERLAP

    chunks: List[TextChunk] = []
    idx = 0

    for page in pages:
        if not page.lines:
            continue

        buf_lines = []
        buf_chars = 0
        start_line = page.lines[0].line_number

        def flush(end_line: int):
            nonlocal idx, buf_lines, buf_chars, start_line
            if not buf_lines:
                return
            text = "\n".join(buf_lines).strip()
            if text:
                chunks.append(TextChunk(
                    chunk_index=idx,
                    page_number=page.page_number,
                    line_start=start_line,
                    line_end=end_line,
                    text=text,
                    is_ocr=page.used_ocr,
                ))
                idx += 1

        for line in page.lines:
            buf_lines.append(line.text)
            buf_chars += len(line.text) + 1
            if buf_chars >= chunk_size:
                flush(line.line_number)
                # keep an overlap tail (in characters) for context continuity
                overlap_lines = []
                overlap_chars = 0
                for l in reversed(buf_lines):
                    overlap_lines.insert(0, l)
                    overlap_chars += len(l)
                    if overlap_chars >= overlap:
                        break
                buf_lines = overlap_lines
                buf_chars = sum(len(l) + 1 for l in buf_lines)
                start_line = max(line.line_number - len(overlap_lines) + 1, page.lines[0].line_number)

        # flush remainder of the page
        if buf_lines:
            flush(page.lines[-1].line_number)

    return chunks
