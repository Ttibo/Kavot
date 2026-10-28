"""What the search index contains: one document per record, note passage or PDF page.

Every document has a stable address (``kavot://<collection>/<id>`` plus an
optional ``#anchor``) that the MCP ``read`` tool understands. Documents come in
groups (a note and its passages, an article's PDF pages): a source that sees a
group unchanged since the last sync yields ``Unchanged(group)`` instead of
reading it again. Plugins add sources through ``registry.search_sources``;
each source is called as ``source(state, known)`` where ``known`` maps a group
to the version stored in the index.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Iterator

PASSAGE_CHARS = 900


@dataclass
class Document:
    ref: str
    collection: str
    item_id: str
    title: str
    text: str
    anchor: str = ""
    project_ids: list[int] = field(default_factory=list)
    updated_at: str = ""
    group: str = ""
    version: str = ""

    def __post_init__(self):
        self.group = self.group or self.ref.split("#", 1)[0]
        if not self.version:
            self.version = hashlib.blake2b(f"{self.title}\0{self.text}\0{self.project_ids}".encode(), digest_size=10).hexdigest()


@dataclass
class Unchanged:
    group: str


def ref(collection: str, item_id: Any, anchor: str = "") -> str:
    return f"kavot://{collection}/{item_id}" + (f"#{anchor}" if anchor else "")


def projects_of(item: dict[str, Any]) -> list[int]:
    ids = list(item.get("project_ids") or [])
    if item.get("project_id") is not None:
        ids.append(item["project_id"])
    return [int(value) for value in dict.fromkeys(ids) if isinstance(value, int) or str(value).isdigit()]


def flatten(value: Any) -> str:
    if isinstance(value, dict):
        return " ".join(flatten(v) for v in value.values())
    if isinstance(value, (list, tuple)):
        return " ".join(flatten(v) for v in value)
    return "" if value is None or isinstance(value, bool) else str(value)


HEADINGS = {"h1", "h2", "h3", "h4"}


def html_blocks(html: str) -> list[tuple[str, str, str]]:
    """(id, tag, text) of the top-level blocks of a note body that contain text."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    root = soup.body or soup
    blocks = []
    for block in root.find_all(recursive=False):
        text = " ".join(block.get_text(" ", strip=True).split())
        if text:
            blocks.append((block.get("id") or "", block.name or "", text))
    if not blocks:
        loose = " ".join(root.get_text(" ", strip=True).split())
        if loose:
            blocks.append(("", "p", loose))
    return blocks


def html_passages(html: str, *, with_blocks: bool = False) -> list[tuple]:
    """(anchor, text) passages of a note body, cut on block boundaries and before each heading.

    The anchor is the id of the passage's first block (``p<n>`` when it has none), so a
    heading's id addresses the section it opens. ``with_blocks`` adds the ids of all blocks.
    """
    passages, parts, ids, size = [], [], [], 0

    def flush():
        anchor = ids[0] or f"p{len(passages) + 1}" if ids else f"p{len(passages) + 1}"
        passages.append((anchor, " ".join(parts), [i for i in ids if i]) if with_blocks else (anchor, " ".join(parts)))

    for block_id, tag, text in html_blocks(html):
        if parts and (size + len(text) > PASSAGE_CHARS or tag in HEADINGS):
            flush()
            parts, ids, size = [], [], 0
        parts.append(text)
        ids.append(block_id)
        size += len(text)
    if parts:
        flush()
    return passages


def html_sections(html: str) -> list[dict[str, Any]]:
    """Sections opened by headings: anchor, heading, level, text length and first sentence."""
    from app.core.search.text import first_sentences
    sections, current = [], None
    for index, (block_id, tag, text) in enumerate(html_blocks(html)):
        if tag in HEADINGS:
            current = {"anchor": block_id, "title": text[:120], "level": int(tag[1]), "chars": 0, "lead": ""}
            sections.append(current)
        elif current is not None:
            current["chars"] += len(text)
            if not current["lead"]:
                current["lead"] = first_sentences(text, 110)
    return sections


def passage_documents(collection: str, item_id: Any, title: str, passages: list[tuple[str, str]], *,
                      version: str, project_ids: list[int], updated_at: str = "", prefix: str = "p",
                      group: str = "") -> Iterator[Document]:
    """The item's own address for the first passage, so an item is always findable by its title."""
    base = ref(collection, item_id)
    for index, (anchor, text) in enumerate(passages or [("", "")]):
        anchor = "" if index == 0 and not group else (anchor or f"{prefix}{index + 1}")
        yield Document(ref(collection, item_id, anchor), collection, str(item_id), title, text, anchor=anchor,
                       project_ids=project_ids, updated_at=updated_at, group=group or base, version=version)


def note_documents(state: dict[str, Any], known: dict[str, str]) -> Iterator[Document | Unchanged]:
    from app.core.workspace import documents, html_documents
    for note in state.get("notes", []):
        if note.get("trashed_at"):
            continue
        try:
            path = documents.note_path(note, state)
            stat = path.stat()
        except (OSError, ValueError):
            continue
        group = ref("notes", note["id"])
        version = f"{stat.st_mtime_ns}:{stat.st_size}:{note.get('title')}:{projects_of(note)}"
        if known.get(group) == version:
            yield Unchanged(group)
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix == ".html":
            body = html_documents.read(source, path)
        else:
            body = "".join(f"<p>{line}</p>" for line in source.splitlines() if line.strip())
        yield from passage_documents("notes", note["id"], note.get("title") or path.stem, html_passages(body),
                                     version=version, project_ids=projects_of(note), updated_at=note.get("updated_at", ""))


def record_documents(state: dict[str, Any], known: dict[str, str]) -> Iterator[Document]:
    """Projects, items of plugin collections declared with search_fields, and custom collection items."""
    from app.core.kernel.plugins import load
    from app.core.records import databases
    for project in state.get("projects", []):
        yield Document(ref("projects", project["id"]), "projects", str(project["id"]), project.get("name", ""),
                       project.get("description", ""), project_ids=[project["id"]], updated_at=project.get("updated_at", ""))
    for definition in load().collections:
        key, fields = definition.get("state_key"), definition.get("search_fields")
        if not key or not fields:
            continue
        title_field = definition.get("title_field", "title")
        for item in state.get(key, []):
            if item.get("trashed_at") or item.get("archived_at"):
                continue
            text = " · ".join(flatten(item.get(name)) for name in fields if name != title_field and item.get(name))
            yield Document(ref(definition["id"], item["id"]), definition["id"], str(item["id"]),
                           str(item.get(title_field) or item.get("name") or item["id"]), text,
                           project_ids=projects_of(item), updated_at=item.get("updated_at", ""))
    for definition in databases.list_databases():
        if definition.get("storage", {}).get("driver") != "json-files":
            continue
        labels = {f["id"]: f.get("name", f["id"]) for f in definition.get("fields", [])}
        for record in databases.records(definition["id"]):
            values = record.get("values", {})
            title = str(values.get("title") or record.get("title") or record["id"])
            text = " · ".join(f"{labels.get(k, k)}: {flatten(v)}" for k, v in values.items()
                              if k not in {"title", "content"} and flatten(v))
            content = flatten(values.get("content"))
            yield Document(ref(definition["id"], record["id"]), definition["id"], str(record["id"]), title,
                           (text + " " + content).strip(), project_ids=projects_of(values),
                           updated_at=record.get("updated_at", ""))


TEXT_FILES = {".md", ".txt"}
DATA_FILES = {".csv", ".tsv", ".json"}
IMAGE_FILES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
FILE_ROOTS = ("notes", "projects", "databases")
FILE_CHARS = 60_000


def file_ref(relative: str) -> str:
    from urllib.parse import quote
    return ref("files", quote(relative, safe=""))


def file_projects(state: dict[str, Any]) -> dict[str, int]:
    """Folder (relative to the workspace) -> project id, for project folders and project note folders."""
    from app.core.kernel.config import settings
    from app.core.projects import projects
    from app.core.workspace import documents
    folders = {}
    for project in state.get("projects", []):
        for folder in (projects.directory(project), documents.notes_directory(state, project["id"], None)):
            try:
                folders[folder.resolve().relative_to(settings.storage_path.resolve()).as_posix()] = project["id"]
            except (OSError, ValueError):
                continue
    return folders


def workspace_files(state: dict[str, Any]) -> Iterator[tuple[str, Any]]:
    """(relative path, Path) of the user's own files: text, data, PDFs and images outside notes and records."""
    from app.core.kernel.config import settings
    from app.core.workspace import documents
    root = settings.storage_path.resolve()
    notes = set()
    for note in state.get("notes", []):
        try:
            notes.add(documents.note_path(note, state).resolve())
        except (OSError, ValueError):
            continue
    allowed = TEXT_FILES | DATA_FILES | IMAGE_FILES | {".pdf"}
    for folder in FILE_ROOTS:
        for path in sorted((root / folder).rglob("*")):
            relative = path.relative_to(root)
            if (path.suffix.lower() not in allowed or not path.is_file() or path.resolve() in notes
                    or any(part.startswith(".") for part in relative.parts) or path.name.endswith((".kavot.json", ".generated.html"))
                    or (relative.parts[0] == "databases" and "items" in relative.parts)):
                continue
            yield relative.as_posix(), path


def file_text(path: Any) -> list[tuple[str, str]]:
    """Passages of a file, from its own text or from its existing extraction (PDF, image OCR)."""
    suffix = path.suffix.lower()
    if suffix in TEXT_FILES:
        paragraphs = [p.strip() for p in path.read_text(encoding="utf-8", errors="replace")[:FILE_CHARS].split("\n\n") if p.strip()]
        passages, parts, size = [], [], 0
        for paragraph in paragraphs:
            if parts and size + len(paragraph) > PASSAGE_CHARS:
                passages.append(("", " ".join(parts)))
                parts, size = [], 0
            parts.append(" ".join(paragraph.split()))
            size += len(paragraph)
        return passages + ([("", " ".join(parts))] if parts else [])
    if suffix in DATA_FILES:
        return [("", " ".join(path.read_text(encoding="utf-8", errors="replace")[:6000].split()))]
    from app.core.workspace import asset_metadata
    try:
        extraction = asset_metadata.read(path) or {}
    except (OSError, ValueError):
        return []
    if suffix == ".pdf":
        return [(f"page-{page['page']}", str(page.get("text", ""))[:4000]) for page in extraction.get("pages", [])
                if str(page.get("text", "")).strip()]
    text = " ".join(str(extraction.get("text") or "").split())
    return [("", text[:4000])] if text else []


def file_documents(state: dict[str, Any], known: dict[str, str]) -> Iterator[Document | Unchanged]:
    from pathlib import PurePosixPath
    folders = file_projects(state)
    for relative, path in workspace_files(state):
        group = file_ref(relative)
        stat = path.stat()
        project_ids = [pid for folder, pid in folders.items() if relative == folder or relative.startswith(folder + "/")]
        version = f"{stat.st_mtime_ns}:{stat.st_size}:{project_ids}"
        if path.suffix.lower() in {".pdf", *IMAGE_FILES}:
            # The extraction can appear after the file: include its date in the version.
            from app.core.workspace import asset_metadata
            try:
                version += f":{asset_metadata.metadata_path(path).stat().st_mtime_ns}"
            except (OSError, ValueError):
                pass
        if known.get(group) == version:
            yield Unchanged(group)
            continue
        item_id = group.removeprefix("kavot://files/")
        yield from passage_documents("files", item_id, PurePosixPath(relative).name, file_text(path) or [("", "")],
                                     version=version, project_ids=project_ids, updated_at=str(stat.st_mtime))


def all_documents(state: dict[str, Any], known: dict[str, str]) -> Iterator[Document | Unchanged]:
    from app.core.kernel.plugins import load
    yield from note_documents(state, known)
    yield from record_documents(state, known)
    yield from file_documents(state, known)
    for source in load().search_sources:
        yield from source(state, known)
