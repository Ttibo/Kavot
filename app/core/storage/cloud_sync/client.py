"""Two-way sync of the local workspace folder with Kavot Cloud, file by file, like a drive.

The pieces live next to this module: ``files`` (what syncs, hashing, walking),
``errors`` (CloudError and address checks), ``ledger`` (the SQLite state of this
device) and ``conflicts`` (files changed on both sides).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from app.core.storage.cloud_sync.conflicts import STATE_FILE, ConflictHandling
from app.core.storage.cloud_sync.errors import CloudError, https_url, s3_error
from app.core.storage.cloud_sync.files import (
    FileData, create_without_overwrite, device_name, reader, sha, tree_fingerprint, walk,
)
from app.core.storage.cloud_sync.ledger import SyncLedger

MANIFEST_PAGE = 500
# More deletions than this in one pass wait for a confirmation (an emptied or unmounted folder).
MASS_DELETE_MIN = 10
MASS_DELETE_SHARE = 0.3
# Local copies kept when the cloud deletes or replaces a file, kept this long.
KEEP_REMOVED_SECONDS = 30 * 24 * 3600
# Parallel transfers hide network latency; each path is still handled by one worker.
TRANSFER_WORKERS = 4

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



class LocalSync(SyncLedger, ConflictHandling):
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
        self._hashes_loaded = False
        # Set by confirm_deletions: the next pass applies the deletions it would otherwise hold.
        self.allow_deletions = False
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
        self.pairing = self.api("POST", "/devices/start", {"name": f"Kavot · {device_name()}"}, anonymous=True)
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

    def erased(self, resource_id):
        """True when the cloud no longer knows this resource at all."""
        try:
            self.api("GET", "/sync/resources/" + str(uuid.UUID(str(resource_id))))
        except ValueError:
            return False
        except CloudError as error:
            return error.status == 404
        return False

    def scan(self):
        """Hash regular workspace files without following links outside it."""
        files, skipped = {}, []
        if not self.root.exists():
            raise CloudError(409, "The local folder is unavailable. Sync paused to protect the cloud files.")
        if not self._hashes_loaded:
            self._hash_cache = self.load_hashes()
            self._hashes_loaded = True
        previous = dict(self._hash_cache)
        for path, entry in walk(self.root):
            candidate = Path(entry.path)
            try:
                if entry.is_symlink():
                    skipped.append(path)
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
                skipped.append(path)
                continue
        self._hash_cache = {path: value for path, value in self._hash_cache.items() if path in files}
        self.store_hashes(previous)
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
        elif result["status"] == "conflict":
            return self.settle_conflict(relative, result)
        return result

    def settle_conflict(self, relative, result):
        """Settle an upload that raced another device's, like a drive does.

        The cloud refuses to pick a winner; without this the file stayed blocked
        until someone resolved it by hand, and every pass reported it again.
        An edit beats a remote deletion; otherwise both versions are kept and
        this device's one becomes the cloud's conflict copy. If the file changed
        again meanwhile, the conflict is left for the person to resolve."""
        current = result.get("current") or {}
        choice = "keep_local" if current.get("deleted_at") else "keep_both"
        try:
            settled = self.resolve(relative, choice, current["version"])
        except (CloudError, OSError, KeyError):
            return result
        return settled if settled.get("status") != "conflict" else result

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
        backup = folder / (uuid.uuid4().hex + "-deleted-" + target.name)
        target.replace(backup)
        return backup.relative_to(self.root).as_posix()

    def prune_removed(self):
        """Forget the local copies of files the cloud deleted or replaced, after a month."""
        folder = self.root / ".kavot-conflicts"
        if not folder.is_dir():
            return
        limit = time.time() - KEEP_REMOVED_SECONDS
        for entry in folder.iterdir():
            try:
                if entry.is_file() and entry.stat().st_mtime < limit:
                    entry.unlink()
            except OSError:
                continue

    def confirm_deletions(self):
        self.allow_deletions = True

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
                    "deleted_remote": 0, "conflicts": [], "preserved": [], "merged": [],
                    "skipped": [], "errors": []}
        totals = new_summary()
        totals["skipped"] = skipped
        skipped_paths = set(skipped)

        paths = sorted(set(local) | set(remote) | set(tracked))

        # Many files gone from this device at once usually mean a folder emptied or unmounted
        # by mistake: deleting them from the cloud waits for a confirmation instead of spreading
        # to every device. (Deletions coming from the cloud were confirmed where they were made.)
        live = {path: row[1] for path, row in tracked.items() if not row[1].get("deleted") and "pending" not in row[1]}
        deletions = [path for path, state in live.items()
                     if path not in local and path not in skipped_paths and remote.get(path)
                     and not remote[path].get("deleted_at") and remote[path]["version"] == state.get("version")]
        hold = not self.allow_deletions and len(deletions) > max(MASS_DELETE_MIN, int(len(live) * MASS_DELETE_SHARE))
        self.allow_deletions = False
        totals["held_deletions"] = len(deletions) if hold else 0
        if hold:
            held = set(deletions)
            paths = [path for path in paths if path not in held]

        def count(result, summary, relative):
            """Add one upload's outcome to the pass summary."""
            status = result.get("status")
            if status == "conflict":
                summary["conflicts"].append(relative)
            elif status in {"committed", "resolved"}:
                summary["uploaded"] += 1
                path = (result.get("result") or {}).get("path")
                if status == "resolved" and result.get("resolution") == "keep_both" and path:
                    summary["preserved"].append(path)

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
                        and local_sha != current.get("sha256")
                        and (not state or ("pending" not in state
                             and current["version"] != state.get("version")
                             and local_sha != state.get("sha256")))):
                    # Changed here and in the cloud: never pick one by date; keep both (or merge the metadata).
                    self.resolve_both_changed(account, relative, current, summary)
                    return summary
                # Version zero and pending uploads are deliberately absent from
                # the published manifest. Resume their durable operation first.
                if state and ("pending" in state or (state.get("version", 0) == 0 and current is None)):
                    if "pending" in state or local_sha is not None:
                        count(self.push(relative, current), summary, relative)
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
                            # A file this device never synced, at a path deleted in the cloud:
                            # publish it as the path's new version rather than renaming it
                            # (renaming every file after the cloud folder was emptied
                            # filled the workspace with "(restored …)" copies).
                            count(self.push(relative, current), summary, relative)
                        return summary
                    if current and local_sha is not None:
                        if current["sha256"] == local_sha:
                            self.save(self.key(account, relative), {
                                "resource_id": current["id"], "version": current["version"],
                                "sha256": local_sha, "deleted": False,
                            })
                        else:
                            self.resolve_both_changed(account, relative, current, summary)
                        return summary
                    if current:
                        self.pull(current["id"], relative, current)
                        summary["downloaded"] += 1
                    elif local_sha is not None:
                        count(self.push(relative, current), summary, relative)
                    return summary

                if current is None:
                    # A tracked server resource should always appear in the manifest.
                    # Keep the local file untouched until the server is consistent again.
                    summary["errors"].append({"path": relative, "detail": "The cloud file is missing from the cloud list. Retrying later."})
                    return summary
                if current["id"] != state["resource_id"]:
                    # The path now belongs to another cloud file (erased from the portal,
                    # then created again elsewhere). This used to stay a conflict forever,
                    # with nothing to compare or resolve: bind the path to the new file.
                    key = self.key(account, relative)
                    if current.get("deleted_at"):
                        self.save(key, {"resource_id": current["id"], "version": current["version"],
                                        "sha256": None, "deleted": True})
                        if local_sha is not None:
                            count(self.push(relative, current), summary, relative)
                    elif local_sha is None or local_sha == state.get("sha256"):
                        # Unchanged here since the last agreement: take the cloud file.
                        self.save(key, {"resource_id": current["id"], "version": 0,
                                        "sha256": local_sha, "deleted": False})
                        if local_sha == current.get("sha256"):
                            self.save(key, {"resource_id": current["id"], "version": current["version"],
                                            "sha256": local_sha, "deleted": False})
                        else:
                            self.pull(current["id"], relative, current)
                            summary["downloaded"] += 1
                    else:
                        self.forget(key)
                        self.resolve_both_changed(account, relative, current, summary)
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
                    elif local_sha is not None and not current.get("deleted_at"):
                        self.resolve_both_changed(account, relative, current, summary)
                    elif local_sha is not None:
                        # Deleted in the cloud but edited here: the edit wins and is published again.
                        count(self.push(relative, current), summary, relative)
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
                        count(self.push(relative, current), summary, relative)
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
        try:
            state_file = self.path(STATE_FILE)
            if state_file.is_file():
                self.remember_state_base(account, {STATE_FILE: sha(self.read(state_file))})
        except (OSError, CloudError):
            pass  # Without a base, the next merge keeps every record of both sides.
        self.prune_removed()
        return totals


__all__ = ["CloudError", "LocalSync", "https_url", "s3_error"]
