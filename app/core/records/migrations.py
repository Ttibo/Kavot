"""Imported files in the notes hierarchy and legacy file migration."""
from __future__ import annotations

from pathlib import Path
from threading import RLock
from urllib.parse import unquote

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.records.repository import store

_upload_lock = RLock()


def migrate_legacy_files() -> None:
    """Expose files from the retired collection in the notes tree once."""
    import shutil
    from app.core.kernel.files import atomic_write_json, read_json_object, safe_name
    from app.core.workspace import documents

    root = settings.databases_path / 'resources'
    files = root / 'files'
    if not files.is_dir():
        return
    marker = settings.storage_path / '.meta_kavot' / 'migrations' / 'note-files-v1.json'
    migrated = read_json_object(marker) or {}
    state = store.read()
    assigned = {}
    for record_file in (root / 'items').glob('*.json'):
        record = read_json_object(record_file) or {}
        url = str((record.get('values') or {}).get('url') or '')
        prefix = '/api/databases/resources/files/'
        if url.startswith(prefix):
            assigned[unquote(url[len(prefix):])] = record
    for source in sorted(files.iterdir()):
        if not source.is_file() or source.is_symlink() or source.name in migrated:
            continue
        values = (assigned.get(source.name) or {}).get('values') or {}
        note_ids = values.get('linked_note_ids') or [values.get('note_id')]
        note = next((item for item in state['notes'] if item['id'] in note_ids and not item.get('trashed_at')), None)
        project_id = next((item for item in values.get('project_ids') or [] if any(p['id'] == item for p in state['projects'])), None)
        directory = documents.note_path(note, state).parent if note else documents.notes_directory(state, project_id, None)
        directory.mkdir(parents=True, exist_ok=True)
        name = safe_name(values.get('filename') or source.name, 'document')
        target = directory / name
        if target.exists():
            target = directory / f"{target.stem}-{source.name[:8]}{target.suffix}"
        suffix = 2
        while target.exists():
            target = directory / f"{Path(name).stem}-{source.name[:8]}-{suffix}{Path(name).suffix}"
            suffix += 1
        shutil.copy2(source, target)
        migrated[source.name] = target.relative_to(settings.storage_path).as_posix()
        atomic_write_json(marker, migrated)


def archive_retired_collections() -> None:
    """Remove retired collection catalogs while preserving their old data."""
    import shutil
    from app.core.kernel.files import read_json_object
    from app.core.projects import projects

    archive = settings.storage_path / '.meta_kavot' / 'retired-collections'
    code_items = settings.databases_path / 'codes' / 'items'
    for record_file in code_items.glob('*.json'):
        values = (read_json_object(record_file) or {}).get('values') or {}
        location = str(values.get('repository_path') or '')
        if not location:
            continue
        kind = 'github' if location.startswith(('https://github.com/', 'http://github.com/')) else 'local_path'
        for project_id in values.get('project_ids') or []:
            try:
                projects.add_external_resource(project_id, {'resource_type': kind, 'target': location, 'title': values.get('title') or ''})
            except HTTPException as error:
                if error.status_code not in {404, 409, 422}:
                    raise
    for collection in ('resources', 'codes'):
        source = settings.databases_path / collection
        if not source.is_dir():
            continue
        destination = archive / collection
        for name in ('database.kavot.json', 'items'):
            old = source / name
            new = destination / name
            if old.exists() and not new.exists():
                new.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(old), str(new))


def import_file(file, *, project_id=None, folder_id=None, note_id=None, canvas_path=None, target_path=None):
    """Store an imported file in the visible notes hierarchy."""
    import mimetypes
    import uuid
    from urllib.parse import quote
    from app.core.kernel.files import safe_name, resolve_inside
    from app.core.workspace import documents, asset_metadata
    from app.core.projects import projects
    state = store.read()
    if note_id is not None:
        note = store.find('notes', note_id, 'Note')
        directory = documents.note_path(note, state).parent
    elif target_path:
        try:
            target_note = resolve_inside(settings.storage_path, target_path)
        except ValueError as error:
            raise HTTPException(422, 'Invalid document path') from error
        if not target_note.is_file() or not any(target_note.resolve().is_relative_to(root.resolve()) for root in (settings.notes_path, settings.library_path)):
            raise HTTPException(422, 'Invalid document path')
        directory = target_note.parent
    elif canvas_path:
        canvas = resolve_inside(settings.storage_path, canvas_path)
        if not canvas.is_file() or canvas.suffix != '.canvas':
            raise HTTPException(422, 'Invalid canvas path')
        project = next((item for item in state['projects'] if canvas.resolve().is_relative_to(projects.directory(item).resolve())), None)
        directory = documents.notes_directory(state, project['id'] if project else None, None)
    else:
        directory = documents.notes_directory(state, project_id, folder_id)
    filename = safe_name(file.filename or 'document', 'document')
    with _upload_lock:
        target = directory / filename
        while target.exists():
            target = directory / f"{target.stem}-{uuid.uuid4().hex[:8]}{target.suffix}"
        filename = target.name
        target.parent.mkdir(parents=True, exist_ok=True)
        asset_metadata.save_upload(target, file.file)
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    kind = "pdf" if mime == "application/pdf" else next((k for k in ("image", "video", "audio") if mime.startswith(k + "/")), "file")
    path = target.relative_to(settings.storage_path).as_posix()
    url = f"/api/workspace/file?path={quote(path, safe='')}"
    values = {"title": file.filename or "Document", "filename": file.filename or "document", "url": url, "kind": kind,
              "project_ids": [project_id] if project_id else [], "linked_note_ids": [note_id] if note_id else [],
              "canvas_paths": [canvas_path] if canvas_path else []}
    label = values["filename"].replace("[", "\\[").replace("]", "\\]")
    return {**values, "path": path,
            "name": values["filename"], "type": "image" if kind == "image" else "file",
            "markdown": f"{'!' if kind == 'image' else ''}[{label}](<{url}>)", "extraction": asset_metadata.summary(target)}
