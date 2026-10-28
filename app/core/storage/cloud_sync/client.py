from __future__ import annotations

import difflib
import hashlib
import json
import os
import io
import shutil
import sqlite3
import tempfile
import uuid
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import xml.etree.ElementTree as ET
from contextlib import contextmanager, nullcontext
from pathlib import Path
from urllib.parse import urlsplit

import httpx

MANIFEST_PAGE = 500
# .kavot-local holds derived, per-device data (search index, change journal).
EXCLUDED_PARTS = {".kavot-conflicts", ".kavot-backups", ".kavot-local"}
# Parallel transfers hide network latency; each path is still handled by one worker.
TRANSFER_WORKERS = 4
# Sync activity kept per device for Settings: passes that did something, file events.
ACTIVITY_PASSES = 50
ACTIVITY_EVENTS = 200
ACTIVITY_COUNTS = ("uploaded", "downloaded", "deleted_local", "deleted_remote")


class CloudError(Exception):
    def __init__(self, status, detail, current=None):
        self.status, self.detail = status, detail
        self.current = current
        super().__init__(str(detail))


class FileData:
    """A bounded-memory file payload, optionally owning a temporary download."""
    def __init__(self, path, temporary=False):
        self.path, self.temporary = Path(path), temporary

    def __len__(self):
        return self.path.stat().st_size

    def __bool__(self):
        return True

    def decode(self, encoding):
        return self.path.read_bytes().decode(encoding)

    def __del__(self):
        if self.temporary:
            self.path.unlink(missing_ok=True)


def reader(data):
    return data.path.open("rb") if isinstance(data, FileData) else io.BytesIO(data)


def sha(data):
    digest = hashlib.sha256()
    with reader(data) as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def https_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise CloudError(422, "An HTTPS URL without credentials is required.")
    return value


def s3_error(response, operation="Upload"):
    """Expose actionable S3 diagnostics without leaking signed URLs or keys."""
    fields = {}
    try:
        root = ET.fromstring(response.content[:65536])
        fields = {node.tag.rsplit("}", 1)[-1]: node.text or "" for node in root.iter()}
    except ET.ParseError:
        pass
    code = fields.get("Code", "")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,79}", code):
        code = ""
    detail = f"{operation} rejected by S3 (HTTP {response.status_code}{', ' + code if code else ''})."
    if code in {"AuthorizationQueryParametersError", "AuthorizationHeaderMalformed"}:
        expected = re.search(r"expecting ['\"]([a-z0-9-]{1,63})['\"]", fields.get("Message", ""))
        region = expected.group(1) if expected else fields.get("Region", "")
        if re.fullmatch(r"[a-z0-9-]{1,63}", region):
            detail += f" Wrong S3 region: set KAVOT_S3_REGION={region} on the cloud server, then reload the API configuration."
        else:
            detail += " Check the S3 region configured on the cloud server."
    else:
        hint = {
            "SignatureDoesNotMatch": "Check the region, S3 address and credentials configured on the cloud server.",
            "AccessDenied": "Check the bucket access rights and that the S3 authorization is valid.",
            "InvalidAccessKeyId": "The S3 access key configured on the cloud server is invalid.",
            "RequestExpired": "The S3 authorization has expired. Run the sync again to renew it.",
            "ExpiredToken": "The cloud server’s S3 credentials have expired.",
            "RequestTimeTooSkewed": "Check the cloud server’s clock.",
            "BadDigest": "The storage rejected the uploaded file’s checksum.",
            "NotImplemented": "The storage does not support an option of the S3 transfer.",
            "PermanentRedirect": "The configured S3 address does not match the bucket’s region.",
        }.get(code, "Check the cloud storage configuration, or try again if the service is temporarily unavailable.")
        detail += " " + hint
    detail += " The pending local copy is kept."
    return CloudError(503 if response.status_code >= 500 else 502, detail)


def create_without_overwrite(source: Path, target: Path, *, move=False):
    """Publish a file only if target is absent, including restricted Windows hosts."""
    try:
        os.link(source, target)
        return
    except PermissionError:
        if os.name != "nt":
            raise
    if move:
        # On Windows rename is atomic and refuses to replace an existing file.
        os.rename(source, target)
        return
    with source.open("rb") as reader, target.open("xb") as writer:
        while chunk := reader.read(1024 * 1024):
            writer.write(chunk)
        writer.flush()
        os.fsync(writer.fileno())


def tree_fingerprint(root):
    """Cheap stat-only signature of a folder, ignoring Kavot copies."""
    digest = hashlib.sha256()
    stack = [Path(root)]
    while stack:
        folder = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda entry: entry.name)
        except OSError:
            continue
        for entry in entries:
            if entry.name in EXCLUDED_PARTS or entry.name.startswith(".kavot-download-"):
                continue
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir():
                    stack.append(Path(entry.path))
                elif entry.is_file():
                    info = entry.stat()
                    digest.update(f"{entry.path}|{info.st_size}|{info.st_mtime_ns}|".encode("utf-8", "surrogatepass"))
            except OSError:
                continue
    return digest.hexdigest()


class Vault:
    def __init__(self, origin):
        self.service = "Kavot Cloud " + origin

    def get(self):
        import keyring
        return keyring.get_password(self.service, "device")

    def set(self, token):
        import keyring
        if token:
            keyring.set_password(self.service, "device", token)
        else:
            try:
                keyring.delete_password(self.service, "device")
            except keyring.errors.PasswordDeleteError:
                pass


class LocalSync:
    def __init__(self, origin, root: Path, state_path: Path, *, vault=None, api_transport=None, s3_transport=None):
        self.origin = https_url(origin).rstrip("/")
        if urlsplit(self.origin).path or urlsplit(self.origin).query:
            raise CloudError(422, "The cloud address must be an HTTPS origin without a path.")
        self.root = root.resolve()
        self.state_path = state_path
        self.vault = vault or Vault(self.origin)
        self.api_transport, self.s3_transport = api_transport, s3_transport
        self.pairing = None
        self._session = threading.local()
        self._manifest_cache = None
        self._hash_cache = {}
        # The account behind the stored token, reused across passes: a pass
        # does not need GET /me while the device token stays the same.
        self._account_cache = None
        # Cloud revision read at the start of the current pass, and the last
        # one a pass fully applied: events carrying it need no new pass.
        self.pass_revision = None
        self.applied_revision = None
        self.progress = lambda **event: None
        # File events of the current pass, written with the pass by record_activity.
        self.pass_events = []

    def token(self):
        try:
            return self.vault.get()
        except Exception:
            raise CloudError(503, "The system password vault is unavailable.")

    def api(self, method, path, body=None, *, anonymous=False, conflict=False):
        session = getattr(self._session, "http", None)
        if session and method == "GET" and path == "/me" and getattr(self._session, "account", None):
            return self._session.account
        headers = {}
        if not anonymous:
            token = self._session.token if session else self.token()
            if not token:
                raise CloudError(401, "Link this device to your Kavot account.")
            headers["Authorization"] = "Bearer " + token
        try:
            timeout = httpx.Timeout(30, read=600) if path == '/sync/workspace/reset' else httpx.Timeout(30, read=120) if path.endswith('/complete') else 30
            with nullcontext(session) if session else httpx.Client(transport=self.api_transport, timeout=timeout, follow_redirects=False, trust_env=False) as client:
                response = client.request(method, self.origin + "/api/cloud" + path, json=body, headers=headers, timeout=timeout)
        except httpx.HTTPError:
            raise CloudError(503, "Cloud unreachable. The local operation is kept to retry.")
        if response.status_code == 204:
            return None
        try:
            data = response.json()
        except ValueError:
            raise CloudError(502, "Invalid cloud response.")
        if response.status_code == 401 and not anonymous:
            self._account_cache = None
            raise CloudError(401, "This device's cloud session has expired. Link this device again.")
        if response.is_error and not (conflict and response.status_code == 409 and "transfer_id" in data):
            raise CloudError(response.status_code, data.get("detail", "Cloud operation rejected."), data.get("current"))
        if session and method == "GET" and path == "/me":
            self._session.account = data
            self._account_cache = (self._session.token, data)
        return data

    def connect(self):
        self.pairing = self.api("POST", "/devices/start", {"name": "Kavot bureau"}, anonymous=True)
        return {key: self.pairing[key] for key in ("verification_url", "user_code", "expires_in")}

    def poll(self):
        if not self.pairing:
            raise CloudError(409, "Start linking this device.")
        result = self.api("POST", "/devices/poll", {"device_code": self.pairing["device_code"]}, anonymous=True)
        if result["status"] == "approved":
            try:
                self.vault.set(result["token"])
            except Exception:
                raise CloudError(503, "Unable to save the connection in the system vault.")
            self.pairing = None
        return {"status": result["status"]}

    def path(self, relative):
        value = Path(relative)
        if value.is_absolute() or value.drive or ".." in value.parts or not relative:
            raise CloudError(422, "Give a file path relative to the local workspace.")
        result = (self.root / value).resolve()
        if not result.is_relative_to(self.root) or result == self.root:
            raise CloudError(422, "This file is outside the local workspace.")
        return result

    def read(self, path):
        try:
            with path.open("rb"):
                return FileData(path)
        except OSError:
            raise CloudError(404, "Local file unavailable.")

    @contextmanager
    def db(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.state_path, timeout=30)
        try:
            os.chmod(self.state_path, 0o600)
            connection.execute("PRAGMA journal_mode=WAL")
            with connection:
                connection.execute("CREATE TABLE IF NOT EXISTS tracked (key TEXT PRIMARY KEY, state TEXT NOT NULL, snapshot BLOB)")
                yield connection
        finally:
            connection.close()

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

    @contextmanager
    def activity_db(self):
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sync_passes (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, "
                       "started_at REAL NOT NULL, finished_at REAL NOT NULL, duration_ms INTEGER, "
                       "signature TEXT, repeats INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS sync_events (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, "
                       "at REAL NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, detail TEXT)")
            yield db

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
        with self.activity_db() as db:
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
        with self.activity_db() as db:
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

    def erased(self, resource_id):
        """True when the cloud no longer knows this resource at all."""
        try:
            self.api("GET", "/sync/resources/" + str(uuid.UUID(str(resource_id))))
        except ValueError:
            return False
        except CloudError as error:
            return error.status == 404
        return False

    def tracked(self, account):
        """Return synchronization states belonging to this account/workspace."""
        result = {}
        with self.db() as db:
            rows = db.execute("SELECT key,state FROM tracked").fetchall()
        for key, raw_state in rows:
            try:
                origin, owner, root, relative = json.loads(key)
            except (TypeError, ValueError):
                continue
            if origin == self.origin and owner == account and root == str(self.root):
                result[relative] = (key, json.loads(raw_state), None)
        return result

    def scan(self):
        """Hash regular workspace files without following links outside it."""
        files, skipped = {}, []
        if not self.root.exists():
            raise CloudError(409, "The local folder is unavailable. Sync paused to protect the cloud files.")
        for candidate in self.root.rglob("*"):
            path = None
            try:
                relative = candidate.relative_to(self.root)
                if any(part in EXCLUDED_PARTS for part in relative.parts):
                    continue
                path = relative.as_posix()
                if candidate.is_symlink():
                    skipped.append(path)
                    continue
                if candidate.name.startswith(".kavot-download-") or not candidate.is_file():
                    continue
                stat = candidate.stat()
                signature = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
                cached = self._hash_cache.get(path)
                if cached and cached[0] == signature:
                    files[path] = cached[1]
                else:
                    self.progress(phase="scan", path=path)
                    files[path] = sha(self.read(candidate))
                    after = candidate.stat()
                    if signature != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        files.pop(path)
                        skipped.append(path)
                        continue
                    self._hash_cache[path] = (signature, files[path])
            except (OSError, CloudError):
                if path:
                    skipped.append(path)
                continue
        self._hash_cache = {path: value for path, value in self._hash_cache.items() if path in files}
        return files, skipped

    def fingerprint(self):
        """Cheap stat-only signature used to notice edits made outside Kavot."""
        return tree_fingerprint(self.root)

    def manifest(self):
        account = self.api("GET", "/me")["id"]
        revision = self.api("GET", "/sync/changes")["revision"]
        self.pass_revision = revision
        cache = self._manifest_cache
        if cache and cache[:2] == (account, revision):
            return cache[2]
        if cache and cache[0] == account and str(cache[1]).isdigit() and str(revision).isdigit():
            rows = self.manifest_changes(cache)
            if rows is not None:
                return rows
        rows, offset = [], 0
        while True:
            page = self.api("GET", f"/sync/manifest?offset={offset}")
            rows.extend(page)
            if len(page) < MANIFEST_PAGE:
                # A concurrent publication invalidates this page snapshot.
                if self.api("GET", "/sync/changes")["revision"] == revision:
                    self._manifest_cache = (account, revision, rows)
                return rows
            offset += len(page)

    def manifest_changes(self, cache):
        """Apply only the heads changed since the cached manifest.

        Returns None when the server cannot describe the changes (an older
        server, or a bulk removal): the caller then reloads the full manifest.
        """
        account, since, rows = cache
        merged = {item["id"]: item for item in rows}
        cursor = int(since)
        while True:
            page = self.api("GET", f"/sync/manifest?since={cursor}")
            if not isinstance(page, dict) or page.get("full"):
                return None
            for item in page["items"]:
                merged[item["id"]] = item
                cursor = max(cursor, int(item.get("changed_rev") or 0))
            if not page.get("more"):
                break
        result = sorted(merged.values(), key=lambda item: (item["path"], item["id"]))
        self._manifest_cache = (account, page["revision"], result)
        return result

    def push(self, relative, remote=None):
        self.progress(phase="upload", path=relative)
        account = self.api("GET", "/me")["id"]
        key = self.key(account, relative)
        state, snapshot = self.load(key)
        if "pending" not in state:
            original_state = dict(state)
            source_stat = self.path(relative).stat()
            snapshot = self.read(self.path(relative))
            local_digest = sha(snapshot)
            if state["version"]:
                if not remote or remote.get("id") != state["resource_id"]:
                    remote = self.api("GET", "/sync/resources/" + state["resource_id"])
                if not remote.get("deleted_at") and remote["sha256"] == local_digest:
                    self.save(key, {"resource_id": remote["id"], "version": remote["version"], "sha256": local_digest})
                    return {"status": "unchanged", "current": remote}
                if state.get("sha256") == local_digest:
                    raise CloudError(409, "Only the remote version changed. Download it from the file list.")
            state["pending"] = {"operation_id": str(uuid.uuid4()), "resource_id": state["resource_id"],
                                "base_version": state["version"], "name": self.path(relative).name,
                                "path": self.path(relative).relative_to(self.root).as_posix(),
                                "size": len(snapshot), "sha256": local_digest,
                                "modified_at": source_stat.st_mtime}
            self.save(key, state, snapshot)
            state, snapshot = self.load(key)
            after = self.path(relative).stat()
            if (source_stat.st_mtime_ns, source_stat.st_size) != (after.st_mtime_ns, after.st_size):
                self.save(key, original_state)
                raise CloudError(409, "The file is being edited. It will be retried on the next run.")
            # Hash the durable copy, not a file which an editor may still change.
            state["pending"]["size"] = len(snapshot)
            state["pending"]["sha256"] = sha(snapshot)
            self.save(key, state, snapshot)
        try:
            result = self.api("POST", "/sync/transfers", state["pending"])
        except CloudError as error:
            if error.status != 409 or not error.current or state["version"] != 0:
                raise
            # Another device published this path after our manifest snapshot.
            # Upload against version zero to preserve both versions as a conflict.
            state["resource_id"] = error.current["id"]
            state["pending"]["resource_id"] = error.current["id"]
            state["pending"]["operation_id"] = str(uuid.uuid4())
            self.save(key, state, snapshot)
            result = self.api("POST", "/sync/transfers", state["pending"])
        retry = bool(state.get("transfer_id"))
        state["transfer_id"] = result["transfer_id"]
        self.save(key, state, snapshot)
        if result["status"] == "pending" and result["upload"].get("multipart") and retry:
            try:
                result = self.api("POST", f"/sync/transfers/{result['transfer_id']}/complete", conflict=True)
            except CloudError as error:
                if error.status not in {422, 503}:
                    raise
        if result["status"] == "pending":
            upload = result["upload"]
            try:
                # Deliberately separate HTTP clients: never forward the account token to S3.
                with httpx.Client(transport=self.s3_transport, timeout=120, follow_redirects=False, trust_env=False) as client:
                    with reader(snapshot) as source:
                        if upload.get("multipart"):
                            number = 1
                            while chunk := source.read(upload["part_size"]):
                                part = self.api("POST", f"/sync/transfers/{result['transfer_id']}/parts/{number}",
                                                {"sha256": sha(chunk)})
                                response = client.put(https_url(part["url"]), content=chunk, headers=part["headers"])
                                if response.status_code not in (200, 201, 204):
                                    raise s3_error(response, f"Upload of part {number}")
                                number += 1
                            response = httpx.Response(200)
                        else:
                            response = client.put(https_url(upload["url"]), content=source, headers=upload["headers"])
                if response.status_code not in (200, 201, 204, 412):
                    raise s3_error(response)
            except httpx.HTTPError:
                raise CloudError(503, "Transfer interrupted. The pending copy is kept.")
            # 412 means the immutable object may already exist after a lost response;
            # the cloud still verifies size and checksum before accepting it.
            result = self.api("POST", f"/sync/transfers/{result['transfer_id']}/complete", conflict=True)
        if result["status"] == "committed":
            state = {"resource_id": state["resource_id"], "version": result["result_version"],
                     "sha256": result["sha256"], "deleted": False}
            self.save(key, state)
        elif result["status"] == "resolved":
            return self.resolve(relative, result["resolution"], result["current"]["version"])
        return result

    def download(self, revision_id):
        info = self.api("GET", f"/sync/revisions/{revision_id}/download")
        handle = tempfile.NamedTemporaryFile(prefix="kavot-cloud-", delete=False)
        data = FileData(handle.name, temporary=True)
        digest, size = hashlib.sha256(), 0
        try:
            with handle, httpx.Client(transport=self.s3_transport, timeout=120, follow_redirects=False, trust_env=False) as client:
                with client.stream("GET", https_url(info["url"])) as response:
                    if response.status_code != 200:
                        raise CloudError(503, "S3 download unavailable.")
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > info["size"]:
                            raise CloudError(422, "Invalid download size.")
                        digest.update(chunk)
                        handle.write(chunk)
        except httpx.HTTPError:
            raise CloudError(503, "Download interrupted. The local file is unchanged.")
        if size != info["size"] or digest.hexdigest() != info["sha256"]:
            raise CloudError(422, "The download checksum is wrong.")
        return data

    def write_remote(self, target, data, expected_sha):
        """Never silently overwrite an editor save; preserve the exact moved file."""
        target.parent.mkdir(parents=True, exist_ok=True)
        backup = None
        if target.exists():
            if expected_sha is None:
                raise CloudError(409, "A local file already exists. Choose another path.")
            folder = self.root / ".kavot-conflicts"
            folder.mkdir(exist_ok=True)
            if not folder.resolve().is_relative_to(self.root):
                raise CloudError(422, "The backup folder is outside the local workspace.")
            backup = folder / (uuid.uuid4().hex + "-" + target.name)
            target.replace(backup)
            try:
                matches = sha(self.read(backup)) == expected_sha
            except CloudError:
                matches = False
            if not matches:
                try:
                    create_without_overwrite(backup, target)
                except FileExistsError:
                    pass
                raise CloudError(409, f"The local file changed. A copy was kept in {backup.relative_to(self.root)}.")
        temporary = target.parent / (".kavot-download-" + uuid.uuid4().hex)
        try:
            with temporary.open("xb") as handle, reader(data) as source:
                shutil.copyfileobj(source, handle, 1024 * 1024)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                # Atomic create-without-overwrite: an intervening editor save wins.
                create_without_overwrite(temporary, target, move=True)
            except OSError:
                if backup and not target.exists():
                    create_without_overwrite(backup, target)
                raise CloudError(409, "Local write interrupted or file changed. The copies are kept.")
        except OSError:
            if backup and not target.exists():
                create_without_overwrite(backup, target)
            raise CloudError(409, "Local write interrupted. The previous copy is kept.")
        finally:
            temporary.unlink(missing_ok=True)
        return str(backup.relative_to(self.root)) if backup else None

    def pull(self, resource_id, relative, remote=None):
        self.progress(phase="download", path=relative)
        account = self.api("GET", "/me")["id"]
        key = self.key(account, relative)
        state, _ = self.load(key)
        target = self.path(relative)
        if "pending" in state:
            raise CloudError(409, "Resolve or finish the pending local transfer first.")
        if target.exists() and (state.get("sha256") != sha(self.read(target)) or state["resource_id"] != resource_id):
            raise CloudError(409, "The local file has changes. Upload it to compare versions, or choose another path.")
        if not remote or remote.get("id") != resource_id:
            # The pass already has this head from the manifest; fetch it only when called alone.
            remote = self.api("GET", "/sync/resources/" + str(uuid.UUID(resource_id)))
        if remote.get("deleted_at"):
            raise CloudError(410, "This file was deleted from the remote workspace.")
        data = self.download(remote["revision_id"])
        backup = self.write_remote(target, data, state.get("sha256"))
        if remote.get("modified_at"):
            os.utime(target, (remote["modified_at"], remote["modified_at"]))
        self.save(key, {"resource_id": remote["id"], "version": remote["version"],
                        "sha256": sha(data), "deleted": False})
        return {"status": "downloaded", "backup": backup}

    def remove_local(self, relative, expected_sha):
        """Apply a remote tombstone while preserving a recoverable local copy."""
        target = self.path(relative)
        if not target.exists():
            return None
        if sha(self.read(target)) != expected_sha:
            raise CloudError(409, "The local file changed during the remote deletion.")
        folder = self.root / ".kavot-conflicts"
        folder.mkdir(exist_ok=True)
        backup = folder / (uuid.uuid4().hex + "-supprime-" + target.name)
        target.replace(backup)
        return backup.relative_to(self.root).as_posix()


    def initial_conflict(self, account, relative, remote):
        """Merge two unrelated first-sync files without losing either copy."""
        target = self.path(relative)
        suffix = target.suffix
        stem = target.name[:-len(suffix)] if suffix else target.name
        copy = target.with_name(f"{stem[:120]} (conflit local {uuid.uuid4().hex[:8]}){suffix}")
        target.replace(copy)
        try:
            data = self.download(remote["revision_id"])
            self.write_remote(target, data, None)
        except Exception:
            if not target.exists() and copy.exists():
                copy.replace(target)
            raise
        self.save(self.key(account, relative), {
            "resource_id": remote["id"], "version": remote["version"],
            "sha256": remote["sha256"], "deleted": False,
        })
        copy_relative = copy.relative_to(self.root).as_posix()
        self.push(copy_relative)
        return copy_relative

    def replace_cloud_from_local(self):
        # Validate that the local source is readable before any remote deletion.
        _, skipped = self.scan()
        if skipped:
            raise CloudError(409, "Some local files are unavailable. Fix them before replacing the cloud.")
        account = self.api("GET", "/me")["id"]
        try:
            result = self.api("POST", "/sync/workspace/reset", {"confirmation": "replace-cloud-with-local"})
        except CloudError as error:
            if error.status in {404, 405}:
                raise CloudError(409, "The Kavot Cloud server must be updated to allow the reset.")
            raise
        # A new baseline ensures that no old tombstone deletes local files.
        self._manifest_cache = None
        entries = self.tracked(account)
        with self.db() as db:
            for key, _, _ in entries.values():
                db.execute("DELETE FROM tracked WHERE key=?", (key,))
        for _, state, _ in entries.values():
            if state.get("snapshot_file"):
                (self.state_path.parent / state["snapshot_file"]).unlink(missing_ok=True)
        return {**result, "summary": self.sync_workspace()}

    @contextmanager
    def session(self):
        """Reuse one connection and one vault read for every request of a pass."""
        if getattr(self._session, "http", None):
            yield
            return
        with httpx.Client(transport=self.api_transport, follow_redirects=False, trust_env=False) as http:
            self._session.http = http
            self._session.account = None
            try:
                self._session.token = self.token()
                if self._account_cache and self._account_cache[0] == self._session.token:
                    self._session.account = self._account_cache[1]
                yield
            finally:
                self._session.http = None
                self._session.account = None
                self._session.token = None

    def sync_workspace(self):
        with self.session():
            return self._sync_workspace()

    def _sync_workspace(self):
        """Perform one safe, bidirectional synchronization pass."""
        account = self.api("GET", "/me")["id"]
        self.progress(phase="scan", path=None, completed=0, total=0)
        local, skipped = self.scan()
        tracked = self.tracked(account)
        self.progress(phase="remote", path=None)
        remote_rows = self.manifest()
        remote = {item["path"]: item for item in remote_rows}
        def new_summary():
            return {"uploaded": 0, "downloaded": 0, "deleted_local": 0,
                    "deleted_remote": 0, "conflicts": [], "preserved": [],
                    "skipped": [], "errors": []}
        totals = new_summary()
        totals["skipped"] = skipped
        skipped_paths = set(skipped)

        paths = sorted(set(local) | set(remote) | set(tracked))

        def handle(relative):
            summary = new_summary()
            if relative in skipped_paths:
                return summary
            current = remote.get(relative)
            tracked_row = tracked.get(relative)
            state = tracked_row[1] if tracked_row else None
            local_sha = local.get(relative)
            try:
                if (current and not current.get("deleted_at") and local_sha is not None
                        and local_sha != current.get("sha256") and current.get("modified_at") is not None
                        and (not state or ("pending" not in state
                             and current["version"] != state.get("version")
                             and local_sha != state.get("sha256")))):
                    local_time = self.path(relative).stat().st_mtime
                    baseline = {"resource_id": current["id"], "version": current["version"] if local_time > current["modified_at"] else 0,
                                "sha256": current["sha256"] if local_time > current["modified_at"] else local_sha}
                    self.save(self.key(account, relative), baseline)
                    if local_time > current["modified_at"]:
                        result = self.push(relative, current)
                        summary["uploaded"] += result["status"] == "committed"
                        if result["status"] == "conflict":
                            summary["conflicts"].append(relative)
                    else:
                        self.pull(current["id"], relative, current)
                        summary["downloaded"] += 1
                    return summary
                # Version zero and pending uploads are deliberately absent from
                # the published manifest. Resume their durable operation first.
                if state and ("pending" in state or (state.get("version", 0) == 0 and current is None)):
                    if "pending" in state or local_sha is not None:
                        result = self.push(relative, current)
                        if result["status"] == "conflict":
                            summary["conflicts"].append(relative)
                        elif result["status"] == "committed":
                            summary["uploaded"] += 1
                    return summary
                if state and current is None and self.erased(state.get("resource_id")):
                    # The cloud copy was erased from the portal: this path is new again.
                    self.forget(self.key(account, relative))
                    state = None
                if state is None:
                    if current and current.get("deleted_at"):
                        self.save(self.key(account, relative), {
                            "resource_id": current["id"], "version": current["version"],
                            "sha256": None, "deleted": True,
                        })
                        if local_sha is not None:
                            target = self.path(relative)
                            suffix = target.suffix
                            stem = target.name[:-len(suffix)] if suffix else target.name
                            copy = target.with_name(f"{stem[:120]} (restaure local {uuid.uuid4().hex[:8]}){suffix}")
                            target.replace(copy)
                            self.push(copy.relative_to(self.root).as_posix())
                            summary["preserved"].append(copy.relative_to(self.root).as_posix())
                            summary["uploaded"] += 1
                        return summary
                    if current and local_sha is not None:
                        if current["sha256"] == local_sha:
                            self.save(self.key(account, relative), {
                                "resource_id": current["id"], "version": current["version"],
                                "sha256": local_sha, "deleted": False,
                            })
                        else:
                            copy = self.initial_conflict(account, relative, current)
                            summary["preserved"].append(copy)
                            summary["downloaded"] += 1
                            summary["uploaded"] += 1
                        return summary
                    if current:
                        self.pull(current["id"], relative, current)
                        summary["downloaded"] += 1
                    elif local_sha is not None:
                        result = self.push(relative, current)
                        summary["uploaded"] += result["status"] == "committed"
                        if result["status"] == "conflict":
                            summary["conflicts"].append(relative)
                    return summary

                if current is None:
                    # A tracked server resource should always appear in the manifest.
                    # Keep the local file untouched until the server is consistent again.
                    summary["errors"].append({"path": relative, "detail": "Ressource distante absente du manifeste."})
                    return summary
                if current["id"] != state["resource_id"]:
                    summary["conflicts"].append(relative)
                    return summary

                remote_changed = current["version"] != state.get("version", 0)
                local_changed = local_sha != state.get("sha256")
                if not remote_changed and not local_changed:
                    return summary
                if remote_changed and local_changed:
                    if current.get("deleted_at") and local_sha is None:
                        self.save(self.key(account, relative), {
                            "resource_id": current["id"], "version": current["version"],
                            "sha256": None, "deleted": True,
                        })
                    elif not current.get("deleted_at") and local_sha is None:
                        self.pull(current["id"], relative, current)
                        summary["downloaded"] += 1
                    elif not current.get("deleted_at") and local_sha == current.get("sha256"):
                        self.save(self.key(account, relative), {
                            "resource_id": current["id"], "version": current["version"],
                            "sha256": local_sha, "deleted": False,
                        })
                    elif local_sha is not None:
                        result = self.push(relative, current)
                        if result["status"] == "conflict":
                            summary["conflicts"].append(relative)
                        else:
                            summary["uploaded"] += 1
                    else:
                        summary["conflicts"].append(relative)
                    return summary

                if local_changed:
                    if local_sha is None:
                        deleted = self.api("POST", f"/sync/resources/{state['resource_id']}/delete",
                                           {"expected_version": state["version"]})
                        self.save(self.key(account, relative), {
                            "resource_id": deleted["id"], "version": deleted["version"],
                            "sha256": None, "deleted": True,
                        })
                        summary["deleted_remote"] += 1
                    else:
                        result = self.push(relative, current)
                        if result["status"] == "conflict":
                            summary["conflicts"].append(relative)
                        elif result["status"] != "unchanged":
                            summary["uploaded"] += 1
                    return summary

                if current.get("deleted_at"):
                    self.remove_local(relative, state.get("sha256"))
                    self.save(self.key(account, relative), {
                        "resource_id": current["id"], "version": current["version"],
                        "sha256": None, "deleted": True,
                    })
                    summary["deleted_local"] += 1
                else:
                    self.pull(current["id"], relative, current)
                    summary["downloaded"] += 1
            except (CloudError, OSError) as error:
                summary["errors"].append({"path": relative, "detail": str(error.detail) if isinstance(error, CloudError) else str(error)})
            return summary

        # Worker threads share this pass's connection and credentials; httpx
        # clients are thread-safe and each path is owned by a single worker.
        context = (self._session.http, self._session.token, self._session.account)
        lock, done = threading.Lock(), [0]
        self.pass_events = []

        def local_size(relative):
            try:
                return self.path(relative).stat().st_size
            except (OSError, CloudError):
                return None

        def events_of(relative, delta):
            """Describe what a path's handling did, for the activity history."""
            now, head = time.time(), remote.get(relative) or {}
            events = []
            if delta["downloaded"]:
                events.append({"kind": "download", "path": relative, "size": local_size(relative)})
            # A first-merge copy is uploaded under its own name.
            uploads = delta["preserved"] or ([relative] if delta["uploaded"] else [])
            events += [{"kind": "upload", "path": path, "size": local_size(path)} for path in uploads]
            if delta["deleted_remote"]:
                events.append({"kind": "deleted_remote", "path": relative, "size": head.get("size")})
            if delta["deleted_local"]:
                events.append({"kind": "deleted_local", "path": relative, "size": None})
            events += [{"kind": "conflict", "path": path, "size": local_size(path)} for path in delta["conflicts"]]
            return [{**event, "at": now} for event in events]

        def worker(relative):
            self._session.http, self._session.token, self._session.account = context
            try:
                delta = handle(relative)
                events = events_of(relative, delta)
                if events:
                    with lock:
                        self.pass_events.extend(events)
                return delta
            finally:
                with lock:
                    done[0] += 1
                    self.progress(phase="compare", path=relative, completed=done[0], total=len(paths))

        self.progress(phase="compare", path=None, completed=0, total=len(paths))
        with ThreadPoolExecutor(max_workers=TRANSFER_WORKERS, thread_name_prefix="kavot-sync") as pool:
            for delta in pool.map(worker, paths):
                for name, value in delta.items():
                    totals[name] += value
        self.progress(phase="done", path=None, completed=len(paths), total=len(paths))
        return totals

    def comparison(self, relative):
        account = self.api("GET", "/me")["id"]
        state, snapshot = self.load(self.key(account, relative))
        if not state.get("transfer_id"):
            raise CloudError(409, "No transfer to compare.")
        result = self.api("GET", "/sync/transfers/" + state["transfer_id"])
        if result["status"] == "resolved":
            # Finish applying a choice after an interrupted local download/write.
            return self.resolve(relative, result["resolution"], result["current"]["version"])
        if result["status"] != "conflict":
            return result
        result["diff"] = None
        if result["current"].get("deleted_at"):
            return result
        remote = self.download(result["current"]["revision_id"])
        if snapshot and len(snapshot) <= 1024 ** 2 and len(remote) <= 1024 ** 2:
            try:
                local_text, remote_text = snapshot.decode("utf-8"), remote.decode("utf-8")
                if "\x00" not in local_text + remote_text:
                    result["diff"] = "".join(difflib.unified_diff(remote_text.splitlines(True), local_text.splitlines(True),
                        fromfile="Version distante", tofile="Version locale", n=3))[:100000]
            except UnicodeDecodeError:
                pass
        return result

    def resolve(self, relative, choice, expected_version):
        account = self.api("GET", "/me")["id"]
        key = self.key(account, relative)
        state, snapshot = self.load(key)
        if not state.get("transfer_id") or snapshot is None:
            raise CloudError(409, "No pending local conflict.")
        target = self.path(relative)
        expected_local_sha = sha(snapshot)
        if choice == "keep_remote":
            # The explicit remote choice also applies to edits made since upload.
            # write_remote preserves those edits and checks for intervening saves.
            expected_local_sha = sha(self.read(target)) if target.exists() else None
        if choice == "keep_both" and sha(self.read(target)) != sha(snapshot):
            previous = self.api("GET", "/sync/transfers/" + state["transfer_id"])
            already_applied = (previous.get("resolution") == choice and previous["status"] == "resolved"
                               and sha(self.read(target)) == previous["current"]["sha256"])
            if not already_applied:
                raise CloudError(409, "The local file changed since it was uploaded. Keep the local version, then upload your new changes.")
            expected_local_sha = previous["current"]["sha256"]
        result = self.api("POST", f"/sync/transfers/{state['transfer_id']}/resolve",
                          {"choice": choice, "expected_version": expected_version}, conflict=True)
        if result["status"] == "conflict":
            return result
        if choice == "keep_local":
            self.save(key, {"resource_id": state["resource_id"], "version": result["result_version"],
                            "sha256": sha(snapshot), "deleted": False})
        else:
            if choice == "keep_both":
                copy = target.with_name(f"{target.stem[:100]} (conflit {state['transfer_id'][:8]}){target.suffix}")
                if not copy.exists():
                    self.write_remote(copy, snapshot, None)
                elif sha(self.read(copy)) != sha(snapshot):
                    raise CloudError(409, "The conflict copy exists with different content. Rename it before trying again.")
                self.save(self.key(account, str(copy.relative_to(self.root))), {
                    "resource_id": result["result"]["id"], "version": result["result_version"], "sha256": sha(snapshot)})
            remote = result["current"]
            if remote.get("deleted_at"):
                result["backup"] = self.remove_local(relative, expected_local_sha)
                self.save(key, {"resource_id": remote["id"], "version": remote["version"],
                                "sha256": None, "deleted": True})
            else:
                data = self.download(remote["revision_id"])
                if not target.exists() or sha(self.read(target)) != sha(data):
                    result["backup"] = self.write_remote(target, data, expected_local_sha)
                if remote.get("modified_at"):
                    os.utime(target, (remote["modified_at"], remote["modified_at"]))
                self.save(key, {"resource_id": remote["id"], "version": remote["version"],
                                "sha256": sha(data), "deleted": False})
        return result
