"""Workspace files explicitly referenced in external agent prompts."""
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import prefixed_entry, safe_name
from app.core.workspace import documents
from app.core.records.repository import store

ALLOWED_EXTENSIONS = {".md", ".html", ".pdf", ".txt", ".canvas", ".json", ".csv"}
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def workspace_file(value: str) -> Path:
    root = settings.storage_path.resolve()
    relative = Path(value)
    if relative.is_absolute() or not relative.parts or relative.parts[0] not in {"notes", "projects", "library", "databases"}:
        raise HTTPException(422, "Chemin hors du workspace.")
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(422, "Chemin hors du workspace.")
    return target


def inventory() -> list[dict]:
    state = store.read()
    root = settings.storage_path.resolve()
    resources: dict[str, dict] = {}

    def add(identifier: str, title: str, kind: str, path: str | Path | None, **extra) -> None:
        if not path:
            return
        candidate = Path(path)
        resolved = (candidate if candidate.is_absolute() else root / candidate).resolve()
        if not resolved.is_relative_to(root) or not resolved.is_file():
            return
        relative = resolved.relative_to(root).as_posix()
        resources[identifier] = {"id": identifier, "title": title, "kind": kind, "path": relative, **extra}

    for note in state["notes"]:
        if not note.get("trashed_at"):
            add(f"note:{note['id']}", note["title"], "note", documents.note_path(note, state), note_id=note["id"])
    for paper in state["papers"]:
        if not paper.get("file_path"):
            continue
        # A synced or moved workspace keeps the PDF in the article's library folder, not at the recorded path.
        folder = prefixed_entry(settings.library_path, paper["id"])
        local = folder / "paper.pdf" if folder else None
        add(f"paper:{paper['id']}", paper["title"], "paper", local if local and local.is_file() else paper["file_path"], paper_id=paper["id"])
    known = {item["path"] for item in resources.values()}
    for folder in ("notes", "projects", "library", "databases"):
        for path in (root / folder).rglob("*"):
            if not path.is_file() or path.suffix.lower() not in ALLOWED_EXTENSIONS:
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(root):
                continue
            relative = resolved.relative_to(root).as_posix()
            if relative not in known and not any(part.startswith(".") for part in Path(relative).parts):
                add("file:" + relative, path.name, path.suffix.lower().lstrip("."), path)
    return list(resources.values())


def resolve_context(context: dict | None) -> tuple[list[dict], dict | None]:
    context = context or {}
    catalog = {item["id"]: item for item in inventory()}
    by_path = {item["path"]: item for item in catalog.values()}
    selected: list[dict] = []
    excluded = set(context.get("excluded_resource_ids") or [])

    def add(identifier: str) -> None:
        if identifier in excluded:
            return
        item = catalog.get(identifier)
        if not item:
            raise HTTPException(422, "A selected file no longer exists in this workspace.")
        if item not in selected:
            selected.append(item)

    for identifier in context.get("resource_ids") or []:
        add(str(identifier))
    if context.get("note_id"):
        add("note:" + str(context["note_id"]))
    if context.get("paper_id") and "paper:" + str(context["paper_id"]) in catalog:
        add("paper:" + str(context["paper_id"]))
    for key in ("resource_path", "canvas_path"):
        path = context.get(key)
        if path:
            relative = workspace_file(str(path)).relative_to(settings.storage_path.resolve()).as_posix()
            item = by_path.get(relative)
            if not item:
                raise HTTPException(422, "An active file no longer exists in this workspace.")
            add(item["id"])
    # Open tabs are additional sources, never implicit write targets. A closed or
    # deleted passive tab must not prevent sending from the current editor.
    opened = []
    for document in context.get("open_documents") or []:
        if not isinstance(document, dict):
            continue
        identifiers = [f"{kind}:{document[kind + '_id']}" for kind in ("note", "paper") if document.get(kind + "_id")]
        path = document.get("resource_path") or document.get("path")
        url = document.get("url") or ""
        if url.startswith("/api/databases/resources/files/"):
            from urllib.parse import unquote
            filename = unquote(url.removeprefix("/api/databases/resources/files/"))
            if filename and Path(filename).name == filename:
                path = "databases/resources/files/" + filename
        if path:
            try:
                relative = workspace_file(str(path)).relative_to(settings.storage_path.resolve()).as_posix()
            except HTTPException:
                relative = None  # A tab that is not a workspace file (a page, an Atelier section) adds no source.
            if relative in by_path:
                identifiers.append(by_path[relative]["id"])
        for identifier in identifiers:
            if identifier in catalog and identifier not in excluded:
                add(identifier)
                item = catalog[identifier]
                if item not in opened:
                    opened.append(item)
    context["open_documents"] = opened
    target_id = None if context.get("note_intent") == "create" else context.get("target_note_id") or context.get("note_id")
    target = catalog.get("note:" + str(target_id)) if target_id else None
    if target_id and not target:
        raise HTTPException(422, "The target note no longer exists in this workspace.")
    if target and Path(target["path"]).name == "relations.generated.html":
        raise HTTPException(422, "Project Overview is a read-only projection.")
    if target and target not in selected:
        selected.insert(0, target)
    return selected, target


def save_attachment(filename: str, source) -> dict:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(422, "Unsupported format.")
    content = source.read(MAX_ATTACHMENT_BYTES + 1)
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(413, "File too large (20 MB maximum).")
    if suffix == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise HTTPException(422, "The file is not a PDF.")
    else:
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise HTTPException(422, "The text file must be UTF-8 encoded.") from error
    name = f"{uuid4().hex[:12]}-{safe_name(filename, 'document')}"
    path = settings.notes_path / "general" / "assistant-attachments" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as output:
        output.write(content)
    if suffix == ".pdf":
        from app.core.workspace import asset_metadata
        asset_metadata.ensure(path)
    relative = path.relative_to(settings.storage_path).as_posix()
    return {"id": "file:" + relative, "title": filename, "kind": suffix.lstrip("."), "path": relative}
