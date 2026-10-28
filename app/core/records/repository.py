from __future__ import annotations

import copy
import json
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from fastapi import HTTPException

from app.core.kernel.config import RESOURCES_DIR, settings
from app.core import journal
from app.core.kernel.files import atomic_write_json, read_json_object


# kavot.state.json keys owned by the core; plugins add theirs through the registry.
CORE_COLLECTIONS = (
    "projects",
    "workflows",
    "watchers",
    "collection_watchers",
    "topics",
    "notes",
    "note_folders",
    "note_placements",
    "note_templates",
    "note_scripts",
)


def collections() -> tuple[str, ...]:
    """Every state key of this workspace: the core's, then the loaded plugins'."""
    from app.core.kernel.plugins import load
    return CORE_COLLECTIONS + tuple(load().state_collections)


DEFAULT_TEMPLATES = json.loads((RESOURCES_DIR / "card_templates.json").read_text(encoding="utf-8"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _initial_state() -> dict[str, Any]:
    from app.core.kernel.plugins import load
    state: dict[str, Any] = {"schema_version": 1, "card_templates_version": 1}
    for name in collections():
        state[name] = []
    timestamp = now()
    for initialize in load().state_initializers:
        initialize(state, timestamp)
    state["note_templates"] = [{**item, "created_at": timestamp, "updated_at": timestamp} for item in DEFAULT_TEMPLATES]
    return state


class JsonRepository:
    """Small transactional repository backed by one atomically-written JSON file."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._batch = threading.local()

    def ensure(self) -> dict[str, Any] | None:
        """Upgrade the catalogue if needed and return it, so readers parse it once."""
        settings.storage_path.mkdir(parents=True, exist_ok=True)
        for path in (settings.library_path, settings.projects_path, settings.notes_path, settings.databases_path):
            path.mkdir(parents=True, exist_ok=True)
        if not settings.state_path.is_file():
            state = _initial_state()
            self._restore_file_native_projects(state)
            self._restore_html_documents(state)
            atomic_write_json(settings.state_path, state)
            return state
        state = read_json_object(settings.state_path)
        if not state:
            return None
        changed = False
        for collection in collections():
            if collection not in state:
                state[collection] = []
                changed = True
        templates = state.setdefault("note_templates", [])
        timestamp = now()
        from app.core.kernel.plugins import load
        for migrate in load().state_migrations:
            changed = migrate(state, timestamp) or changed
        # One-time metadata migration. Never recreate, rename or reset user templates.
        if not state.get("card_templates_version"):
            defaults = {item["name"].casefold(): item for item in DEFAULT_TEMPLATES}
            for template in templates:
                default = defaults.get(str(template.get("name", "")).casefold(), {})
                template.setdefault("icon", default.get("icon", "note"))
                template.setdefault("archived", False)
            state["card_templates_version"] = 1
            changed = True
        if changed:
            atomic_write_json(settings.state_path, state)
        return state

    def _restore_html_documents(self, state: dict[str, Any]) -> None:
        """Recover document records from portable files when the catalogue is lost."""
        from app.core.workspace import html_documents
        for root in (settings.notes_path, settings.library_path, settings.databases_path):
            for path in root.rglob('*.html'):
                if any(part.startswith('.') for part in path.relative_to(root).parts) or path.name.endswith('.generated.html'):
                    continue
                meta = html_documents.metadata(path.read_text(encoding='utf-8'))
                if meta.get('kind') != 'note' or not meta.get('document_uid'):
                    continue
                if any(n.get('document_uid') == meta['document_uid'] for n in state['notes']):
                    continue
                identifier = meta.get('legacy_id')
                if not isinstance(identifier, int) or any(n['id'] == identifier for n in state['notes']):
                    identifier = self.next_id(state, 'notes')
                allowed = ('document_uid', 'title', 'created_at', 'updated_at', 'properties', 'presentation', 'project_id', 'paper_id', 'folder_id', 'template_id', 'resource_id', 'source_image_path', 'drawing', 'drawing_preview', 'zotero_notes', 'zotero_folder_ids', 'article_pdf_links_version', 'system_kind')
                record = {'project_id': None, 'paper_id': None, 'folder_id': None, 'created_at': now(), 'updated_at': now(), 'title': path.stem,
                          **{k: meta[k] for k in allowed if k in meta}, 'id': identifier,
                          'file_name': path.name, 'storage_path': path.relative_to(settings.storage_path).as_posix(), 'content_format': 'html',
                          'content': html_documents.read(path.read_text(encoding='utf-8'), path)}
                # Folder metadata can be recovered later; the actual path remains authoritative.
                if not any(f['id'] == record.get('folder_id') for f in state['note_folders']):
                    record['folder_id'] = None
                state['notes'].append(record)

    def _restore_file_native_projects(self, state: dict[str, Any]) -> None:
        for path in settings.projects_path.glob("*/project.kavot.json"):
            manifest = read_json_object(path)
            if not manifest or manifest.get("kind") != "kavot.project":
                continue
            try:
                project_id = int(manifest["id"])
            except (KeyError, TypeError, ValueError):
                continue
            state["projects"].append({
                "id": project_id,
                "name": str(manifest.get("name") or path.parent.name),
                "description": str(manifest.get("description") or ""),
                "color": str(manifest.get("color") or "#087e86"),
                "status": str(manifest.get("status") or "active"),
                "external_resources": list(manifest.get("external_resources") or []),
                "created_at": str(manifest.get("created_at") or now()),
                "updated_at": str(manifest.get("updated_at") or now()),
            })

    def read(self) -> dict[str, Any]:
        active = getattr(self._batch, "state", None)
        if active is not None:
            if self._batch.path != settings.state_path:
                raise HTTPException(409, "The workspace changed during import. Retry in the selected workspace.")
            return active
        return self.ensure() or _initial_state()

    @contextmanager
    def batch(self) -> Iterator[dict[str, Any]]:
        """One commit for a bounded group of local operations on this thread.

        Keep network calls outside this scope. The lock prevents concurrent edits
        from being overwritten; other threads never see the uncommitted state.
        Completed batches survive a later failed page or interrupted download.
        """
        with self._lock:
            if getattr(self._batch, "state", None) is not None:
                yield self.read()
                return
            state = self.read()
            before = copy.deepcopy(state)
            seen = journal.fingerprint(state, collections())
            self._batch.state = state
            self._batch.path = settings.state_path
            try:
                yield state
                self.read()  # Check the workspace again before committing.
                if state != before:
                    atomic_write_json(self._batch.path, state)
                    journal.record(journal.changes(seen, state))
            finally:
                del self._batch.state
                del self._batch.path

    @contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        with self._lock:
            state = self.read()
            outside_batch = getattr(self._batch, "state", None) is None
            seen = journal.fingerprint(state, collections()) if outside_batch else None
            yield state
            if outside_batch:
                atomic_write_json(settings.state_path, state)
                journal.record(journal.changes(seen, state))

    def list(self, collection: str) -> list[dict[str, Any]]:
        return copy.deepcopy(self.read().get(collection, []))

    def find(self, collection: str, record_id: int, label: str = "Record") -> dict[str, Any]:
        record = next((item for item in self.read().get(collection, []) if int(item.get("id", 0)) == int(record_id)), None)
        if record is None:
            raise HTTPException(status_code=404, detail=f"{label} not found")
        return copy.deepcopy(record)

    @staticmethod
    def next_id(state: dict[str, Any], collection: str) -> int:
        return max((int(item.get("id", 0)) for item in state.get(collection, [])), default=0) + 1

    def create(self, collection: str, values: dict[str, Any]) -> dict[str, Any]:
        with self.transaction() as state:
            timestamp = now()
            record = {
                "id": self.next_id(state, collection),
                **values,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            state[collection].append(record)
            return copy.deepcopy(record)

    def update(self, collection: str, record_id: int, values: dict[str, Any], label: str = "Record") -> dict[str, Any]:
        with self.transaction() as state:
            record = next((item for item in state.get(collection, []) if int(item.get("id", 0)) == int(record_id)), None)
            if record is None:
                raise HTTPException(status_code=404, detail=f"{label} not found")
            record.update(values)
            record["updated_at"] = now()
            return copy.deepcopy(record)

    def delete(self, collection: str, record_id: int, label: str = "Record") -> dict[str, Any]:
        with self.transaction() as state:
            records = state.get(collection, [])
            index = next((index for index, item in enumerate(records) if int(item.get("id", 0)) == int(record_id)), None)
            if index is None:
                raise HTTPException(status_code=404, detail=f"{label} not found")
            return records.pop(index)

    def replace(self, state: dict[str, Any]) -> None:
        with self._lock:
            atomic_write_json(settings.state_path, state)
            journal.record([{"op": "replace", "ref": "kavot://workspace", "collection": "workspace"}])


store = JsonRepository()


def json_values(model: Any, *, exclude_unset: bool = False) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_unset=exclude_unset)
