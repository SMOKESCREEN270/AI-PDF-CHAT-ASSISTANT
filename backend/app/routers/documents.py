import os
import uuid
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, UploadFile, File, HTTPException, Form
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app import models, schemas
from app.security import get_current_user
from app.config import settings
from app.services import pdf_processor, chunking, embeddings, vector_store, malware_scanner

router = APIRouter(prefix="/api/documents", tags=["documents"])


def _ingest_document(document_id: str, api_key: Optional[str]):
    """Runs the full smart-PDF-understanding + RAG-indexing pipeline for one document."""
    # BackgroundTasks runs after the request dependency has closed its session.
    # Always reload the row in a fresh session and close it when ingestion ends.
    db = SessionLocal()
    document = None
    try:
        document = db.query(models.Document).filter(models.Document.id == document_id).first()
        if not document:
            return
        pages = pdf_processor.process_pdf(document.filepath)
        meta = pdf_processor.extract_metadata(document.filepath)
        text_chunks = chunking.chunk_pages(pages)

        if not text_chunks:
            document.status = models.DocumentStatus.FAILED
            db.commit()
            return

        used_ocr_any = any(p.used_ocr for p in pages)

        chunk_rows = []
        for tc in text_chunks:
            row = models.Chunk(
                document_id=document.id,
                chunk_index=tc.chunk_index,
                page_number=tc.page_number,
                line_start=tc.line_start,
                line_end=tc.line_end,
                text=tc.text,
                is_ocr=tc.is_ocr,
            )
            db.add(row)
            chunk_rows.append(row)
        db.flush()  # assign IDs without committing yet

        # Embed + upsert into the document's own Chroma collection
        texts = [c.text for c in text_chunks]
        vectors = embeddings.embed_texts(texts, api_key=api_key)
        ids = [row.id for row in chunk_rows]
        metadatas = [
            {
                "chunk_id": row.id,
                "document_id": document.id,
                "page": row.page_number,
                "line_start": row.line_start,
                "line_end": row.line_end,
            }
            for row in chunk_rows
        ]
        vector_store.upsert_chunks(document.collection_name, ids, vectors, texts, metadatas)

        document.page_count = meta["page_count"]
        document.used_ocr = used_ocr_any
        document.status = models.DocumentStatus.READY
        document.doc_metadata = {**document.doc_metadata, **meta}
        db.commit()
    except Exception as e:
        if document is not None:
            document.status = models.DocumentStatus.FAILED
            document.doc_metadata = {**(document.doc_metadata or {}), "error": str(e)}
            db.commit()
        # The document remains FAILED with a human-readable error for polling.
    finally:
        db.close()


@router.post("/upload", response_model=List[schemas.DocumentOut])
async def upload_documents(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    gemini_api_key: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Upload one or more PDFs. Each is processed (OCR-aware extraction,
    chunking, embedding) in a background task."""
    if len(files) > 10:  # Keep one multipart request from creating an unbounded queue.
        raise HTTPException(status_code=400, detail="Too many files in one request")
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    results = []

    for upload in files:
        original_filename = upload.filename or ""
        safe_filename = os.path.basename(original_filename)
        if (
            not original_filename
            or ".." in original_filename
            or "/" in original_filename
            or "\\" in original_filename
            or "\x00" in original_filename
            or ".." in safe_filename
            or "/" in safe_filename
            or "\\" in safe_filename
        ):
            raise HTTPException(status_code=400, detail="Invalid filename")

        if not safe_filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"{safe_filename} is not a PDF")

        doc_id = str(uuid.uuid4())
        safe_name = f"{doc_id}_{safe_filename}"
        filepath = os.path.join(settings.UPLOAD_DIR, safe_name)

        max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
        first_chunk = await upload.read(min(1024 * 1024, max_bytes + 1))
        if not first_chunk.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail="File is not a valid PDF")
        if len(first_chunk) > max_bytes:
            raise HTTPException(
                status_code=400,
                detail=f"{upload.filename} exceeds {settings.MAX_UPLOAD_MB}MB limit",
            )

        temporary_path = f"{filepath}.uploading"
        total_bytes = len(first_chunk)
        try:
            with open(temporary_path, "wb") as output:
                output.write(first_chunk)
                while chunk := await upload.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > max_bytes:
                        raise HTTPException(
                            status_code=400,
                            detail=f"{upload.filename} exceeds {settings.MAX_UPLOAD_MB}MB limit",
                        )
                    output.write(chunk)
            if settings.MALWARE_SCAN_ENABLED:
                try:
                    if malware_scanner.scan_file(temporary_path):
                        raise HTTPException(status_code=400, detail="File failed security scan")
                except malware_scanner.MalwareScannerUnavailable as exc:
                    raise HTTPException(
                        status_code=503,
                        detail="File security scanner unavailable. Please try again later.",
                    ) from exc
            os.replace(temporary_path, filepath)
        except Exception:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
            raise

        document = models.Document(
            id=doc_id,
            owner_id=current_user.id,
            filename=safe_filename,
            filepath=filepath,
            collection_name=vector_store.collection_name_for(doc_id),
            status=models.DocumentStatus.PROCESSING,
        )
        db.add(document)
        db.commit()
        db.refresh(document)

        background_tasks.add_task(_ingest_document, document.id, gemini_api_key)
        results.append(document)

    return results


@router.get("", response_model=List[schemas.DocumentOut])
def list_documents(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return db.query(models.Document).filter(models.Document.owner_id == current_user.id).all()


@router.get("/{document_id}/file")
def get_document_file(
    document_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.owner_id == current_user.id,
    ).first()
    if not doc or not os.path.isfile(doc.filepath):
        raise HTTPException(status_code=404, detail="Document file not found")
    return FileResponse(
        doc.filepath,
        media_type="application/pdf",
        filename=doc.filename,
        headers={"Content-Disposition": f'inline; filename="{doc.filename}"'},
    )


@router.delete("/{document_id}")
def delete_document(document_id: str, db: Session = Depends(get_db),
                     current_user: models.User = Depends(get_current_user)):
    doc = db.query(models.Document).filter(models.Document.id == document_id,
                                             models.Document.owner_id == current_user.id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    vector_store.delete_collection(doc.collection_name)
    if os.path.exists(doc.filepath):
        os.remove(doc.filepath)
    db.delete(doc)
    db.commit()
    return {"status": "deleted"}
