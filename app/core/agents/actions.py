"""Reviewable domain changes. A CLI response can propose, never approve, an action."""
from __future__ import annotations

import copy
import difflib
import json
import re
import uuid
from datetime import date

from fastapi import HTTPException
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from app.models.documents import NoteCreate, NoteUpdate, DatabaseRecordCreate, DatabaseRecordUpdate, NoteScriptCreate, NoteScriptUpdate
from app.models.projects import ProjectCreate
from app.core.workspace import documents
from app.core.projects import canvas_store as canvas_tasks
from app.core.records import databases
from app.core.kernel.plugins import load as load_plugins
from app.core.projects import projects
from app.core.agents import organization
from app.core.agents.resources import workspace_file
from app.core.records.repository import store, json_values
from app.core.kernel.files import read_json_object
from app.core.workspace import html_documents
from app.core.projects import canvas as agent_canvas
from app.core.workspace import local_files
from app.core.projects.canvas import CanvasEdit, NoteCanvasPlacement

class NoteDraft(BaseModel):
    properties: dict = Field(default_factory=dict)
    presentation: dict = Field(default_factory=dict)
    title: str = Field(min_length=1, max_length=240)
    content: str = ""
    project_id: int | None = None
    folder_id: int | None = None
    canvas: NoteCanvasPlacement | None = Field(default=None, description="Place the new note on its project canvas and link it.")


class NoteBlockChange(BaseModel):
    block_id: str = Field(min_length=1)
    html: str


class NotePropertiesChange(BaseModel):
    properties: dict = Field(default_factory=dict)
    presentation: dict = Field(default_factory=dict)


class NoteContentReplace(BaseModel):
    content: str = Field(max_length=2_000_000, description="Complete new body, as HTML (or Markdown).")


class NoteBlockInsert(BaseModel):
    html: str = Field(min_length=1, max_length=500_000)
    after_block_id: str | None = Field(default=None, description="Insert after this block; null appends at the end.")


class NoteBlockDelete(BaseModel):
    block_ids: list[str] = Field(min_length=1, max_length=200)


class NoteScriptSet(BaseModel):
    """A sandboxed HTML/CSS/JS block in a note; code is given raw, never HTML-escaped."""
    name: str = Field(default="Script", min_length=1, max_length=120)
    html: str = Field(default="", max_length=100_000)
    css: str = Field(default="", max_length=100_000)
    js: str = Field(default="", max_length=200_000)
    height: Literal["auto", "160", "240", "320", "480", "640"] = "auto"
    block_id: str | None = Field(default=None, description="Replace this script block; omit to insert a new one.")
    after_block_id: str | None = Field(default=None, description="Insert after this block; null appends at the end.")
    library_script_id: int | None = Field(default=None, description="Start from this library script; given fields override it.")


SCHEMAS = {
    'note_block_update': NoteBlockChange,
    'note_properties_update': NotePropertiesChange,
    'note_content_replace': NoteContentReplace,
    'note_block_insert': NoteBlockInsert,
    'note_block_delete': NoteBlockDelete,
    'note_script_set': NoteScriptSet,
    'canvas_edit': CanvasEdit,
    "script_create": NoteScriptCreate, "script_update": NoteScriptUpdate, "script_delete": organization.Empty,
    **organization.SCHEMAS,
    "project_create": ProjectCreate,
    "note_create": NoteDraft,
    "record_create": DatabaseRecordCreate, "record_update": DatabaseRecordUpdate,
    # Domain actions declared by plugins (tasks, events, conferences, articles…).
    **{kind: entry["model"] for kind, entry in load_plugins().agent_actions.items()},
}
NOTE_KINDS = {"note_update", "note_block_update", "note_properties_update",
              "note_content_replace", "note_block_insert", "note_block_delete", "note_script_set"}
SCRIPT_KINDS = {"script_create", "script_update", "script_delete"}
COLLECTIONS = {"project": "projects", "note": "notes",
               **{kind.split("_")[0]: entry["state_key"] for kind, entry in load_plugins().agent_actions.items()}}



def _note_snapshot(relative: str) -> dict:
    path = workspace_file(relative)
    raw = path.read_text(encoding='utf-8')
    return {"path": relative, "text": html_documents.read(raw, path) if path.suffix == '.html' else raw,
            'hash': html_documents.fingerprint(path), 'metadata': html_documents.metadata(raw)}


def load_note(run: dict, note_id: int) -> dict:
    """Capture a note the agent read explicitly; it becomes an editable target."""
    from app.core.kernel.config import settings
    if f"note:{note_id}" in set(run["context"].get("excluded_resource_ids") or []):
        raise ValueError("This note is excluded from the request.")
    visible = run["baseline"].get("organization", {}).get("notes", [])
    if not any(str(n["id"]) == str(note_id) for n in visible):
        run["baseline"]["organization"] = organization.capture(run["context"])
        visible = run["baseline"]["organization"]["notes"]
    note = next((n for n in visible if str(n["id"]) == str(note_id)), None)
    if note is None or note.get("trashed_at"):
        raise ValueError("Note outside this request's scope. Use list_notes for valid IDs.")
    relative = documents.note_path(note, store.read()).relative_to(settings.storage_path).as_posix()
    snapshot = {**_note_snapshot(relative), "explicit": True, "title": note.get("title")}
    run["baseline"]["notes"][str(note_id)] = snapshot
    return snapshot


def refresh(run: dict) -> None:
    """After an automatic change, later edits compare against the applied state."""
    base = run["baseline"]
    base["state"] = copy.deepcopy(store.read())
    base["organization"] = organization.capture(run["context"])
    for key, note in list(base["notes"].items()):
        try:
            base["notes"][key] = {**note, **_note_snapshot(note["path"])}
        except (OSError, ValueError, HTTPException):
            base["notes"].pop(key)
    for path in list(base["canvases"]):
        base["canvases"][path] = read_json_object(workspace_file(path))


def baseline(context: dict) -> dict:
    state = store.read()
    result = {"state": copy.deepcopy(state), "notes": {}, "canvases": {}, "records": {}}
    for source in context.get("sources", []):
        if source.get("note_id"):
            result["notes"][str(source["note_id"])] = _note_snapshot(source["path"])
    if context.get("canvas_path"):
        path = context["canvas_path"]
        result["canvases"][path] = read_json_object(workspace_file(path))
    if context.get("collection_id"):
        result["records"][context["collection_id"]] = copy.deepcopy(context.get("records", {}).get("collection", []))
    result["organization"] = organization.capture(context)
    return result


def _validate(model, values):
    if set(values) - set(model.model_fields):
        raise ValueError("The proposal contains unknown fields.")
    return model.model_validate(values)


def _existing(action: dict, state: dict):
    collection = COLLECTIONS.get(action["kind"].split("_")[0])
    return next((item for item in state.get(collection, []) if str(item["id"]) == str(action.get("id"))), None)


def _record_values(database_id: str, values: dict):
    definition = databases.load(database_id)
    if definition.get("storage", {}).get("driver") != "json-files":
        raise ValueError("Use the domain action for this built-in collection.")
    fields = {f["id"]: f for f in definition.get("fields", [])}
    if set(values) - set(fields) - {"title", "content", "project_ids"}:
        raise ValueError("Field missing from the collection schema.")
    for key, field in fields.items():
        value = values.get(key)
        if field.get("required") and (value is None or value == ""):
            raise ValueError(f"Champ requis : {key}")
        if value is None:
            continue
        kind = field.get("type", "text")
        valid = (isinstance(value, bool) if kind == "boolean" else
                 isinstance(value, (int, float)) and not isinstance(value, bool) if kind == "number" else
                 isinstance(value, list) if kind in {"tags", "relation"} else
                 True if kind == "json" else isinstance(value, str))
        if not valid:
            raise ValueError(f"Type de champ invalide : {key}")


def prepare(action: dict, run: dict) -> dict:
    action = copy.deepcopy(action)
    kind, values = action.get("kind"), action.get("values", {})
    if not isinstance(values, dict):
        raise ValueError("The proposed values must be an object.")
    base = run["baseline"]
    before, after, target = None, None, ""
    if kind in organization.SCHEMAS:
        if kind in {"note_folder_create", "file_create"} and run.get("context", {}).get("project_id"):
            values.setdefault("project_id", run["context"]["project_id"])
        values = json_values(_validate(SCHEMAS[kind], values), exclude_unset=not kind.endswith("_create"))
        for field in ("name", "title"):
            if field in values and (not isinstance(values[field], str) or not values[field].strip()):
                raise ValueError("The name or title cannot be empty.")
        action["values"] = values
        before, after, target = organization.describe(action, base["organization"], run["context"])
        organization.check_impact(action, before, run["context"])
    elif kind in NOTE_KINDS:
        note = base["notes"].get(str(action.get("id")))
        if not note or note["path"].endswith("/relations.generated.html"):
            raise ValueError("The proposed note is not an editable source of this request. Read it with read_note first.")
        # Notes read through read_note were chosen deliberately by the agent;
        # the selected sources still follow the request's target note.
        if not note.get("explicit"):
            if run.get("context", {}).get("note_intent") == "create":
                raise ValueError("This request is for a new note, not for replacing an existing note.")
            target_note = run.get("context", {}).get("target_note")
            multiple = run.get("context", {}).get("allow_multiple_notes", False)
            if not target_note and not multiple:
                raise ValueError("Choose a target note or name it in the request before proposing a change.")
            if not multiple and str(target_note["note_id"]) != str(action.get("id")):
                raise ValueError("The proposal does not match the target note. Send a request for this note.")
        before = note["text"]
        if kind == 'note_update':
            if set(values) != {"old_text", "new_text"} or not all(isinstance(v, str) for v in values.values()):
                raise ValueError("A note change must specify old_text and new_text.")
            old, new = values["old_text"], values["new_text"]
            if old and before.count(old) != 1:
                raise ValueError("The passage to change must appear exactly once in the note.")
            after = before.replace(old, new, 1) if old else before + (html_documents.fragment(new) if note['path'].endswith('.html') else new)
        elif kind == 'note_content_replace':
            values = json_values(_validate(NoteContentReplace, values))
            after = html_documents.fragment(values['content']) if note['path'].endswith('.html') else values['content']
        elif kind == 'note_block_insert':
            from bs4 import BeautifulSoup
            values = json_values(_validate(NoteBlockInsert, values))
            addition = html_documents.fragment(values['html'])
            if values.get('after_block_id') is None:
                after = before + addition
            else:
                soup = BeautifulSoup(before, 'html.parser')
                block = soup.find(id=values['after_block_id'])
                if block is None:
                    raise ValueError('Block missing from the selected document.')
                block.insert_after(BeautifulSoup(addition, 'html.parser'))
                after = str(soup)
        elif kind == 'note_block_delete':
            from bs4 import BeautifulSoup
            values = json_values(_validate(NoteBlockDelete, values))
            soup = BeautifulSoup(before, 'html.parser')
            for block_id in values['block_ids']:
                block = soup.find(id=block_id)
                if block is None:
                    raise ValueError(f'Block {block_id} missing from the selected document.')
                block.decompose()
            after = str(soup)
        elif kind == 'note_script_set':
            from bs4 import BeautifulSoup
            from app.core.workspace.note_format import script_block
            values = json_values(_validate(NoteScriptSet, values), exclude_unset=True)
            source = {"name": "Script", "html": "", "css": "", "js": ""}
            if values.get("library_script_id") is not None:
                script = next((s for s in base["state"].get("note_scripts", []) if s["id"] == values["library_script_id"]), None)
                if script is None:
                    raise ValueError("Library script not found. Use list_scripts.")
                source.update({key: script.get(key) or "" for key in source})
            source.update({key: values[key] for key in source if key in values})
            if not any(source[key].strip() for key in ("html", "css", "js")):
                raise ValueError("A script block needs HTML, CSS or JavaScript.")
            soup = BeautifulSoup(before, 'html.parser')
            block_id = values.get("block_id")
            markup = script_block(source["name"], source["html"], source["css"], source["js"], values.get("height", "auto"), block_id)
            replacement = BeautifulSoup(html_documents.fragment(markup), 'html.parser')
            if block_id:
                block = soup.find(id=block_id)
                if block is None or block.get('data-type') != 'script-block':
                    raise ValueError('Script block missing from the note. Read the note again for its id.')
                block.replace_with(replacement)
            elif values.get('after_block_id'):
                block = soup.find(id=values['after_block_id'])
                if block is None:
                    raise ValueError('Block missing from the selected document.')
                block.insert_after(replacement)
            else:
                soup.append(replacement)
            after = str(soup)
        elif kind == 'note_block_update':
            from bs4 import BeautifulSoup
            values = json_values(_validate(NoteBlockChange, values))
            soup = BeautifulSoup(before, 'html.parser')
            block = soup.find(id=values['block_id'])
            if block is None:
                raise ValueError('Block missing from the selected document.')
            replacement = BeautifulSoup(html_documents.fragment(values['html']), 'html.parser')
            first = replacement.find(True)
            if first:
                first['id'] = values['block_id']
            block.replace_with(replacement)
            after = str(soup)
        else:
            values = json_values(_validate(NotePropertiesChange, values))
            before = {key: note.get('metadata', {}).get(key, {}) for key in ('properties', 'presentation')}
            after = {key: {**before[key], **values[key]} for key in before}
        target = note["path"]
        action['expected_hash'] = note.get('hash')
    elif kind == "canvas_edit":
        target = str(action.get("path", ""))
        values = json_values(_validate(CanvasEdit, values))
        before = base["canvases"].get(target)
        if before is None:
            try:
                before = agent_canvas.read(target)
            except (ValueError, OSError):
                raise ValueError("Canvas not found. Use get_canvas for the project canvas path.") from None
            project_id = before.get("projectId")
            if not any(p["id"] == project_id for p in base.get("organization", {}).get("projects", [])) or                     target != agent_canvas.project_canvas(project_id):
                raise ValueError("Only project canvases within this request's scope can be edited.")
            base["canvases"][target] = before
        notes = [n for n in base["state"].get("notes", []) if n.get("project_id") == before.get("projectId")]
        tasks = [t for t in base["state"].get("tasks", []) if t.get("project_id") == before.get("projectId")]
        action["values"] = values
        after = agent_canvas.edit(before, values, notes, tasks)
    elif kind == "canvas_update":
        target = str(action.get("path", ""))
        before = base["canvases"].get(target)
        if before is None or set(values) != {"nodes", "edges"}:
            raise ValueError("Canvas missing from the context or invalid structure.")
        nodes, edges = values["nodes"], values["edges"]
        if not isinstance(nodes, list) or not isinstance(edges, list) or not all(isinstance(n, dict) for n in nodes + edges):
            raise ValueError("Invalid cards and relations.")
        ids = [node.get("id") for node in nodes]
        edge_ids = [edge.get("id") for edge in edges]
        if any(not isinstance(i, str) or not i for i in ids + edge_ids) or len(set(ids)) != len(ids) or len(set(edge_ids)) != len(edge_ids):
            raise ValueError("Card and relation IDs are not unique.")
        if any(e.get("fromNode") not in ids or e.get("toNode") not in ids for e in edges):
            raise ValueError("A relation points to a missing card.")
        after = {**before, **values}
    elif kind in SCRIPT_KINDS:
        values = json_values(_validate(SCHEMAS[kind], values), exclude_unset=kind != "script_create")
        library = base["state"].get("note_scripts", [])
        if kind == "script_create":
            if any(str(s.get("name", "")).casefold() == values["name"].strip().casefold() for s in library):
                raise ValueError("A library script already has this name; use script_update.")
        else:
            before = next((s for s in library if str(s["id"]) == str(action.get("id"))), None)
            if before is None:
                raise ValueError("Library script not found. Use list_scripts.")
            if any(value is None for value in values.values()):
                raise ValueError("Script properties cannot be null.")
        action["values"] = values
        after = None if kind == "script_delete" else {**(before or {}), **values}
        target = "Script library · " + str((before or values).get("name"))
    elif kind in SCHEMAS:
        model = SCHEMAS[kind]
        if kind == "project_create":
            if not isinstance(values.get("name"), str) or not values["name"].strip():
                raise ValueError("The new project must have a name.")
            values["name"] = values["name"].strip()
        project_id = run.get("context", {}).get("project_id")
        if kind in {"note_create", "task_create", "event_create"} and project_id:
            values.setdefault("project_id", project_id)
        if kind == "note_create":
            if not str(values.get("title", "")).strip():
                raise ValueError("The new note must have a title.")
            _note_destination(values, base["state"])
            if values.get("canvas"):
                if not values.get("project_id"):
                    raise ValueError("Only a note in a project can be placed on a canvas; set project_id.")
                canvas = agent_canvas.read(agent_canvas.project_canvas(values["project_id"]))
                for reference in (values["canvas"].get("connect_to") or []):
                    agent_canvas._resolve(canvas["nodes"], reference)
        if kind in {"dataset_create", "conference_create", "paper_import"} and project_id:
            values.setdefault("project_ids", [project_id])
        if kind == "task_create":
            values.setdefault("start_date", date.today().isoformat())
            if values.get("canvas"):
                if not values.get("project_id"):
                    raise ValueError("Only a task in a project can be placed on a canvas; set project_id.")
                canvas = agent_canvas.read(agent_canvas.project_canvas(values["project_id"]))
                for reference in (values["canvas"].get("connect_to") or []):
                    agent_canvas._resolve(canvas["nodes"], reference)
        if kind.endswith("_update"):
            if kind == "record_update":
                identifier = str(action.get("id", ""))
                if not re.fullmatch(r"[\w-]+", identifier):
                    raise ValueError("Invalid record ID.")
                before = next((r for r in base.get("organization", {}).get("collection_records", {}).get(action.get("database_id"), base["records"].get(action.get("database_id"), [])) if r["id"] == identifier), None)
            else:
                before = _existing(action, base.get("organization", base["state"]))
            if before is None:
                raise ValueError("Objet cible absent du contexte initial.")
        # Full-input services need merged values to preserve all unspecified fields.
        if before and kind in {"event_update", "dataset_update", "conference_update"}:
            values = {**{k: v for k, v in before.items() if k in model.model_fields}, **values}
        validated = _validate(model, values)
        values = json_values(validated, exclude_unset=kind.endswith("_update"))
        if kind.startswith("record_"):
            current_values = (before or {}).get("values", {})
            values["values"] = {**current_values, **values.get("values", {})}
            _record_values(str(action.get("database_id", "")), values["values"])
        action["values"] = values
        after = {**(before or {}), **values}
        target = str((before or {}).get("title") or (before or {}).get("name") or values.get("title") or values.get("name") or action.get("database_id", kind))
    else:
        raise ValueError("Type de proposition inconnu.")
    if before == after:
        raise ValueError("This proposal changes nothing.")
    def printable(value):
        return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) if value is not None else ""
    diff = "\n".join(difflib.unified_diff(printable(before).splitlines(), printable(after).splitlines(), fromfile=target + " (avant)", tofile=target + " (after)", lineterm=""))
    if kind in organization.SCHEMAS:
        affected = organization.guard(action, before)
        if affected["files"]:
            diff += "\n\nAffected files:\n" + "\n".join(affected["files"])
        if kind.endswith("_delete"):
            diff += "\n\n" + organization.deletion_effect(kind)
    return {"proposal_id": uuid.uuid4().hex, "label": str(action.get("label") or kind)[:200], "kind": kind,
            "target": target, "before": before, "after": after, "diff": diff, "action": action, "status": "pending",
            **({"organization_context": organization.scope(run["context"]),
                "organization_guard": affected} if kind in organization.SCHEMAS else {})}


def parse(answer: str, run: dict) -> tuple[str, list[dict], list[str]]:
    proposals, errors = [], []
    pattern = r"```kavot-actions\s*\n([\s\S]*?)```"
    for match in re.finditer(pattern, answer):
        try:
            actions = json.loads(match[1])["actions"]
            if not isinstance(actions, list) or len(actions) + len(proposals) > 30:
                raise ValueError("At most 30 proposals per answer.")
            for action in actions:
                try:
                    proposals.append(prepare(action, run))
                except (ValueError, TypeError, KeyError, ValidationError, HTTPException, FileNotFoundError) as error:
                    errors.append(str(getattr(error, "detail", error)))
        except (ValueError, TypeError, KeyError) as error:
            errors.append(f"Proposition illisible : {error}")
    return re.sub(pattern, "", answer).strip(), proposals, errors


def _check_duplicates(action: dict, current: list[dict]):
    values = action["values"]
    def normalized(value):
        return str(value or "").strip().casefold()
    for item in current:
        if action["kind"] == "note_create" and item.get("trashed_at"):
            continue
        if action["kind"] == "record_create":
            expected = values.get("values", {})
            if action["database_id"] not in {definition["id"] for definition in databases.builtins()}:
                # Custom collections add their content template on creation.
                # Compare with that persisted shape, including the empty default.
                expected = {"content": databases.load(action["database_id"]).get("content_template", ""), **expected}
            duplicate = item.get("values") == expected
        elif action["kind"] == "paper_import":
            duplicate = (values.get("doi") and normalized(values["doi"]) == normalized(item.get("doi"))) or normalized(values.get("title")) == normalized(item.get("title"))
        else:
            duplicate = normalized(values.get("title") or values.get("name")) == normalized(item.get("title") or item.get("name"))
            if action["kind"] == "event_create":
                duplicate = duplicate and values.get("starts_at") == item.get("starts_at")
            if action["kind"] == "task_create":
                duplicate = duplicate and values.get("project_id") == item.get("project_id")
            if action["kind"] == "note_create":
                duplicate = duplicate and values.get("project_id") == item.get("project_id") and values.get("folder_id") == item.get("folder_id")
        if duplicate:
            raise HTTPException(409, "An equivalent object already exists. The proposal was not applied.")


def _note_destination(values: dict, state: dict):
    project_id, folder_id = values.get("project_id"), values.get("folder_id")
    if project_id is not None and not any(p["id"] == project_id for p in state.get("projects", [])):
        raise ValueError("The note’s destination project no longer exists.")
    if folder_id is not None and not any(f["id"] == folder_id and f.get("project_id") == project_id for f in state.get("note_folders", [])):
        raise ValueError("The note’s destination folder no longer exists in this project.")


def apply(proposal: dict) -> dict:
    if proposal["status"] == "applied":
        return proposal.get("result", {})
    if proposal["status"] != "pending":
        raise HTTPException(409, "This proposal is no longer pending.")
    if proposal["action"]["kind"] in local_files.KINDS:
        return local_files.apply(proposal)
    action, before, after = proposal["action"], proposal["before"], proposal["after"]
    kind, values = action["kind"], action["values"]
    with store._lock:
        state = store.read()
        if kind in organization.SCHEMAS:
            try:
                context = proposal["organization_context"]
                current, _, _ = organization.describe(action, organization.capture(context), context)
                organization.check_impact(action, current, context)
                if current != before or organization.guard(action, current) != proposal["organization_guard"]:
                    raise ValueError("The affected items changed. Ask for a new proposal.")
            except (ValueError, FileNotFoundError) as error:
                raise HTTPException(409, str(error)) from None
            return organization.execute(action)
        if kind in SCRIPT_KINDS:
            from app.api.routes import scripts
            if kind != "script_create":
                current = next((s for s in state.get("note_scripts", []) if s["id"] == int(action["id"])), None)
                if current != before:
                    raise HTTPException(409, "The script changed since the request. Ask for a new proposal.")
            if kind == "script_delete":
                scripts.delete_script(int(action["id"]))
                return {"id": int(action["id"]), "kind": kind}
            payload = SCHEMAS[kind].model_validate(values)
            result = scripts.create_script(payload) if kind == "script_create" else scripts.update_script(int(action["id"]), payload)
            return {"id": result["id"], "kind": kind}
        if kind in NOTE_KINDS:
            note = store.find("notes", int(action["id"]))
            path = documents.note_path(note, state)
            current = html_documents.read(path.read_text(encoding='utf-8'), path) if path.suffix == '.html' else path.read_text(encoding='utf-8')
            if kind == 'note_properties_update':
                meta = html_documents.metadata(path.read_text(encoding='utf-8'))
                current = {key: meta.get(key, {}) for key in ('properties', 'presentation')}
            if note.get("trashed_at") or path.resolve() != workspace_file(proposal["target"]) or current != before or (action.get('expected_hash') and html_documents.fingerprint(path) != action['expected_hash']):
                raise HTTPException(409, "The note changed since the request. Ask for a new proposal.")
            patch = after if kind == 'note_properties_update' else {'content': after}
            result = documents.update_note(note["id"], NoteUpdate(**patch, expected_hash=action.get('expected_hash')))
            return {"id": result["id"], "kind": kind, "path": proposal["target"]}
        if kind in {"canvas_update", "canvas_edit"}:
            path = workspace_file(action["path"])
            if read_json_object(path) != before:
                raise HTTPException(409, "The canvas changed since the request.")
            canvas_tasks.save(path, after)
            return {"path": action["path"]}
        if kind.startswith("record_"):
            database_id = action["database_id"]
            current = databases.records(database_id)
            _record_values(database_id, values["values"])
            existing = next((r for r in current if r["id"] == action.get("id")), None)
        else:
            current = state.get(COLLECTIONS[kind.split("_")[0]], [])
            existing = _existing(action, state)
        if kind.endswith("_update") and existing != before:
            raise HTTPException(409, "The record changed since the request. Ask for a new proposal.")
        if not kind.endswith("_update"):
            _check_duplicates(action, current)
        payload = _validate(SCHEMAS[kind], values)
        identifier = action.get("id") if kind.endswith("_update") else None
        if kind == "note_create":
            try:
                _note_destination(values, state)
            except ValueError as error:
                raise HTTPException(409, str(error)) from None
            placement = values.get("canvas")
            result = documents.create_note(NoteCreate(**{k: v for k, v in values.items() if k != "canvas"}))
            from app.core.kernel.config import settings
            created = {"id": result["id"], "kind": kind, "path": documents.note_path(result, store.read()).relative_to(settings.storage_path).as_posix()}
            if placement:
                try:
                    created["canvas"] = agent_canvas.place_new_note(result, placement)
                except (ValueError, HTTPException) as error:
                    # The note exists; report why it could not be placed instead of losing it.
                    created["canvas_error"] = str(getattr(error, "detail", error))
            return created
        elif kind == "project_create":
            result = projects.create(payload)
        elif kind.startswith("record_"):
            result = databases.save_record(action["database_id"], values, identifier)
        else:
            return {**load_plugins().agent_actions[kind]["apply"](payload, identifier, values), "kind": kind}
        return {"id": result["id"], "kind": kind}
