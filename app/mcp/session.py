"""What the tools remember between calls, per agent connection.

Every agent reaches the server with a token that names its session:

- the workspace session (:data:`SESSION`): agents opened in a terminal. Its scope is the
  whole workspace, its changes apply at once, and its state follows the workspace;
- a conversation session (:class:`ConversationSession`): a chat request. Its ``run`` carries
  the view the user was in (frozen when the message was sent), the mode (answer, propose,
  auto) and the proposals, and its tool calls appear in the conversation.

A ``run`` dict is the contract the domain actions (:mod:`app.mcp.actions`) and plugin tools
expect: ``context`` (the scope), ``baseline`` (what the agent read: a change compares
against it, so an edit made in the app meanwhile is a conflict, never overwritten), ``mode``.
"""
from __future__ import annotations

import copy
import threading
import time
from contextlib import contextmanager
from urllib.parse import unquote

from app.core.kernel.config import settings
from app.core.records.repository import store
from app.mcp import actions, collections, organization

# After this long without a call, the next one starts from a fresh session: a conversation
# that comes back later rereads what it edits, and plugin counters start again.
IDLE_SECONDS = 30 * 60


def _stamp() -> tuple[int, int] | None:
    try:
        info = settings.state_path.stat()
    except OSError:
        return None
    return info.st_mtime_ns, info.st_size


def _new_run(root: str) -> dict:
    return {"id": "mcp", "engine": "agent", "workspace": root, "status": "running", "mode": "auto",
            "context": {}, "baseline": actions.baseline({}), "proposals": []}


class Session:
    """The workspace session: the whole workspace, changes applied at once."""

    # Which tools the agent sees: "all", or "read" for a conversation that has only asked questions.
    profile = "all"

    def __init__(self) -> None:
        # Reentrant: plugin tools take the lock again inside the call that already holds it.
        self.lock = threading.RLock()
        self._run: dict | None = None
        self._stamp: tuple[int, int] | None = None
        self._last = 0.0

    def current(self) -> dict:
        """The run dict for this call, in step with the workspace. Call it with the lock held."""
        root = str(settings.storage_path.resolve())
        now = time.monotonic()
        if self._run is None or self._run["workspace"] != root or now - self._last > IDLE_SECONDS:
            self._run, self._stamp = _new_run(root), _stamp()
        elif (stamp := _stamp()) != self._stamp:
            base = self._run["baseline"]
            base["state"] = copy.deepcopy(store.read())
            base["organization"] = organization.capture(self._run["context"])
            self._stamp = stamp
        self._last = now
        return self._run

    def applied(self) -> None:
        """After the agent's own change: later changes compare against the applied state."""
        actions.refresh(self._run)
        self._stamp = _stamp()

    def reset(self) -> None:
        with self.lock:
            self._run = None

    def emit(self, kind: str, label: str, detail: str = "") -> None:
        """Activity shown to the user: nothing for a terminal agent, which shows its own."""

    @contextmanager
    def workspace_change(self):
        """Hold every tool call while the workspace moves, then start from the new one."""
        with self.lock:
            self._run = None
            yield


SESSION = Session()


class ConversationSession(Session):
    """One chat conversation: its current request's run, bound again at each message."""

    def __init__(self, run: dict, emit=None) -> None:
        super().__init__()
        self._run, self._emit = run, emit

    def bind(self, run: dict) -> None:
        with self.lock:
            self._run = run

    def current(self) -> dict:
        run = self._run
        if run["status"] != "running" or run["workspace"] != str(settings.storage_path.resolve()):
            raise ValueError("This request has ended or belongs to another workspace.")
        return run

    def applied(self) -> None:
        actions.refresh(self._run)

    def emit(self, kind: str, label: str, detail: str = "") -> None:
        if self._emit:
            self._emit(self._run, kind, label, detail)


def base_ref(ref: str) -> str:
    return ref.split("#", 1)[0].removesuffix("/pdf")


def visible_refs(run: dict) -> set[str]:
    """Addresses the agent may read: the same scope as the organization snapshot.

    Cached per organization snapshot: recomputing it rescans the workspace
    (state, every collection item, the search index).
    """
    base = run["baseline"]
    organization_snapshot = base.get("organization")
    cached = base.get("_refs_cache")
    if cached is not None and cached[0] is organization_snapshot:
        return cached[1]
    refs = _compute_visible_refs(run)
    base["_refs_cache"] = (base.get("organization"), refs)
    return refs


def _compute_visible_refs(run: dict) -> set[str]:
    from app.core.search.index import ensure_fresh
    snap = collections.snapshot(run)
    excluded = set(run["context"].get("excluded_resource_ids") or [])
    refs = {f"kavot://projects/{p['id']}" for p in snap.get("projects", [])}
    refs |= {f"kavot://notes/{n['id']}" for n in snap.get("notes", []) if not n.get("trashed_at") and f"note:{n['id']}" not in excluded}
    for definition in snap["collections"]:
        if definition["id"] == "notes":
            continue
        for row in collections._rows(snap, definition):
            if definition["id"] == "articles" and f"paper:{row['id']}" in excluded:
                continue
            refs.add(f"kavot://{definition['id']}/{row['id']}")
    # The user's own files (text, data, PDFs, images), within the project when the scope has one.
    for entry in ensure_fresh().items(collection="files", project_id=run["context"].get("project_id")):
        if f"file:{unquote(entry['item_id'])}" not in excluded:
            refs.add(f"kavot://files/{entry['item_id']}")
    return refs
