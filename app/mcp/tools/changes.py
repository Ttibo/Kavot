"""Changes to the workspace, validated like the app's own edits.

By the session's mode: ``propose`` (/edit) keeps each change as a proposal the user
approves in the conversation; ``auto`` (/auto, and terminal agents, whose CLI asks the
user before each call) applies it at once; ``answer`` refuses changes. Kavot checks the
values, the target and conflicts with edits made in the app since the agent read the item.
"""
from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import HTTPException
from pydantic import Field

from app.mcp import actions
from app.mcp.schemas import ACTION_MODELS, NAMED_ACTIONS, Action, action_request_model, action_summary, request_schema


def _check_target(action: dict, run: dict) -> None:
    kind = action["kind"]
    if kind in actions.organization.SCHEMAS or kind in actions.SCRIPT_KINDS:
        return  # prepare validates against the organization snapshot / script library.
    if kind.endswith("_update") and kind not in actions.NOTE_KINDS | {"canvas_update"}:
        collection = actions.COLLECTIONS[kind.split("_")[0]]
        if not any(str(item["id"]) == str(action.get("id")) for item in run["baseline"]["organization"].get(collection, [])):
            raise ValueError("Unknown item; check its id with search or list_records.")


def _with_schema(kind: str, error: Exception) -> str:
    """An invalid change answers with the expected request, so the next attempt can be right."""
    hint = f" Expected request: {json.dumps(request_schema(kind), separators=(',', ':'))}" if kind in ACTION_MODELS else ""
    return str(error) + hint


# Changes one request may make: a runaway agent stops instead of rewriting the workspace.
LIMITS = {"propose": 30, "auto": 200}


def install(ctx) -> None:
    from app.core import journal
    from app.core.storage.cloud_sync.routes import notify_local_change

    def apply(action: Action) -> dict[str, Any]:
        run = ctx.run
        mode = run.get("mode", "auto")
        if mode not in LIMITS:
            raise ValueError("This request only answers (/answer): describe the change, or ask the user to switch to /edit.")
        candidate = action.model_dump(exclude_none=True)
        _check_target(candidate, run)
        proposal = actions.prepare(candidate, run)
        made = run.setdefault("proposals", [])
        for existing in made:
            if existing["action"] == proposal["action"]:
                return {"status": existing["status"], "label": existing["label"], **({"result": existing["result"]} if "result" in existing else {})}
        if run["id"] != "mcp" and len(made) >= LIMITS[mode]:
            raise ValueError(f"At most {LIMITS[mode]} changes per request.")
        if mode == "propose":
            made.append(proposal)
            ctx.session.emit("proposal", "Proposed change", proposal["label"] + " — " + proposal["target"])
            return {"status": "pending", "label": proposal["label"], "message": "Shown to the user for approval: not applied yet."}
        with journal.author("agent", run=run["id"], engine=run.get("engine")):
            result = actions.apply(proposal)
        proposal.update(status="applied", result=result)
        if run["id"] != "mcp":  # A conversation lists its changes; the workspace session keeps none.
            made.append(proposal)
        ctx.session.applied()
        ctx.session.emit("write", "Change applied", proposal["label"] + " — " + proposal["target"])
        notify_local_change()  # Open windows reload what changed.
        return {"status": "applied", "label": proposal["label"], "target": proposal["target"], "result": result,
                "message": "Saved: this is the confirmation, do not read it back."}

    @ctx.tool(annotations=ctx.read_only)
    def list_actions() -> dict[str, Any]:
        """Every change kind with a one-line summary; kinds with their own tool are marked."""
        return {"actions": {kind: ("[tool] " if kind in NAMED_ACTIONS else "") + action_summary(kind) for kind in ACTION_MODELS},
                "how": "Kinds marked [tool]: call that tool. Others: get_action_schema(kind), then apply_action."}

    @ctx.tool(annotations=ctx.read_only)
    def get_action_schema(kind: str) -> dict[str, Any]:
        """The request schema (values, id, path) of one change kind, for apply_action."""
        if kind not in ACTION_MODELS:
            raise ValueError("Unknown change kind. Use list_actions.")
        return {"kind": kind, "request_schema": request_schema(kind),
                "rules": "In /edit a change is a proposal the user approves; in /auto it is applied at once. "
                         "Use IDs from search, get_organization or list_records. Keep fields not mentioned in the request."}

    @ctx.tool(annotations=ctx.annotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False))
    def apply_action(action: Action) -> dict[str, Any]:
        """Make any change kind (see list_actions) with the request fields from get_action_schema."""
        try:
            return apply(action)
        except ValueError as error:
            raise ValueError(_with_schema(action.kind, error)) from None

    @ctx.tool(annotations=ctx.annotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False))
    def apply_actions(actions: Annotated[list[Action], Field(min_length=1, max_length=50)]) -> dict[str, Any]:
        """Make several changes in one call (same fields as apply_action): import, delete or file many items.
        Results follow the order of the actions; an invalid one does not stop the others."""
        results = []
        for index, action in enumerate(actions):
            try:
                outcome = apply(action)
                # Only what identifies each saved object: a batch result stays small in the conversation.
                saved = outcome.get("result")
                if isinstance(saved, dict):
                    outcome["result"] = {key: saved[key] for key in ("id", "kind", "title", "name") if key in saved}
                results.append({"index": index, **outcome})
            except (ValueError, HTTPException, FileNotFoundError) as error:
                results.append({"index": index, "status": "invalid", "error": _with_schema(action.kind, getattr(error, "detail", error))})
        return {"results": results, "count": len(results), "failed": sum(1 for item in results if item["status"] == "invalid")}

    def register(kind: str) -> None:
        def named(request):
            return apply(Action(kind=kind, **request.model_dump(exclude_unset=True)))

        named.__name__ = kind
        named.__doc__ = action_summary(kind)
        if "folder" in kind and not kind.endswith("_delete"):
            named.__doc__ += " parent_id selects the parent folder; null places it at the root."
        # Concrete annotations let both SDK versions expose the nested JSON schema.
        named.__annotations__ = {"request": action_request_model(kind, ACTION_MODELS[kind]), "return": dict[str, Any]}
        ctx.tool(annotations=ctx.annotations(readOnlyHint=False, destructiveHint=kind.endswith("_delete"),
                                             idempotentHint=False, openWorldHint=False))(named)

    for kind in NAMED_ACTIONS:
        if kind in ACTION_MODELS:
            register(kind)
