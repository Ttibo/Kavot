"""Notes: where their files live, reading and writing them, and their lifecycle.

The sidebar tree is built by :mod:`app.core.workspace.tree`; the one-time HTML
migration lives in :mod:`app.core.workspace.note_migration`.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_text, resolve_inside, safe_name
from app.core.projects import projects
from app.core.workspace import html_documents as html_docs
from app.core.records.repository import json_values, now, store


def _project(state: dict[str, Any], project_id: int | None) -> dict[str, Any] | None:
    return next((item for item in state["projects"] if item["id"] == project_id), None)


def _paper(state: dict[str, Any], paper_id: int | None) -> dict[str, Any] | None:
    return next((item for item in state["papers"] if item["id"] == paper_id), None)


def folder_parts(state: dict[str, Any], folder_id: int | None) -> list[str]:
    parts: list[str] = []
    seen: set[int] = set()
    while folder_id and folder_id not in seen:
        seen.add(folder_id)
        folder = next((item for item in state["note_folders"] if item["id"] == folder_id), None)
        if not folder:
            break
        parts.append(folder["name"])
        folder_id = folder.get("parent_id")
    return list(reversed(parts))


def _validate_folder(
    state: dict[str, Any], folder_id: int | None, project_id: int | None,
) -> None:
    if folder_id is None:
        return
    folder = next((item for item in state["note_folders"] if item["id"] == folder_id), None)
    if not folder:
        raise HTTPException(status_code=404, detail="Note folder not found")
    if folder.get("project_id") != project_id:
        raise HTTPException(status_code=422, detail="Note and folder must be in the same notes workspace")


def notes_directory(
    state: dict[str, Any], project_id: int | None, folder_id: int | None,
) -> Path:
    _validate_folder(state, folder_id, project_id)
    if project_id:
        project = _project(state, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        root = settings.notes_path / "projects" / projects.directory(project).name
    else:
        root = settings.notes_path / "general"
    for part in folder_parts(state, folder_id):
        root /= safe_name(part, "folder")
    return root


def image_note_source(value: str) -> Path:
    roots = {"projects": settings.projects_path, "notes": settings.notes_path, "library": settings.library_path, "databases": settings.databases_path}
    parts = Path(value).parts
    centralized = len(parts) == 4 and parts[:3] == ('databases', 'resources', 'files')
    in_notes = len(parts) >= 3 and parts[0] == 'notes' and parts[1] in {'general', 'projects'}
    if len(parts) < 3 or parts[0] not in roots or (not in_notes and "assets" not in parts[1:-1] and not centralized):
        raise HTTPException(422, "The source image must be in the notes workspace or an assets folder")
    try:
        source = resolve_inside(roots[parts[0]], str(Path(*parts[1:])))
    except ValueError as error:
        raise HTTPException(422, "Invalid source image path") from error
    if source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff", ".bmp"}:
        raise HTTPException(422, "The source must be an image")
    return source


def note_path(note: dict[str, Any], state: dict[str, Any]) -> Path:
    if note.get('storage_path'):
        return resolve_inside(settings.storage_path, note['storage_path'])
    if note.get("source_image_path"):
        return image_note_source(note["source_image_path"]).with_suffix(".html" if note.get('content_format') == 'html' else '.md')
    filename = note.get("file_name") or f"{note['id']}-{safe_name(note['title'], 'note')}.html"
    if note.get("paper_id"):
        from app.plugins.papers.library import paper_directory
        paper = _paper(state, note["paper_id"])
        root = paper_directory(paper) if paper else settings.library_path / f"paper-{note['paper_id']}"
    else:
        root = notes_directory(state, note.get("project_id"), note.get("folder_id"))
    return root / filename


def write_note(note: dict[str, Any], state: dict[str, Any], previous: Path | None = None, refresh_links: bool = True) -> None:
    note['content_format'] = 'html'
    if note.get('file_name'):
        note['file_name'] = str(Path(note['file_name']).with_suffix('.html'))
    target = note_path(note, state)
    note["file_name"] = target.name
    note['content'] = html_docs.fragment(note.get('content', ''))
    atomic_write_text(target, html_docs.serialize(note, note['content'], target, state))
    if previous and previous != target and previous.is_file():
        previous.unlink()
    if previous and previous != target and refresh_links:
        refresh_document_links(state, {note['id']})


def refresh_document_links(state: dict[str, Any], moved_note_ids: set[int] | None = None) -> None:
    """Keep standalone links usable after a registered document moves.

    With ``moved_note_ids``, only documents linking to those notes are
    re-rendered: parsing every document made each move cost the whole library.
    """
    # Portable links keep their original target as data-kavot-href="#note-ID".
    markers = None if moved_note_ids is None else tuple(f'"#note-{note_id}"' for note_id in moved_note_ids)
    for item in state['notes']:
        if item.get('trashed_at') or item.get('content_format') != 'html':
            continue
        path = note_path(item, state)
        if not path.is_file():
            continue
        raw = path.read_text(encoding='utf-8')
        if markers is not None and not any(marker in raw for marker in markers):
            continue
        current = {**item, **html_docs.metadata(raw)}
        rendered = html_docs.serialize(current, html_docs.read(raw, path), path, state)
        if rendered != raw:
            atomic_write_text(path, rendered)





def enrich_note(note: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    note = dict(note)
    path = note_path(note, state)
    if path.is_file() and not note.get('trashed_at'):
        # One read for the text and its hash: listing notes enriches every one of them.
        raw = path.read_bytes()
        source = raw.decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
        if path.suffix == '.html':
            note['content'] = html_docs.read(source, path)
            meta = html_docs.metadata(source)
            for key in ('title', 'document_uid', 'properties', 'presentation'):
                if key in meta:
                    note[key] = meta[key]
            note['content_format'] = 'html'
        else:
            note['content'] = source
        note['content_hash'] = hashlib.sha256(raw).hexdigest()
    project = _project(state, note.get("project_id"))
    paper = _paper(state, note.get("paper_id"))
    template = next((item for item in state["note_templates"] if item["id"] == note.get("template_id")), None)
    return {**note, "project_name": project.get("name") if project else None, "paper_title": paper.get("title") if paper else None, "template_color": template.get("color") if template else None,
            "template_name": template.get("name") if template else None,
            "template_icon": template.get("icon", "note") if template else "note"}


ARTICLE_PDF_LINKS_VERSION = 2


def _pdf_links(paper_id: int) -> list[tuple[str, str]]:
    return [("Open in Kavot", f"#paper-{paper_id}"), ("Open in the computer’s reader", f"#pdf-external-{paper_id}")]


def _metadata_table_with_pdf(content: str, paper_id: int) -> str | None:
    """Adds a PDF row to the article's Information/Details table; None when there is no such table."""
    links = _pdf_links(paper_id)
    if html_docs.is_html(content):
        # Cells written by the editor wrap their text in a paragraph.
        cell_text = lambda tag, text: rf"<{tag}\b[^>]*>\s*(?:<p\b[^>]*>)?\s*{text}\s*(?:</p>)?\s*</{tag}>"
        table = next((match for match in re.finditer(r"<table\b.*?</table>", content, re.S | re.I)
                      if re.search(cell_text("t[hd]", "Information"), match.group(0), re.I)), None)
        if not table:
            return None
        if re.search(cell_text("td", "PDF"), table.group(0), re.I):
            return content
        cell = " · ".join(f'<a href="{href}">{label}</a>' for label, href in links)
        row = f"<tr><td><p>PDF</p></td><td><p>{cell}</p></td></tr>\n"
        body_end = table.group(0).rfind("</tbody>")
        position = table.start() + (body_end if body_end >= 0 else table.group(0).rfind("</table>"))
        return content[:position] + row + content[position:]
    lines = content.split("\n")
    start = next((index for index, line in enumerate(lines) if re.fullmatch(r"\|\s*Information\s*\|\s*Details\s*\|\s*", line)), None)
    if start is None:
        return None
    end = start
    while end + 1 < len(lines) and lines[end + 1].lstrip().startswith("|"):
        end += 1
    if any(re.match(r"\|\s*PDF\s*\|", line) for line in lines[start:end + 1]):
        return content
    lines.insert(end + 1, "| PDF | " + " · ".join(f"[{label}]({href})" for label, href in links) + " |")
    return "\n".join(lines)


def _without_legacy_pdf_section(content: str, paper_id: int) -> str:
    """Drops the PDF section older versions appended, now that the links live in the table."""
    if html_docs.is_html(content):
        return re.sub(rf"<h2\b[^>]*>\s*PDF\s*</h2>\s*<p\b[^>]*>(?:(?!</p>).)*?#paper-{paper_id}\b(?:(?!</p>).)*?</p>\s*", "", content, flags=re.S)
    return re.sub(rf"\n*## PDF\n+\[[^\]\n]*\]\(#paper-{paper_id}\)(?: · \[[^\]\n]*\]\(#pdf-external-{paper_id}\))?[ \t]*\n?", "\n", content)


def add_article_pdf_links(note: dict[str, Any]) -> None:
    """Seed once per version; subsequent user edits to the reading note remain authoritative."""
    paper_id = note.get("paper_id")
    if not paper_id or (note.get("article_pdf_links_version") or 0) >= ARTICLE_PDF_LINKS_VERSION:
        return
    content = str(note.get("content") or "").rstrip()
    in_table = _metadata_table_with_pdf(content, paper_id)
    if in_table is not None:
        if in_table != content:
            note["content"] = _without_legacy_pdf_section(in_table, paper_id)
    elif not note.get("article_pdf_links_version"):
        # No metadata table (custom layout): the links go in their own section, as before.
        links = [f"[{label}]({href})" for label, href in _pdf_links(paper_id) if f"({href})" not in content]
        if links:
            addition = "\n\n## PDF\n\n" + " · ".join(links) + "\n"
            note["content"] = content + (html_docs.fragment(addition) if html_docs.is_html(content) else addition)
    note["article_pdf_links_version"] = ARTICLE_PDF_LINKS_VERSION


def backfill_article_pdf_links() -> None:
    outdated = lambda n: n.get("paper_id") and not n.get("trashed_at") and (n.get("article_pdf_links_version") or 0) < ARTICLE_PDF_LINKS_VERSION
    if not any(outdated(n) for n in store.read()["notes"]):
        return
    with store.transaction() as state:
        for note in state["notes"]:
            if outdated(note):
                add_article_pdf_links(note)
                write_note(note, state)


def list_notes(project_id: int | None = None, paper_id: int | None = None) -> list[dict[str, Any]]:
    from app.core.workspace.note_migration import migrate_html_notes
    migrate_html_notes(scan_workspace=False)
    backfill_article_pdf_links()
    state = store.read()
    items = [item for item in state["notes"] if not item.get("trashed_at")]
    if project_id is not None:
        items = [item for item in items if item.get("project_id") == project_id]
    if paper_id is not None:
        items = [item for item in items if item.get("paper_id") == paper_id]
    return [enrich_note(item, state) for item in sorted(items, key=lambda value: value["updated_at"], reverse=True)]


def unique_note_title(state: dict[str, Any], title: str, *, numbered: bool = False) -> str:
    titles = {str(note.get("title", "")).strip().casefold() for note in state["notes"]}
    if not numbered and title.casefold() not in titles:
        return title
    base = title[:228].rstrip()
    pattern = re.compile(rf"^{re.escape(base.casefold())}(?: (\d+))?$")
    numbers = [int(match.group(1) or 1) for existing in titles if (match := pattern.fullmatch(existing))]
    number = max(numbers, default=0) + 1
    while f"{base} {number}".casefold() in titles:
        number += 1
    return f"{base} {number}"


def create_note(payload: Any, *, system_kind: str = "standard") -> dict[str, Any]:
    values = json_values(payload)
    with store.transaction() as state:
        _validate_folder(state, values.get("folder_id"), values.get("project_id"))
        if values.get("source_image_path"):
            source = image_note_source(values["source_image_path"])
            if not source.is_file():
                raise HTTPException(404, "Source image not found")
            target = source.with_suffix(".html")
            notes_directory(state, values.get("project_id"), values.get("folder_id"))
            if values.get("paper_id") or values.get("template_id"):
                raise HTTPException(422, "Image OCR notes cannot use article or template storage")
            existing = next((item for item in state["notes"] if note_path(item, state) == target), None)
            if existing:
                if not existing.get("source_image_path") or image_note_source(existing["source_image_path"]) != source:
                    raise HTTPException(409, "A note with this filename already belongs to another source")
                if existing.get("trashed_at"):
                    raise HTTPException(409, "An OCR note for this image is in the trash. Restore it before continuing.")
                return enrich_note(existing, state)
            if target.exists() or target.with_suffix('.md').exists():
                raise HTTPException(409, "A document with this image's name already exists in assets")
            values["file_name"] = target.name
        timestamp = now()
        template = next((item for item in state["note_templates"] if item["id"] == values.get("template_id")), None)
        if values.get("template_id") is not None and (not template or template.get("archived")):
            raise HTTPException(422, "Unknown or archived card template")
        project = _project(state, values.get("template_context_project_id") or values.get("project_id")) or {}
        paper = _paper(state, values.get("paper_id")) or {}
        if template:
            values["template_revision"] = template.get("revision", 1)
            values["title"] = render_template(template["title_template"], project, paper, state)
            values["content"] = render_template(template["content_template"], project, paper, state)
        original_title = values["title"].strip()
        if not str(values.get("content") or "").strip():
            # Same starting markup as the editor's New note button: a single H1 with
            # the title, so the page header and the body agree whatever created the note.
            values["content"] = f"# {original_title}\n\n"
        generic = bool(re.fullmatch(r"(?:new note|nouvelle note|note)(?: \d+)?", original_title, re.IGNORECASE))
        numbered = generic or bool(template and "{{" not in template["title_template"])
        values["title"] = original_title if system_kind == "project_home" else unique_note_title(state, "Note" if generic else original_title, numbered=numbered)
        # Keep the initial heading aligned, without changing the rest of a template.
        heading = f"# {original_title}"
        content = values.get("content", "")
        if content == heading or content.startswith(heading + "\n"):
            values["content"] = f"# {values['title']}" + content[len(heading):]
        note = {"id": store.next_id(state, "notes"), **values, "system_kind": system_kind, "trashed_at": None, "trash_id": None, "created_at": timestamp, "updated_at": timestamp}
        state["notes"].append(note)
        add_article_pdf_links(note)
        write_note(note, state)
        return enrich_note(note, state)


def create_article_note(paper_id: int) -> dict[str, Any]:
    backfill_article_pdf_links()
    state = store.read()
    existing = next((item for item in state["notes"] if item.get("paper_id") == paper_id and not item.get("trashed_at")), None)
    if existing:
        return enrich_note(existing, state)
    paper = _paper(state, paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Article not found")
    template = next((item for item in state["note_templates"] if item.get("is_article_default") and not item.get("archived")), None)
    title = render_template(template["title_template"], {}, paper) if template else f"Notes — {paper['title']}"
    content = render_template(template["content_template"], {}, paper) if template else f"# {paper['title']}\n\n## Notes\n\n"
    class Payload:
        def model_dump(self, **_: Any) -> dict[str, Any]:
            return {"paper_id": paper_id, "title": title, "content": content, "project_id": None, "folder_id": None, "template_id": template.get("id") if template else None, "template_context_project_id": None}
    return create_note(Payload())


def update_note(note_id: int, payload: Any) -> dict[str, Any]:
    values = json_values(payload, exclude_unset=True)
    with store.transaction() as state:
        note = next((item for item in state["notes"] if item["id"] == note_id), None)
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        if note.get("system_kind") == "project_home" and any(
            key in values and values[key] != note.get(key) for key in ("project_id", "folder_id")
        ):
            raise HTTPException(status_code=409, detail="The project note must stay at the project root")
        _validate_folder(
            state,
            values.get("folder_id", note.get("folder_id")),
            values.get("project_id", note.get("project_id")),
        )
        previous = note_path(note, state)
        expected = values.pop('expected_hash', None)
        if expected is not None and expected != html_docs.fingerprint(previous):
            raise HTTPException(409, 'The document changed. Reload it before applying your changes again.')
        if previous.is_file() and previous.suffix == '.html':
            meta = html_docs.metadata(previous.read_text(encoding='utf-8'))
            for key in ('properties', 'presentation', 'document_uid', 'title'):
                if key in meta and key not in values:
                    note[key] = meta[key]
        if "content" not in values and previous.is_file():
            # Renaming or moving must not restore stale catalog text over a
            # document received from another device.
            note["content"] = html_docs.read(previous.read_text(encoding="utf-8"), previous)
        elif previous.is_file() and previous.suffix == ".html" and all(
                key == "content" or value == note.get(key) for key, value in values.items()) and (
                html_docs.fragment(values["content"])
                == html_docs.fragment(html_docs.read(previous.read_text(encoding="utf-8"), previous))):
            # Editors re-save unchanged notes; rewriting would bump updated_at and
            # invalidate pending agent proposals that check the file hash.
            note["content"] = html_docs.fragment(values["content"])
            return enrich_note(note, state)
        if note.get("source_image_path") and any(key in values and values[key] != note.get(key) for key in ("project_id", "folder_id")):
            note.pop("source_image_path")
        if any(key in values and values[key] != note.get(key) for key in ('project_id', 'folder_id')):
            note.pop('storage_path', None)
        note.update(values)
        if note_path(note, state) != previous and note_path(note, state).exists():
            raise HTTPException(409, "A note with this filename already exists in the destination")
        note["updated_at"] = now()
        write_note(note, state, previous)
        return enrich_note(note, state)


def delete_note(note_id: int) -> None:
    with store.transaction() as state:
        note = next((item for item in state["notes"] if item["id"] == note_id), None)
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        trash_note(note, state)
        for project in state["projects"]:
            projects.remove_note_reference(project, note_id)


def trash_note(note: dict[str, Any], state: dict[str, Any]) -> None:
    if note.get("system_kind") == "project_home":
        raise HTTPException(status_code=409, detail="The project note cannot be deleted")
    source = note_path(note, state)
    trash_id = uuid.uuid4().hex
    destination = settings.notes_path / ".trash" / trash_id / source.name
    if source.is_file():
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
    note["original_file_path"] = str(source)
    note["trash_file_path"] = str(destination) if destination.is_file() else None
    note["trashed_at"] = now()
    note["trash_id"] = trash_id
    note["updated_at"] = now()


def apply_note_template(note_id: int, template_id: int, payload: Any) -> dict[str, Any]:
    values = json_values(payload)
    with store.transaction() as state:
        note = next(
            (item for item in state["notes"] if item["id"] == note_id and not item.get("trashed_at")),
            None,
        )
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        template = next(
            (item for item in state["note_templates"] if item["id"] == template_id),
            None,
        )
        if not template or template.get("archived"):
            raise HTTPException(status_code=404, detail="Template not found")
        project = _project(
            state,
            note.get("template_context_project_id") or note.get("project_id"),
        ) or {}
        paper = _paper(state, note.get("paper_id")) or {}
        previous = note_path(note, state)
        title = render_template(template["title_template"], project, paper, state)
        content = render_template(template["content_template"], project, paper, state)
        if values["mode"] == "insert":
            current = str(note.get("content") or "")
            cursor = min(int(values.get("cursor") or 0), len(current))
            note["content"] = html_docs.insert(current, content, cursor)
        else:
            note["title"] = title
            note["content"] = content
        note["template_id"] = template_id
        note["template_revision"] = template.get("revision", 1)
        note["updated_at"] = now()
        write_note(note, state, previous)
        return enrich_note(note, state)


def render_template(
    value: str,
    project: dict[str, Any] | None = None,
    paper: dict[str, Any] | None = None,
    state: dict[str, Any] | None = None,
) -> str:
    project, paper = project or {}, paper or {}
    replacements = {
        "{{project_name}}": project.get("name", "Project"),
        "{{project_description}}": project.get("description", ""),
        "{{project_status}}": project.get("status", "active"),
        "{{article_title}}": paper.get("title", "Untitled article"),
        "{{article_authors}}": ", ".join(paper.get("authors", [])) or "Unknown authors",
        "{{article_abstract}}": paper.get("abstract", ""),
        "{{article_publication}}": paper.get("publication", ""),
        "{{article_date}}": paper.get("published_at", ""),
        "{{article_doi}}": paper.get("doi", ""),
        "{{article_url}}": paper.get("url", ""),
        "{{article_tags}}": ", ".join(paper.get("tags", [])),
        "{{article_status}}": paper.get("status", "to_read"),
        "{{article_metadata}}": article_metadata(paper),
        "{{created_date}}": str(project.get("created_at", ""))[:10],
        "{{today}}": now()[:10],
    }
    for key, replacement in replacements.items():
        value = value.replace(key, str(replacement))
    if state is not None:
        project_id = project.get("id")
        for source in _template_sources(state, project_id):
            value = value.replace(source["placeholder"], source["preview"])
    return value


def article_metadata(paper: dict[str, Any]) -> str:
    if not paper:
        return "_Metadata unavailable._"
    rows = [("Authors", ", ".join(paper.get("authors", []))), ("Publication", paper.get("publication")), ("Date", paper.get("published_at")), ("DOI", paper.get("doi")), ("Status", paper.get("status")), ("Tags", ", ".join(paper.get("tags", [])))]
    if paper.get("id"):
        rows.append(("PDF", " · ".join(f"[{label}]({href})" for label, href in _pdf_links(paper["id"]))))
    return "| Information | Details |\n| --- | --- |\n" + "\n".join(f"| {name} | {value or '—'} |" for name, value in rows)


def _template_sources(
    state: dict[str, Any], project_id: int | None = None,
) -> list[dict[str, Any]]:
    definitions = [("projects", "Projects"), ("library", "Library"), ("tasks", "Tasks")]
    sources = []
    for name, label in definitions:
        collection = "papers" if name == "library" else name
        items = state[collection]
        if project_id:
            if collection == "papers":
                items = [item for item in items if project_id in item.get("project_ids", [])]
            elif collection == "tasks":
                items = [item for item in items if item.get("project_id") == project_id]
            elif collection == "projects":
                items = [item for item in items if item.get("id") == project_id]
        sources.append({"name": name, "placeholder": f"{{{{{name}}}}}", "label": label, "description": f"Local {label.lower()} records.", "count": len(items), "preview": "\n".join(f"- {item.get('name') or item.get('title')}" for item in items) or "_No records._"})
    return sources


def asset_path(note_id: int, filename: str) -> Path:
    if safe_name(filename, "") != filename:
        raise HTTPException(status_code=404, detail="Asset not found")
    note = store.find("notes", note_id, "Note")
    return note_path(note, store.read()).parent / "assets" / filename

