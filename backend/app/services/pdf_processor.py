"""
Smart PDF understanding.

Strategy per page:
1. Try native text extraction with PyMuPDF (fast, exact, gives us line-level
   bounding boxes so citations can point at real line numbers).
2. If a page yields near-empty text (scanned image / photographed page),
   fall back to OCR (Tesseract via pytesseract) on a rasterized image of
   that page.

Returns a list of PageResult, each holding line-indexed text so downstream
chunking can carry (page_number, line_start, line_end) for precise citations.
"""
from dataclasses import dataclass, field
from typing import List
import io

import fitz  # PyMuPDF
import pytesseract
from PIL import Image

MIN_NATIVE_CHARS_PER_PAGE = 25  # below this we assume the page is a scanned image
MAX_PAGES = 500  # Hard ceiling to prevent pathological PDFs from exhausting workers.
OCR_DPI = 300
MAX_OCR_DPI_PIXELS = 16_000_000  # Maximum rasterized width*height per OCR page.


@dataclass
class Line:
    line_number: int
    text: str


@dataclass
class PageResult:
    page_number: int  # 1-indexed
    lines: List[Line] = field(default_factory=list)
    used_ocr: bool = False

    @property
    def full_text(self) -> str:
        return "\n".join(l.text for l in self.lines)


def _extract_native(page: "fitz.Page") -> List[Line]:
    text = page.get_text("text")
    lines = [Line(i + 1, t) for i, t in enumerate(text.split("\n")) if t.strip()]
    return lines


def _extract_via_ocr(page: "fitz.Page", dpi: int = OCR_DPI) -> List[Line]:
    width = int(page.rect.width * dpi / 72)
    height = int(page.rect.height * dpi / 72)
    if width * height > MAX_OCR_DPI_PIXELS:
        raise ValueError(
            f"Page exceeds OCR rasterization limit ({MAX_OCR_DPI_PIXELS:,} pixels)"
        )
    pix = page.get_pixmap(dpi=dpi)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    ocr_text = pytesseract.image_to_string(img)
    lines = [Line(i + 1, t) for i, t in enumerate(ocr_text.split("\n")) if t.strip()]
    return lines


def process_pdf(filepath: str) -> List[PageResult]:
    doc = fitz.open(filepath)
    try:
        if len(doc) > MAX_PAGES:
            raise ValueError(f"PDF exceeds the {MAX_PAGES}-page limit")
        results: List[PageResult] = []
        for page_index in range(len(doc)):
            page = doc[page_index]
            native_lines = _extract_native(page)
            native_char_count = sum(len(l.text) for l in native_lines)
            if native_char_count >= MIN_NATIVE_CHARS_PER_PAGE:
                results.append(PageResult(page_number=page_index + 1, lines=native_lines, used_ocr=False))
            else:
                ocr_lines = _extract_via_ocr(page)
                results.append(PageResult(page_number=page_index + 1, lines=ocr_lines, used_ocr=True))
        return results
    finally:
        doc.close()


def extract_metadata(filepath: str) -> dict:
    doc = fitz.open(filepath)
    meta = doc.metadata or {}
    result = {
        "title": meta.get("title") or "",
        "author": meta.get("author") or "",
        "page_count": len(doc),
    }
    doc.close()
    return result
