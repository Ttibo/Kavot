"""One-time, resumable conversion of Markdown notes into portable HTML documents.

Every changed file and the catalogue are backed up under
``.meta_kavot/migrations/html-v1`` before a note is touched.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, atomic_write_text, read_json_object
from app.core.records.repository import store
from app.core.workspace import html_documents as html_docs
from app.core.workspace.documents import note_path, refresh_document_links, write_note


def _migration_backup(source: Path, destination: Path) -> None:
    """Publish complete backups, including paths beyond Windows MAX_PATH."""
    def native(path: Path) -> str:
        value = str(path.absolute())
        if os.name != 'nt' or value.startswith('\\\\?\\'):
            return value
        return '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value

    target = Path(native(destination))
    if target.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as handle:
            temporary = Path(handle.name)
        shutil.copy2(native(source), native(temporary))
        temporary.replace(target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def migrate_html_notes(*, scan_workspace: bool = True) -> None:
    """Resumable migration: back up bytes and catalogue before changing a note."""
    pending = [n for n in store.read()['notes'] if n.get('content_format') != 'html' and not n.get('trashed_at')]
    if not pending and not scan_workspace:
        return
    backup = settings.storage_path / '.meta_kavot' / 'migrations' / 'html-v1'
    loose = []
    for root in (settings.notes_path, settings.library_path, settings.projects_path) if scan_workspace else ():
        if root.exists():
            loose.extend(path for path in root.rglob('*.md') if not any(p.startswith('.') or p == 'assets' for p in path.relative_to(root).parts))
    if not pending and not loose and not backup.exists():
        return
    backup.mkdir(parents=True, exist_ok=True)
    if not (backup / 'kavot.state.json').exists():
        atomic_write_json(backup / 'kavot.state.json', store.read())
    for item in pending:
        with store.transaction() as state:
            note = next(n for n in state['notes'] if n['id'] == item['id'])
            if note.get('content_format') == 'html':
                continue
            old = note_path(note, state)
            if not old.exists() and old.with_suffix('.md').exists():
                old = old.with_suffix('.md')
            target = old.with_suffix('.html')
            if target.exists() and target != old:
                existing = html_docs.metadata(target.read_text(encoding='utf-8'))
                if existing.get('legacy_id') != note['id']:
                    raise HTTPException(409, f'HTML migration: file already exists: {target.name}')
                note['content'] = html_docs.read(target.read_text(encoding='utf-8'), target)
                note['document_uid'] = existing.get('document_uid')
            elif old.exists():
                saved = backup / old.relative_to(settings.storage_path)
                _migration_backup(old, saved)
                raw = old.read_text(encoding='utf-8')
                note['content'] = html_docs.read(html_docs.fragment(raw, markdown=old.suffix == '.md'), old)
            write_note(note, state, old)
            atomic_write_json(backup / f"note-{note['id']}.json", {'id': note['id'], 'old': old.relative_to(settings.storage_path).as_posix(), 'new': target.relative_to(settings.storage_path).as_posix(), 'status': 'converted'})
    for old in loose:
        if not old.exists():
            continue
        relative = old.relative_to(settings.storage_path)
        target = old.with_suffix('.html')
        saved = backup / relative
        _migration_backup(old, saved)
        identity = str(uuid.uuid5(uuid.NAMESPACE_URL, relative.as_posix()))
        if old.name.endswith('.generated.md'):
            old.unlink()  # Views are regenerated from their structured sources.
            continue
        if target.exists() and html_docs.metadata(target.read_text(encoding='utf-8')).get('document_uid') != identity:
            raise HTTPException(409, f'HTML migration: file already exists: {target.name}')
        if not target.exists():
            body = html_docs.read(html_docs.fragment(old.read_text(encoding='utf-8'), markdown=True), old)
            atomic_write_text(target, html_docs.serialize({'title': old.stem, 'document_uid': identity}, body, target, store.read()))
        atomic_write_json(backup / f'file-{identity}.json', {'old': relative.as_posix(), 'new': target.relative_to(settings.storage_path).as_posix()})
        old.unlink()
    # Canvas paths may coexist with legacy numeric note IDs.
    replacements = {}
    for journal in [*backup.glob('note-*.json'), *backup.glob('file-*.json')]:
        entry = read_json_object(journal)
        replacements[entry['old']] = entry['new']
    def replace(value):
        if isinstance(value, dict):
            return {k: replace(v) for k, v in value.items()}
        if isinstance(value, list):
            return [replace(v) for v in value]
        return replacements.get(value, value) if isinstance(value, str) else value
    for path in settings.storage_path.rglob('*.canvas'):
        if backup in path.parents:
            continue
        original = read_json_object(path)
        changed = replace(original)
        if original != changed:
            saved = backup / path.relative_to(settings.storage_path)
            _migration_backup(path, saved)
            atomic_write_json(path, changed)
    if pending or loose:
        state = store.read()
        refresh_document_links(state)
        for journal in backup.glob('file-*.json'):
            path = settings.storage_path / read_json_object(journal)['new']
            if path.exists():
                raw = path.read_text(encoding='utf-8')
                atomic_write_text(path, html_docs.serialize(html_docs.metadata(raw), html_docs.read(raw, path), path, state))
