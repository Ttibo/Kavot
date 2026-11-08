"""Publish selected domain objects, never the complete private workspace state."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException

from app.core.storage.cloud_sync.errors import CloudError
from app.core.workspace import documents
from app.core.projects import projects
from app.core.records.repository import store

# What can be shared: notes, projects, and the items of the Library and of Tasks.
DOMAINS = {"articles": "papers", "notes": "notes", "tasks": "tasks"}
FIELDS = {
    "projects": ["name", "description", "status"],
    "notes": ["title", "content"],
    "papers": ["title", "authors", "abstract", "publication", "published_at", "doi", "url", "tags", "status"],
    "tasks": ["title", "description", "status", "priority", "labels", "start_date", "due_date"],
}
LABELS = {"title": "Title", "name": "Name", "content": "Content", "description": "Description", "abstract": "Summary",
          "authors": "Authors", "status": "Status", "priority": "Priority", "tags": "Keywords", "labels": "Labels",
          "url": "Link", "publication": "Publication", "published_at": "Publication date", "due_date": "Due date",
          "start_date": "Start", "end_date": "End", "location": "Location"}


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return 0


def snapshot(source):
    state = store.read()
    entries, targets, attachments, dates = [], {}, set(), []

    def file(path):
        if path:
            candidate = Path(path)
            from app.core.kernel.config import settings
            if not candidate.is_absolute():
                candidate = settings.storage_path / candidate
            if candidate.is_file() and candidate.resolve().is_relative_to(settings.storage_path.resolve()):
                attachments.add(candidate.resolve())

    def add(domain, item):
        if domain == 'notes':
            item = documents.enrich_note(item, state)
        key = f"{domain}:{item['id']}"
        if key in targets or item.get("trashed_at") or item.get("archived_at"):
            return
        values = item
        names = FIELDS.get(domain, ["title", "content", "description"])
        fields = {}
        for name in dict.fromkeys(names):
            value = values.get(name)
            if name not in values and name not in {"content", "description"}:
                continue
            if isinstance(value, (dict, list)) and not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
                continue
            kind = "boolean" if type(value) is bool else "number" if type(value) in {int, float} else "tags" if isinstance(value, list) else "markdown" if name in {"content", "description", "abstract", "notes"} else "text"
            fields[name] = {"label": LABELS.get(name, name), "type": kind, "value": value if value is not None or kind in {"number", "boolean", "tags"} else ""}
        title = str(values.get("title") or values.get("name") or "Untitled")[:240]
        entries.append({"key": key, "title": title, "fields": fields})
        targets[key] = (domain, item["id"])
        dates.append(timestamp(item.get("updated_at")))
        if domain == "papers":
            file(item.get("file_path"))
        if domain == "notes":
            file(item.get("source_image_path"))
            # Include only assets explicitly referenced by this note.
            import re
            from urllib.parse import unquote
            for name in re.findall(r"/api/notes/" + str(item['id']) + r"/assets/([^\s)\]>]+)", item.get("content", "")):
                try:
                    file(documents.asset_path(item["id"], unquote(name)))
                except (HTTPException, ValueError):
                    pass

    kind, identifier = source["kind"], source["id"]
    if kind in {"note", "project"}:
        domain = "notes" if kind == "note" else "projects"
        item = store.find(domain, int(identifier))
        add(domain, item)
        if kind == "project":
            for domain in ("notes", "papers", "tasks"):
                for child in state[domain]:
                    if child.get("project_id") == item["id"] or item["id"] in child.get("project_ids", []):
                        add(domain, child)
    else:
        domain = DOMAINS.get(source.get("collection"))
        if not domain:
            raise HTTPException(404, "This kind of item can no longer be shared.")
        if not str(identifier).isdigit():
            raise HTTPException(422, "Invalid item ID.")
        add(domain, store.find(domain, int(identifier)))
    if not entries:
        raise HTTPException(404, "This item is no longer available.")
    return {"entries": entries, "attachments": []}, targets, max(dates, default=0), attachments


def catalog():
    state = store.read()
    items = [{"kind": "project", "id": str(row["id"]), "title": row["name"], "group": "Projects"} for row in state["projects"]]
    items += [{"kind": "note", "id": str(row["id"]), "title": row["title"], "group": "Notes"} for row in state["notes"] if not row.get("trashed_at")]
    for collection, group in (("articles", "Articles"), ("tasks", "Tasks")):
        for row in state[DOMAINS[collection]]:
            if not row.get("archived_at"):
                items.append({"kind": "item", "collection": collection, "id": str(row["id"]),
                              "title": row.get("title") or row.get("name") or "Untitled", "group": group})
    return items


def scope(client, account):
    return json.dumps([client.origin, account, str(client.root)])


def bindings(client, account):
    with client.db() as db:
        return db.execute("SELECT item_id,source,content,version FROM shared_bindings WHERE scope=?", (scope(client, account),)).fetchall()


def remember(client, account, item, source):
    with client.db() as db:
        db.execute("INSERT OR REPLACE INTO shared_bindings VALUES (?,?,?,?,?)", (scope(client, account), item["id"], json.dumps(source), json.dumps(item["content"]), item["version"]))


def publish(client, source, recipient_number):
    account = client.api("GET", "/me")
    if not (account.get("storage") or {}).get("enabled"):
        raise CloudError(403, "Enable your online storage to share an item.")
    rows = bindings(client, account["id"])
    for identifier, raw, _, _ in rows:
        if json.loads(raw) == source:
            reconcile(client)
            return client.api("POST", f"/shares/{identifier}/members", {"recipient_number": recipient_number})
    content, _, _, paths = snapshot(source)
    content["attachments"] = publish_attachments(client, account["id"], paths)
    source_key = hashlib.sha256((scope(client, account["id"]) + json.dumps(source, sort_keys=True)).encode()).hexdigest()
    item = client.api("POST", "/shares", {"recipient_number": recipient_number, "source_key": source_key,
        "kind": source["kind"], "title": content["entries"][0]["title"], "content": content})
    remember(client, account["id"], item, source)
    return item


def publish_attachments(client, account, paths):
    attachments = []
    for path in sorted(paths):
        relative = path.relative_to(client.root).as_posix()
        result = client.push(relative)
        if result["status"] not in {"committed", "unchanged", "resolved"}:
            raise CloudError(409, "Finish syncing the attachment before sharing.")
        tracked, _ = client.load(client.key(account, relative))
        attachments.append({"resource_id": tracked["resource_id"], "name": path.name[:240]})
    return attachments


def apply(source, content, expected):
    # Resolve destinations from our own source selection, never from cloud paths.
    with store.batch():
        current, targets, _, _ = snapshot(source)
        if current["entries"] != expected["entries"]:
            raise CloudError(409, "The local item changed while receiving. It will be retried on the next run.")
        allowed = {entry["key"]: entry["fields"] for entry in current["entries"]}
        for entry in content["entries"]:
            if entry["key"] not in targets:
                continue
            domain, identifier = targets[entry["key"]]
            fields = {name: field["value"] for name, field in entry["fields"].items() if name in allowed[entry["key"]] and field["value"] != allowed[entry["key"]][name]["value"]}
            if not fields:
                continue
            if domain == "notes":
                from app.models.documents import NoteUpdate
                documents.update_note(identifier, NoteUpdate(**fields))
            else:
                record = store.update(domain, identifier, fields)
                if domain == "projects":
                    projects.ensure_files(record)


def versions(client):
    """Current version of every share visible to this account, in a few calls."""
    result, offset = {}, 0
    while True:
        page = client.api("GET", f"/shares?offset={offset}")
        result.update({item["id"]: item["version"] for item in page})
        if len(page) < 100:
            return result
        offset += len(page)


def reconcile(client):
    account = client.api("GET", "/me")["id"]
    errors = []
    rows = bindings(client, account)
    try:
        # One listing instead of one request per share: unchanged shares are skipped.
        remote_versions = versions(client) if rows else {}
    except CloudError:
        remote_versions = None
    for identifier, raw, old_content, version in rows:
        try:
            source = json.loads(raw)
            local, _, modified_at, _ = snapshot(source)
            previous = json.loads(old_content)
            local["attachments"] = previous.get("attachments", [])
            local_changed = local != previous
            if remote_versions is not None:
                if identifier not in remote_versions:
                    raise CloudError(404, "Share removed or access revoked.")
                if not local_changed and remote_versions[identifier] == version:
                    continue
            remote = client.api("GET", f"/shares/{identifier}")
            remote_changed = remote["version"] != version
            if local_changed and (not remote_changed or modified_at > remote["updated_at"]):
                # Attachment scope is fixed at publication: received text must
                # never cause an automatic upload of another local file.
                remote = client.api("PUT", f"/shares/{identifier}", {"expected_version": remote["version"], "content": local})
            elif remote_changed:
                apply(source, remote["content"], local)
                client.received_shares = getattr(client, 'received_shares', 0) + 1
                # Remember the locally normalized HTML; otherwise a received
                # legacy Markdown value looks like a new edit on every pass.
                normalized, _, _, _ = snapshot(source)
                normalized['attachments'] = remote['content'].get('attachments', [])
                remote = {**remote, 'content': normalized}
            remember(client, account, remote, source)
        except (CloudError, HTTPException, OSError, ValueError) as error:
            if isinstance(error, CloudError) and error.status == 404:
                with client.db() as db:
                    db.execute("DELETE FROM shared_bindings WHERE scope=? AND item_id=?", (scope(client, account), identifier))
            else:
                errors.append({"path": "Share " + identifier, "detail": str(getattr(error, "detail", error))})
    return errors
