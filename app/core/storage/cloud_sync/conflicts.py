"""Files changed on this device and in the cloud: keep both, merge the metadata, or apply a choice."""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import shutil

from app.core.storage.cloud_sync.errors import CloudError
from app.core.storage.cloud_sync.files import conflict_copy, sha
from app.core.storage.cloud_sync.merge import merge_state

# The workspace metadata: merged record by record when two devices changed it.
STATE_FILE = "kavot.state.json"


class ConflictHandling:
    """Mixin of :class:`LocalSync` for files both sides changed since they last agreed."""

    def keep_both(self, account, relative, remote):
        """A file changed on this device and in the cloud: keep both, like a drive.

        The cloud version keeps the name; this device's version becomes a conflict copy next
        to it, synced like any new file."""
        target = self.path(relative)
        copy = conflict_copy(target)
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

    def state_base_path(self, account):
        digest = hashlib.sha256(self.key(account, STATE_FILE).encode()).hexdigest()[:32]
        return self.state_path.parent / "cloud-sync-base" / f"{digest}.json"

    def remember_state_base(self, account, local):
        """Keep the state file both sides last agreed on: the base of the next merge."""
        tracked = self.tracked(account).get(STATE_FILE)
        digest = local.get(STATE_FILE)
        if not tracked or not digest or tracked[1].get("sha256") != digest or "pending" in tracked[1]:
            return
        base = self.state_base_path(account)
        if base.exists() and sha(self.read(base)) == digest:
            return
        base.parent.mkdir(parents=True, exist_ok=True)
        temporary = base.with_suffix(".tmp")
        shutil.copyfile(self.path(STATE_FILE), temporary)
        if sha(self.read(temporary)) == digest:
            temporary.replace(base)
        else:
            temporary.unlink(missing_ok=True)

    def merge_state_file(self, account, relative, remote):
        """Merge the workspace metadata changed on both sides, then publish the result."""
        from app.core.kernel.files import atomic_write_json
        from app.core.records.repository import store
        target = self.path(relative)
        base_path = self.state_base_path(account)
        base = json.loads(base_path.read_text(encoding="utf-8")) if base_path.exists() else None
        theirs = json.loads(self.download(remote["revision_id"]).decode("utf-8"))
        # The app writes this file too: merge under its lock, from what is on disk now.
        with store._lock:
            mine_bytes = target.read_bytes()
            merged = merge_state(base, json.loads(mine_bytes.decode("utf-8")), theirs)
            atomic_write_json(target, merged)
        key = self.key(account, relative)
        # The merged file is a new local version of the cloud head.
        self.save(key, {"resource_id": remote["id"], "version": remote["version"], "sha256": remote["sha256"], "deleted": False})
        if sha(self.read(target)) == remote["sha256"]:
            return {"status": "unchanged"}
        return self.push(relative, remote)

    def resolve_both_changed(self, account, relative, current, summary):
        """This device and the cloud both changed a file since they last agreed."""
        if relative == STATE_FILE:
            try:
                result = self.merge_state_file(account, relative, current)
            except (ValueError, UnicodeDecodeError) as error:
                summary["errors"].append({"path": relative, "detail": f"The workspace metadata could not be merged: {error}"})
                return
            summary["merged"].append(relative)
            summary["uploaded"] += result.get("status") == "committed"
            if result.get("status") == "conflict":
                summary["conflicts"].append(relative)
            return
        copy = self.keep_both(account, relative, current)
        summary["preserved"].append(copy)
        summary["downloaded"] += 1
        summary["uploaded"] += 1

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
                        fromfile="Cloud version", tofile="This device", n=3))[:100000]
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
                # Write the copy where the cloud published it: under another name the
                # next pass would download it twice and report the tracked copy missing.
                copy = self.path(result["result"]["path"]) if (result.get("result") or {}).get("path") else conflict_copy(target)
                if not copy.exists():
                    self.write_remote(copy, snapshot, None)
                elif sha(self.read(copy)) != sha(snapshot):
                    raise CloudError(409, "The conflict copy exists with different content. Rename it before trying again.")
                self.save(self.key(account, copy.relative_to(self.root).as_posix()), {
                    "resource_id": result["result"]["id"], "version": result["result_version"],
                    "sha256": sha(snapshot), "deleted": False})
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
