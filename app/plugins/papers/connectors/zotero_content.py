"""Local filing and editable Markdown notes imported from a Zotero library."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from bs4 import BeautifulSoup
from fastapi import HTTPException
from markdownify import markdownify

from app.models.documents import NoteCreate
from app.core.workspace import documents
from app.plugins.papers import library
from app.core.records.repository import now, store


def item_key(item: dict[str, Any]) -> str:
    return str(item.get("key") or (item.get("data") or {}).get("key") or "")


def sync_collections(items: list[dict[str, Any]], user_id: Any, *, notes: bool = False) -> dict[str, int]:
    """Upsert by source identity, resolving parents after all IDs are allocated."""
    remote = {item_key(item): item.get("data") or {} for item in items if item_key(item)}
    # Validate before writing: a malformed hierarchy must not create an invisible cycle.
    for key in remote:
        seen = {key}
        parent = remote[key].get("parentCollection")
        while parent:
            if parent in seen or parent not in remote:
                raise HTTPException(502, "Zotero returned an invalid collection hierarchy. Retry synchronization.")
            seen.add(parent)
            parent = remote[parent].get("parentCollection")
    collection = "note_folders" if notes else "paper_folders"
    with store.transaction() as state:
        previous = {note["id"]: documents.note_path(note, state) for note in state["notes"] if notes and not note.get("trashed_at")}
        local = {}
        for key, data in remote.items():
            folder = next((entry for entry in state[collection] if entry.get("zotero_key") == key and entry.get("zotero_user_id") == str(user_id)), None)
            if not folder:
                folder = {"id": store.next_id(state, collection), "created_at": now(), "parent_id": None,
                          "zotero_key": key, "zotero_user_id": str(user_id)}
                if notes:
                    folder.update(project_id=None, color="#b17a22")
                state[collection].append(folder)
            folder.update(name=str(data.get("name") or "Zotero collection"), updated_at=now())
            local[key] = folder
        for key, folder in local.items():
            folder["parent_id"] = local[remote[key]["parentCollection"]]["id"] if remote[key].get("parentCollection") else None
        for note in state["notes"]:
            if note["id"] in previous and documents.note_path(note, state) != previous[note["id"]]:
                documents.write_note(note, state, previous[note["id"]])
        return {key: folder["id"] for key, folder in local.items()}


def file_paper(paper_id: int, keys: list[str], folders: dict[str, int]) -> None:
    paper = store.find("papers", paper_id, "Article")
    imported = list(dict.fromkeys(folders[key] for key in keys if key in folders))
    metadata = paper.get("metadata") or {}
    old = set(metadata.get("zotero_folder_ids") or [])
    # Preserve local filing while replacing only memberships previously imported.
    local = [value for value in library.paper_folder_ids(paper) if value not in old]
    memberships = list(dict.fromkeys([*local, *imported]))
    values = {"folder_id": memberships[0] if memberships else None, "folder_ids": memberships,
              "metadata": {**metadata, "zotero_folder_ids": imported, "zotero_collections": keys}}
    if any(paper.get(key) != value for key, value in values.items()):
        library.update_paper(paper_id, values)


def note_markdown(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(["script", "style", "iframe", "object"]):
        tag.decompose()
    for tag in soup.find_all(["a", "img"]):
        attribute = "href" if tag.name == "a" else "src"
        value = str(tag.get(attribute) or "")
        try:
            scheme = urlsplit(value).scheme.lower()
        except ValueError:
            scheme = ""
        if scheme not in {"http", "https", "mailto", "zotero"}:
            if tag.name == "img":
                tag.replace_with(str(tag.get("alt") or "[Zotero embedded image]"))
            else:
                tag.unwrap()
    title = next((line.strip() for line in soup.get_text("\n").splitlines() if line.strip()), "Zotero note")[:180]
    return markdownify(str(soup), heading_style="ATX", bullets="-", keep_inline_images_in=["p", "div"]).strip(), title


def sync_notes(items: list[dict[str, Any]], papers: dict[str, dict[str, Any]], folders: dict[str, int], user_id: Any, report) -> dict[str, Any]:
    result = {"imported": 0, "updated": 0, "existing": 0, "conflicts": 0, "errors": []}
    by_source = {source: note for note in store.read()["notes"] for source in (note.get("zotero_notes") or {})}
    for index, item in enumerate(items):
        data = item.get("data") or {}
        key = item_key(item)
        if not key:
            continue
        source = f"{user_id}:{key}"
        content, title = note_markdown(str(data.get("note") or ""))
        report(phase="notes", completed=index, total=len(items), title=title, message="Importing Zotero notes…")
        parent = papers.get(str(data.get("parentItem") or ""))
        # Search the stored identity first, including trash, so retries never duplicate notes.
        note = by_source.get(source)
        prior = (note.get("zotero_notes") or {}).get(source) if note else None
        if prior and not prior.get("pending") and prior.get("html") == str(data.get("note") or "") and prior.get("collections") == (data.get("collections") or []) and not note.get("trashed_at"):
            result["existing"] += 1
            continue
        if note is None:
            if parent:
                note = documents.create_article_note(parent["id"])
            else:
                memberships = [folders[k] for k in data.get("collections") or [] if k in folders]
                note = documents.create_note(NoteCreate(title=title, folder_id=memberships[0] if memberships else None))
        with store.transaction() as state:
            note = next(entry for entry in state["notes"] if entry["id"] == note["id"])
            by_source[source] = note
            sources = note.setdefault("zotero_notes", {})
            prior = sources.get(source)
            from app.core.workspace import html_documents
            import uuid
            block = f"### Zotero note\n\n{content}"
            block_soup = BeautifulSoup(html_documents.fragment(block, identify=False), 'html.parser')
            identity = uuid.uuid5(uuid.NAMESPACE_URL, source).hex
            for number, element in enumerate(block_soup.find_all(True)):
                if element.name in {'p', 'h1', 'h2', 'h3', 'h4', 'table', 'ul', 'ol', 'pre', 'blockquote'}:
                    element['id'] = f'zotero-{identity}-{number}'
            block = f'<section id="zotero-{identity}">{block_soup}</section>'
            snapshot = {"html": str(data.get("note") or ""), "block": block, "version": item.get("version"), "collections": data.get("collections") or []}
            previous = documents.note_path(note, state)
            body = html_documents.read(previous.read_text(encoding='utf-8'), previous) if previous.is_file() else note.get('content') or ''
            existing_section = BeautifulSoup(body, 'html.parser').find(id=f'zotero-{identity}')
            prior_block = prior['block'] if prior else ''
            if prior and not html_documents.is_html(prior_block):
                # Adopt a legacy imported Markdown block only when its converted
                # contents still match exactly once. Personal edits stay intact.
                soup = BeautifulSoup(body, 'html.parser')
                children = [child for child in soup.children if getattr(child, 'name', None)]
                expected = [html_documents.semantic(str(child)) for child in BeautifulSoup(html_documents.fragment(prior_block), 'html.parser').children if getattr(child, 'name', None)]
                matches = [i for i in range(len(children) - len(expected) + 1) if expected and [html_documents.semantic(str(child)) for child in children[i:i + len(expected)]] == expected]
                if len(matches) == 1:
                    index = matches[0]
                    section = soup.new_tag('section', id=f'zotero-{identity}')
                    children[index].insert_before(section)
                    for child in children[index:index + len(expected)]:
                        section.append(child.extract())
                    body = str(soup)
                    existing_section = section
                    prior_block = str(section)
                    prior['block'] = prior_block
            if existing_section and prior and html_documents.semantic(str(existing_section)) == html_documents.semantic(prior_block):
                prior_block = str(existing_section)
            if note.get("trashed_at") or (prior and prior["block"] != block and body.count(prior_block) != 1):
                if prior:
                    prior["pending"] = snapshot
                result["conflicts"] += 1
                result["errors"].append({"note_id": note["id"], "title": title, "message": "The Kavot note was edited or moved to trash. Your content was kept. Review this note in Zotero before copying its latest changes."})
                continue
            if prior and prior["block"] == block:
                result["existing"] += 1
            elif prior:
                body = body.replace(prior_block, block, 1)
                result["updated"] += 1
            else:
                body = f"{body.rstrip()}\n\n{block}\n".lstrip()
                result["imported"] += 1
            sources[source] = snapshot
            if not parent and not note.get("paper_id"):
                memberships = list(dict.fromkeys(folders[k] for k in data.get("collections") or [] if k in folders))
                note["zotero_folder_ids"] = memberships
                note["folder_id"] = memberships[0] if memberships else None
            note.update(content=body, updated_at=now())
            documents.write_note(note, state, previous)
    report(phase="notes", completed=len(items), total=len(items), message="Zotero notes imported")
    return result
