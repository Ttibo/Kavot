"""Compact JSON and schemas: every tool definition and result costs the agent tokens on each turn."""
from __future__ import annotations

import copy
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, create_model

from app.core.kernel.plugins import load as load_plugins
from app.mcp import actions
from app.mcp.instructions import TOOL_HINTS


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal[tuple([*actions.SCHEMAS, "note_update", "canvas_update"])]
    label: str = Field(min_length=1, max_length=200)
    values: dict
    id: int | str | None = None
    path: str | None = None


class NotePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    old_text: str = Field(description="Exact, unique passage; empty to append at the end.")
    new_text: str


class CanvasPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    nodes: list[dict]
    edges: list[dict]


ACTION_MODELS = {**actions.SCHEMAS, "note_update": NotePatch, "canvas_update": CanvasPatch}
# Changes exposed as their own tool; every other kind goes through apply_action.
NAMED_ACTIONS = ("note_create", "note_block_update", "note_block_insert", "note_block_delete", "note_update",
                 "note_content_replace", "note_properties_update", "canvas_edit")
LEGACY_PARTIAL = {"event_update"}


def compact(value: Any) -> Any:
    """Drop empty values (None, "", [], {}) recursively; keep 0 and False."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            item = compact(item)
            if item is None or item == "" or item == [] or item == {}:
                continue
            result[key] = item
        return result
    if isinstance(value, list):
        return [compact(item) for item in value]
    return value


def dumps(value: Any) -> str:
    return json.dumps(compact(value), ensure_ascii=False, separators=(",", ":"), default=str)


def compact_schema(schema: Any, in_properties: bool = False) -> Any:
    """Smaller JSON schema with the same constraints: no titles, `type: [X, null]` for optional values."""
    if isinstance(schema, list):
        return [compact_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if in_properties:
        return {name: compact_schema(value) for name, value in schema.items()}
    result = {}
    for key, value in schema.items():
        if key == "title" and isinstance(value, str):
            continue
        if key == "default" and value is None:
            continue
        result[key] = compact_schema(value, in_properties=key in {"properties", "$defs", "definitions"})
    options = result.get("anyOf")
    if isinstance(options, list) and len(options) == 2 and {"type": "null"} in options:
        other = next(option for option in options if option != {"type": "null"})
        if isinstance(other.get("type"), str) and "$ref" not in other:
            result.pop("anyOf")
            result.update({**other, "type": [other["type"], "null"]})
    return result


def action_summary(kind: str) -> str:
    entry = load_plugins().agent_actions.get(kind, {})
    if entry.get("summary"):
        return entry["summary"]
    if kind in TOOL_HINTS:
        return TOOL_HINTS[kind]
    doc = (ACTION_MODELS[kind].__doc__ or "").strip().splitlines()
    return doc[0] if doc and not doc[0].startswith(("A base class", "Usage docs")) else kind.replace("_", " ")


def action_request_model(kind: str, model: type[BaseModel]) -> type[BaseModel]:
    """Publish each domain's actual schema, including required target identifiers."""
    optional_fields = {}
    if kind in LEGACY_PARTIAL or load_plugins().agent_actions.get(kind, {}).get("partial"):
        # prepare merges these full-input models with the captured object.
        # Keep constraints for supplied values, but let agents omit unchanged fields.
        for name, field in model.model_fields.items():
            if field.is_required():
                partial = copy.deepcopy(field)
                partial.default = None
                optional_fields[name] = (field.annotation, partial)
    values_model = create_model(kind + "_values", __base__=model,
                                __config__=ConfigDict(extra="forbid"), **optional_fields)
    fields = {
        "label": (str, Field(min_length=1, max_length=200, description="Short label of the change, shown in Kavot's history.")),
        "values": (values_model, ...),
    }
    domain, operation = kind.rsplit("_", 1)
    if kind in {"canvas_update", "canvas_edit"} or (domain == "file" and operation != "create"):
        fields["path"] = (str, Field(min_length=1))
    elif operation not in {"create", "import"}:
        fields["id"] = (int, ...)
    return create_model(kind + "_request", __config__=ConfigDict(extra="forbid"), **fields)


def request_schema(kind: str) -> dict:
    return compact_schema(action_request_model(kind, ACTION_MODELS[kind]).model_json_schema())
