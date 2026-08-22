from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app import models, schemas
from app.security import get_current_user
from app.services import memory

router = APIRouter(prefix="/api/projects", tags=["projects"])

MAX_PROJECTS_PER_USER = 2


def _to_out(project: models.Project, chat_count: int) -> schemas.ProjectOut:
    return schemas.ProjectOut(
        id=project.id,
        name=project.name,
        memory_summary=project.memory_summary,
        memory_updated_at=project.memory_updated_at,
        chat_count=chat_count,
        created_at=project.created_at,
    )


def _chat_count(db: Session, project_id: str) -> int:
    return (
        db.query(models.ChatSession)
        .filter(models.ChatSession.project_id == project_id)
        .count()
    )


@router.get("", response_model=list[schemas.ProjectOut])
def list_projects(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    projects = (
        db.query(models.Project)
        .filter(models.Project.owner_id == current_user.id)
        .order_by(models.Project.created_at.asc())
        .all()
    )
    return [_to_out(p, _chat_count(db, p.id)) for p in projects]


@router.post("", response_model=schemas.ProjectOut)
def create_project(payload: schemas.ProjectCreate, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    existing = db.query(models.Project).filter(models.Project.owner_id == current_user.id).count()
    if existing >= MAX_PROJECTS_PER_USER:
        raise HTTPException(
            status_code=400,
            detail=f"You can only have {MAX_PROJECTS_PER_USER} projects. Delete one before creating another.",
        )
    project = models.Project(owner_id=current_user.id, name=payload.name.strip() or "Untitled project")
    db.add(project)
    db.commit()
    db.refresh(project)
    return _to_out(project, 0)


@router.patch("/{project_id}", response_model=schemas.ProjectOut)
def rename_project(project_id: str, payload: schemas.ProjectRename, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    project = db.query(models.Project).filter(
        models.Project.id == project_id, models.Project.owner_id == current_user.id,
    ).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project.name = payload.name.strip() or project.name
    db.add(project)
    db.commit()
    db.refresh(project)
    return _to_out(project, _chat_count(db, project.id))


@router.delete("/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    project = db.query(models.Project).filter(
        models.Project.id == project_id, models.Project.owner_id == current_user.id,
    ).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    # Deleting a project un-files its chats rather than deleting them - a
    # folder is organizational, so removing it shouldn't destroy the
    # conversations inside it.
    db.query(models.ChatSession).filter(models.ChatSession.project_id == project.id).update(
        {"project_id": None}
    )
    db.delete(project)
    db.commit()
    return {"status": "deleted"}


@router.get("/{project_id}/sessions")
def list_project_sessions(project_id: str, db: Session = Depends(get_db),
                           current_user: models.User = Depends(get_current_user)):
    project = db.query(models.Project).filter(
        models.Project.id == project_id, models.Project.owner_id == current_user.id,
    ).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    sessions = (
        db.query(models.ChatSession)
        .filter(models.ChatSession.project_id == project.id)
        .order_by(models.ChatSession.created_at.desc())
        .all()
    )
    return [
        {"id": s.id, "title": s.title, "document_ids": s.document_ids, "created_at": s.created_at}
        for s in sessions
    ]
