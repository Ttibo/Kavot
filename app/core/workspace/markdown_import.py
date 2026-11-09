"""Turn Markdown files dropped in the notes folder into regular Kavot notes.

A ``.md`` file found under ``notes/`` (copied by hand, synced, written by an
agent...) becomes a catalogued HTML note in the matching notes workspace and
folder, then the Markdown file is removed. Each source is backed up under
``.meta_kavot/imports/markdown`` before it is deleted.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from app.core.kernel.config import settings
from app.core.kernel.files import safe_name
from app.core.projects import projects
from app.core.records.repository import now, store
from app.core.workspace import html_documents as html_docs
from app.core.workspace.documents import note_path, refresh_document_links, unique_note_title, write_note

log = logging.getLogger(__name__)

# A file modified more recently than this may still be being written by another program.
SETTLE_SECONDS = 2.0
POLL_SECONDS = 3.0
IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff'}

_lock = threading.Lock()
_FRONTMATTER = re.compile(r'\A﻿?---[ \t]*\r?\n(.*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)', re.S)
_WIKILINK = re.compile(r'(!?)\[\[([^\]\|#\n]*)(#[^\]\|\n]*)?(?:\|([^\]\n]*))?\]\]')
_MD_LINK = re.compile(r'(\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))')


def _skipped(part: str) -> bool:
    return part.startswith('.') or part == 'assets'


def pending_markdown(settle: float = SETTLE_SECONDS) -> list[Path]:
    """Markdown files waiting under notes/, ignoring hidden folders, assets and files still being written."""
    root = settings.notes_path
    if not root.is_dir():
        return []
    found: list[Path] = []
    limit = time.time() - settle
    for directory, folders, files in os.walk(root):
        folders[:] = [name for name in folders if not _skipped(name)]
        for name in files:
            if not name.lower().endswith('.md') or name.startswith('.') or name.endswith('.generated.md'):
                continue
            path = Path(directory) / name
            try:
                if settle <= 0 or path.stat().st_mtime <= limit:
                    found.append(path)
            except OSError:
                continue
    return sorted(found)


def _decode(raw: bytes) -> str:
    for encoding in ('utf-8-sig', 'cp1252'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode('latin-1')


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Read simple YAML front matter (``key: value`` and ``- item`` lists) as note properties."""
    match = _FRONTMATTER.match(text)
    if not match:
        return {}, text.lstrip('﻿')
    properties: dict[str, str] = {}
    key = None
    for line in match.group(1).splitlines():
        item = re.match(r'^([^\s:#-][^:]*):(?:\s+(.*))?$', line)
        if item:
            key = item.group(1).strip()
            value = (item.group(2) or '').strip()
            if value.startswith('[') and value.endswith(']'):
                value = ', '.join(part.strip().strip('"\'') for part in value[1:-1].split(',') if part.strip())
            properties[key] = value.strip('"\'')
        elif key and re.match(r'^\s*-\s+', line):
            value = re.sub(r'^\s*-\s+', '', line).strip().strip('"\'')
            properties[key] = f'{properties[key]}, {value}' if properties[key] else value
    return properties, text[match.end():]


def _title_and_body(text: str, path: Path, properties: dict[str, str]) -> tuple[str, str]:
    """Title from front matter, else the leading ``# heading``, else the file name; the body starts with that heading."""
    body = text.lstrip('\r\n')
    first = re.match(r'#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)', body)
    title = (properties.pop('title', '') or (first.group(1) if first else '') or path.stem).strip()[:240] or 'Note'
    if not first:
        body = f'# {title}\n\n{body}'
    return title, body


def _workspace(state: dict[str, Any], path: Path) -> tuple[int | None, list[str]]:
    """Notes workspace (project or general) and folder names for a file under notes/."""
    parts = list(path.relative_to(settings.notes_path).parts[:-1])
    if parts[:1] == ['general']:
        return None, parts[1:]
    if parts[:1] == ['projects'] and len(parts) >= 2:
        project = next((item for item in state['projects']
                        if projects.directory(item).name.casefold() == parts[1].casefold()), None)
        if project:
            return project['id'], parts[2:]
    return None, parts


def folder_for(state: dict[str, Any], project_id: int | None, names: list[str]) -> int | None:
    """Find or create the nested note folders whose directories are ``names``."""
    parent = None
    for name in names:
        key = safe_name(name, 'folder')
        folder = next((item for item in state['note_folders']
                       if item.get('project_id') == project_id and item.get('parent_id') == parent
                       and safe_name(item['name'], 'folder') == key), None)
        if not folder:
            timestamp = now()
            folder = {'id': store.next_id(state, 'note_folders'), 'name': name[:120], 'project_id': project_id,
                      'parent_id': parent, 'color': '#b17a22', 'created_at': timestamp, 'updated_at': timestamp}
            state['note_folders'].append(folder)
        parent = folder['id']
    return parent


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _rewrite_links(text: str, source: Path, by_path: dict[Path, int], by_title: dict[str, int]) -> str:
    """Point links to other Markdown notes at their Kavot note; Obsidian ``[[links]]`` become regular links."""
    def note_for(name: str) -> int | None:
        name = name.strip()
        if not name:
            return None
        candidate = (source.parent / name)
        for path in (candidate, candidate.with_name(candidate.name + '.md')):
            identifier = by_path.get(path.resolve())
            if identifier:
                return identifier
        return by_title.get(Path(name).stem.casefold() if name.lower().endswith('.md') else name.casefold())

    def wikilink(match: re.Match) -> str:
        embed, target, anchor, label = match.group(1), match.group(2).strip(), match.group(3) or '', match.group(4)
        text_label = (label or target or anchor.lstrip('#')).strip()
        if Path(target).suffix.lower() in IMAGE_SUFFIXES:
            located = next((path for path in (source.parent / target, source.parent / 'assets' / target) if path.is_file()), None)
            if located:
                relative = os.path.relpath(located, source.parent).replace('\\', '/')
                return f'{embed}[{text_label}](<{relative}>)'
            return match.group(0)
        identifier = note_for(target) if target else None
        if identifier:
            return f'[{text_label}](#note-{identifier})'
        return match.group(0)

    def markdown_link(match: re.Match) -> str:
        target = match.group(2)
        bare = target[1:-1] if target.startswith('<') else target
        parts = urlsplit(bare)
        if parts.scheme or parts.netloc or not parts.path.lower().endswith('.md'):
            return match.group(0)
        identifier = by_path.get((source.parent / unquote(parts.path)).resolve())
        return f'{match.group(1)}#note-{identifier}{match.group(3)}' if identifier else match.group(0)

    return _MD_LINK.sub(markdown_link, _WIKILINK.sub(wikilink, text))


def _backup(path: Path, stamp: str) -> None:
    from app.core.workspace.note_migration import _migration_backup
    destination = settings.storage_path / '.meta_kavot' / 'imports' / 'markdown' / stamp / path.relative_to(settings.storage_path)
    _migration_backup(path, destination)


def import_markdown_notes(settle: float = SETTLE_SECONDS) -> list[int]:
    """Convert every pending ``notes/**/*.md`` into a note; returns the new note ids."""
    if not pending_markdown(settle):
        return []
    with _lock:
        files = pending_markdown(settle)
        sources: list[dict[str, Any]] = []
        for path in files:
            try:
                raw = path.read_bytes()
                info = path.stat()
            except OSError:
                continue
            properties, text = split_frontmatter(_decode(raw).replace('\r\n', '\n').replace('\r', '\n'))
            title, body = _title_and_body(text, path, properties)
            created = getattr(info, 'st_birthtime', None) or (info.st_ctime if os.name == 'nt' else info.st_mtime)
            sources.append({'path': path, 'title': title, 'body': body, 'properties': properties,
                            'created_at': _iso(min(created, info.st_mtime)), 'updated_at': _iso(info.st_mtime)})
        if not sources:
            return []
        created_ids: list[int] = []
        done: list[Path] = []
        with store.transaction() as state:
            # Ids first, so files of one batch can link to each other.
            first = store.next_id(state, 'notes')
            for offset, source in enumerate(sources):
                source['id'] = first + offset
            by_path = {source['path'].resolve(): source['id'] for source in sources}
            by_title = {str(note.get('title', '')).casefold(): note['id'] for note in state['notes'] if not note.get('trashed_at')}
            by_title.update({source['path'].stem.casefold(): source['id'] for source in sources})
            by_title.update({source['title'].casefold(): source['id'] for source in sources})
            for source in sources:
                path = source['path']
                project_id, folders = _workspace(state, path)
                title = unique_note_title(state, source['title'])
                body = source['body']
                heading = f"# {source['title']}"
                if title != source['title'] and (body == heading or body.startswith(heading + '\n')):
                    body = f'# {title}' + body[len(heading):]
                markdown = _rewrite_links(body, path, by_path, by_title)
                note = {'id': source['id'], 'title': title, 'project_id': project_id, 'paper_id': None,
                        'folder_id': folder_for(state, project_id, folders), 'template_id': None,
                        'properties': source['properties'], 'presentation': {}, 'system_kind': 'standard',
                        'trashed_at': None, 'trash_id': None, 'created_at': source['created_at'],
                        'updated_at': source['updated_at'],
                        'content': html_docs.read(html_docs.fragment(markdown, markdown=True), path)}
                try:
                    if note_path(note, state).exists():
                        note['file_name'] = f"{note['id']}-{safe_name(title, 'note')}-{int(time.time())}.html"
                    state['notes'].append(note)
                    write_note(note, state, refresh_links=False)
                except Exception:
                    log.exception('Markdown import failed for %s', path)
                    state['notes'] = [item for item in state['notes'] if item['id'] != note['id']]
                    continue
                created_ids.append(note['id'])
                done.append(path)
            if created_ids:
                # Links between notes of the batch become relative file links once every target exists.
                refresh_document_links(state, set(created_ids))
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        for path in done:
            try:
                _backup(path, stamp)
                path.unlink()
            except OSError:
                log.exception('Imported Markdown file could not be removed: %s', path)
        return created_ids


def register_orphan_documents() -> list[int]:
    """Catalogue HTML notes under notes/ that have no record (e.g. converted by older versions)."""
    root = settings.notes_path
    if not root.is_dir():
        return []
    added: list[int] = []
    with store.transaction() as state:
        known = {note.get('document_uid') for note in state['notes'] if note.get('document_uid')}
        paths = {note_path(note, state).resolve() for note in state['notes'] if not note.get('trashed_at')}
        for directory, folders, files in os.walk(root):
            folders[:] = [name for name in folders if not name.startswith('.')]
            for name in files:
                path = Path(directory) / name
                if not name.lower().endswith('.html') or name.endswith('.generated.html') or path.resolve() in paths:
                    continue
                try:
                    raw = path.read_text(encoding='utf-8')
                except (OSError, UnicodeDecodeError):
                    continue
                meta = html_docs.metadata(raw)
                if meta.get('kind') != 'note' or not meta.get('document_uid') or meta['document_uid'] in known:
                    continue
                in_assets = 'assets' in path.relative_to(root).parts[:-1]
                project_id, folders_names = _workspace(state, path)
                stat = path.stat()
                record = {'title': path.stem, 'properties': {}, 'presentation': {},
                          **{key: meta[key] for key in ('document_uid', 'title', 'created_at', 'updated_at', 'properties', 'presentation') if key in meta},
                          'id': store.next_id(state, 'notes'), 'project_id': project_id, 'paper_id': None,
                          'folder_id': None if in_assets else folder_for(state, project_id, folders_names),
                          'template_id': None, 'system_kind': 'standard', 'trashed_at': None, 'trash_id': None,
                          'file_name': path.name, 'storage_path': path.relative_to(settings.storage_path).as_posix(),
                          'content_format': 'html', 'content': html_docs.read(raw, path)}
                record.setdefault('created_at', _iso(stat.st_mtime))
                record.setdefault('updated_at', _iso(stat.st_mtime))
                state['notes'].append(record)
                known.add(meta['document_uid'])
                added.append(record['id'])
    return added


class MarkdownImporter:
    """Background scan of the notes folder; open windows reload when notes were imported."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='kavot-markdown-import', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(POLL_SECONDS):
            try:
                if import_markdown_notes():
                    from app.core.storage.cloud_sync.routes import notify_local_change
                    notify_local_change()
            except Exception:
                log.exception('Markdown import scan failed')


importer = MarkdownImporter()
