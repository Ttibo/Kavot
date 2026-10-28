from __future__ import annotations

from fastapi import HTTPException

from app.core.workspace import documents
from app.plugins.papers import library
from app.core.projects import projects
from app.plugins.planning import service as work
from app.core.records.repository import store


def dashboard() -> dict:
    state = store.read()
    notes = [item for item in state["notes"] if not item.get("trashed_at")]
    papers = [item for item in state["papers"] if item.get("file_path")]
    note = documents.enrich_note(max(notes, key=lambda item: item["updated_at"]), state) if notes else None
    paper = library.enrich(max(papers, key=lambda item: item["updated_at"]), state) if papers else None
    return {"current_note": note, "recent_paper": paper}


def load_demo() -> dict:
    if store.list("projects"):
        raise HTTPException(status_code=409, detail="The workspace already contains projects")
    project = store.create("projects", {"name": "Literature mapping", "description": "Analyze research methods applied to scientific publications.", "color": "#087e86", "status": "active"})
    projects.ensure_files(project)
    papers = []
    for values in (
        {"title": "Transparent methods for evidence synthesis", "authors": ["Samira Patel"], "publication": "Research Methods", "published_at": "2025", "status": "key", "tags": ["mapping"], "project_ids": [project["id"]]},
        {"title": "Evaluating evidence synthesis with transparent metrics", "authors": ["Amira Chen"], "publication": "Open Science Journal", "published_at": "2024", "status": "reading", "tags": ["evaluation"], "project_ids": [project["id"]]},
        {"title": "Human-in-the-loop tools for research workflows", "authors": ["Lina Rossi", "Noah Martin"], "publication": "Digital Scholarship Quarterly", "published_at": "2026", "status": "to_read", "tags": ["workflow"], "project_ids": [project["id"]]},
    ):
        papers.append(library.create_paper(values))
    for title, description, status, priority in (
        ("Define corpus inclusion criteria", "Formalize criteria before the next collection.", "doing", "high"),
        ("Read the three priority articles", "Produce a structured note for each reading.", "todo", "high"),
        ("Prepare the comparison matrix", "Variables, methods, datasets, and limitations.", "todo", "medium"),
        ("Organize the local library", "", "done", "low"),
    ):
        class TaskPayload:
            def model_dump(self, **_: object) -> dict:
                return {"project_id": project["id"], "column_id": None, "title": title, "description": description, "status": status, "priority": priority, "labels": [], "checklist": [], "start_date": None, "due_date": None}
        work.create_task(TaskPayload())
    class NotePayload:
        def model_dump(self, **_: object) -> dict:
            return {"project_id": project["id"], "paper_id": None, "folder_id": None, "template_id": None, "template_context_project_id": None, "title": "Research questions", "content": "# Research questions\n\n- Which methods are most transparent?\n- Where are the methodological gaps?\n"}
    documents.create_note(NotePayload())
    return {"project_id": project["id"], "paper_ids": [item["id"] for item in papers]}
