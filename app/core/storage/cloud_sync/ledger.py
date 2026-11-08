"""What this device remembers between sync passes, in one SQLite file.

* ``tracked``: per file, the cloud resource and version both sides last agreed on,
  plus the durable copy of a pending upload;
* ``hashes``: the last scan's hashes, so a launch does not read every file again;
* ``sync_passes`` / ``sync_events``: the activity history shown in Settings;
* ``shared_bindings``: the items this device published or receives as shares.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import time
import uuid
from contextlib import contextmanager

from app.core.storage.cloud_sync.files import FileData, reader

# Sync activity kept per device for Settings: passes that did something, file events.
ACTIVITY_PASSES = 50
ACTIVITY_EVENTS = 200
ACTIVITY_COUNTS = ("uploaded", "downloaded", "deleted_local", "deleted_remote")

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracked (key TEXT PRIMARY KEY, state TEXT NOT NULL, snapshot BLOB);
CREATE TABLE IF NOT EXISTS hashes (root TEXT NOT NULL, path TEXT NOT NULL, size INTEGER,
  mtime INTEGER, ctime INTEGER, sha TEXT, PRIMARY KEY (root, path));
CREATE TABLE IF NOT EXISTS sync_passes (id INTEGER PRIMARY KEY, scope TEXT NOT NULL,
  started_at REAL NOT NULL, finished_at REAL NOT NULL, duration_ms INTEGER,
  signature TEXT, repeats INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_events (id INTEGER PRIMARY KEY, scope TEXT NOT NULL,
  at REAL NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS shared_bindings (scope TEXT, item_id TEXT, source TEXT, content TEXT, version INTEGER,
  PRIMARY KEY(scope, item_id));
"""


class SyncLedger:
    """Mixin of :class:`LocalSync` for its local SQLite state (``self.state_path``)."""

    _schema_path = None

    @contextmanager
    def db(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        # The schema and WAL mode persist in the file: set them up once per file.
        fresh = self._schema_path != self.state_path or not self.state_path.exists()
        connection = sqlite3.connect(self.state_path, timeout=30)
        try:
            if fresh:
                os.chmod(self.state_path, 0o600)
                connection.execute("PRAGMA journal_mode=WAL")
                connection.executescript(SCHEMA)
                self._schema_path = self.state_path
            with connection:
                yield connection
        finally:
            connection.close()

    # -- tracked files ------------------------------------------------------
    def key(self, account, relative):
        return json.dumps([self.origin, account, str(self.root), self.path(relative).relative_to(self.root).as_posix()])

    def load(self, key):
        with self.db() as db:
            row = db.execute("SELECT state,snapshot FROM tracked WHERE key=?", (key,)).fetchone()
        if not row:
            return {"resource_id": str(uuid.uuid4()), "version": 0}, None
        state = json.loads(row[0])
        snapshot = FileData(self.state_path.parent / state["snapshot_file"]) if state.get("snapshot_file") else row[1]
        return state, snapshot

    def save(self, key, state, snapshot=None):
        if isinstance(snapshot, FileData):
            if not state.get("snapshot_file"):
                folder = self.state_path.parent / "cloud-sync-pending"
                folder.mkdir(parents=True, exist_ok=True)
                destination = folder / uuid.uuid4().hex
                with reader(snapshot) as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                state["snapshot_file"] = str(destination.relative_to(self.state_path.parent))
            snapshot = None
        with self.db() as db:
            previous = db.execute("SELECT state FROM tracked WHERE key=?", (key,)).fetchone()
            db.execute("INSERT INTO tracked VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,snapshot=excluded.snapshot",
                       (key, json.dumps(state), snapshot))
        old = json.loads(previous[0]).get("snapshot_file") if previous else None
        if old and old != state.get("snapshot_file"):
            (self.state_path.parent / old).unlink(missing_ok=True)

    def forget(self, key):
        with self.db() as db:
            db.execute("DELETE FROM tracked WHERE key=?", (key,))

    def tracked(self, account):
        """Return synchronization states belonging to this account/workspace."""
        result = {}
        # Keys are JSON arrays starting with [origin, account, root]: read only
        # this workspace's rows instead of decoding every account's.
        prefix = json.dumps([self.origin, account, str(self.root)])[:-1] + ", "
        with self.db() as db:
            rows = db.execute("SELECT key,state FROM tracked WHERE substr(key, 1, ?) = ?",
                              (len(prefix), prefix)).fetchall()
        for key, raw_state in rows:
            try:
                origin, owner, root, relative = json.loads(key)
            except (TypeError, ValueError):
                continue
            if origin == self.origin and owner == account and root == str(self.root):
                result[relative] = (key, json.loads(raw_state), None)
        return result

    # -- scan hashes --------------------------------------------------------
    def load_hashes(self):
        """Hashes of the last scan, so a launch does not read every file again."""
        try:
            with self.db() as db:
                rows = db.execute("SELECT path,size,mtime,ctime,sha FROM hashes WHERE root=?", (str(self.root),)).fetchall()
        except sqlite3.Error:
            return {}
        return {path: ((size, mtime, ctime), digest) for path, size, mtime, ctime, digest in rows}

    def store_hashes(self, previous):
        changed = [(path, value) for path, value in self._hash_cache.items() if previous.get(path) != value]
        removed = [path for path in previous if path not in self._hash_cache]
        if not changed and not removed:
            return
        try:
            with self.db() as db:
                db.executemany("INSERT OR REPLACE INTO hashes VALUES (?,?,?,?,?,?)",
                               [(str(self.root), path, *signature, digest) for path, (signature, digest) in changed])
                db.executemany("DELETE FROM hashes WHERE root=? AND path=?", [(str(self.root), path) for path in removed])
        except sqlite3.Error:
            pass  # Only a cache: the next launch hashes again.

    # -- activity history ---------------------------------------------------
    def activity_scope(self):
        return json.dumps([self.origin, str(self.root)])

    def record_activity(self, started_at, duration_ms, summary=None, error=None):
        """Keep a pass that did something; repeated idle or failing passes share one row.

        Returns True when the stored activity changed.
        """
        events, self.pass_events = self.pass_events, []
        summary = summary or {}
        counts = {name: int(summary.get(name) or 0) for name in ACTIVITY_COUNTS}
        conflicts = sorted(summary.get("conflicts") or [])
        errors = summary.get("errors") or []
        if not any(counts.values()) and not conflicts and not errors and not error and not events:
            return False
        data = {**counts, "conflicts": conflicts[:20], "conflict_count": len(conflicts),
                "errors": errors[:20], "error_count": len(errors), "error": error}
        signature = None if any(counts.values()) else hashlib.sha256(json.dumps(
            [conflicts, sorted(item["path"] + "|" + item["detail"] for item in errors), error]).encode()).hexdigest()
        scope, now = self.activity_scope(), time.time()
        with self.db() as db:
            last = db.execute("SELECT id,signature FROM sync_passes WHERE scope=? ORDER BY id DESC LIMIT 1", (scope,)).fetchone()
            if signature and last and last[1] == signature:
                # The same conflicts or failure again: do not push real activity out.
                db.execute("UPDATE sync_passes SET finished_at=?,duration_ms=?,repeats=repeats+1 WHERE id=?",
                           (now, duration_ms, last[0]))
            else:
                db.execute("INSERT INTO sync_passes (scope,started_at,finished_at,duration_ms,signature,data) VALUES (?,?,?,?,?,?)",
                           (scope, started_at, now, duration_ms, signature, json.dumps(data)))
            for event in events:
                if event["kind"] == "conflict":
                    # An unresolved conflict is reported by every pass: list it once.
                    previous = db.execute("SELECT kind FROM sync_events WHERE scope=? AND path=? ORDER BY id DESC LIMIT 1",
                                          (scope, event["path"])).fetchone()
                    if previous and previous[0] == "conflict":
                        continue
                db.execute("INSERT INTO sync_events (scope,at,kind,path,size,detail) VALUES (?,?,?,?,?,?)",
                           (scope, event["at"], event["kind"], event["path"], event.get("size"), event.get("detail")))
            for table, keep in (("sync_passes", ACTIVITY_PASSES), ("sync_events", ACTIVITY_EVENTS)):
                db.execute(f"DELETE FROM {table} WHERE scope=? AND id NOT IN "
                           f"(SELECT id FROM {table} WHERE scope=? ORDER BY id DESC LIMIT ?)", (scope, scope, keep))
        return True

    def activity(self):
        scope = self.activity_scope()
        with self.db() as db:
            passes = db.execute("SELECT id,started_at,finished_at,duration_ms,repeats,data FROM sync_passes "
                                "WHERE scope=? ORDER BY id DESC LIMIT ?", (scope, ACTIVITY_PASSES)).fetchall()
            events = db.execute("SELECT id,at,kind,path,size,detail FROM sync_events "
                                "WHERE scope=? ORDER BY id DESC LIMIT ?", (scope, ACTIVITY_EVENTS)).fetchall()
        return {
            "passes": [{"id": row[0], "started_at": row[1], "finished_at": row[2], "duration_ms": row[3],
                        "repeats": row[4], **json.loads(row[5])} for row in passes],
            "events": [{"id": row[0], "at": row[1], "kind": row[2], "path": row[3], "size": row[4],
                        "detail": row[5]} for row in events],
        }
