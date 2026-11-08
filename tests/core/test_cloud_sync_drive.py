"""The workspace syncs like a drive: two devices against one cloud (an in-memory fake of its API and S3)."""
import hashlib
import json
import time
import uuid

import httpx
import pytest

from app.core.storage.cloud_sync.client import LocalSync


class FakeCloud:
    """Heads per path, immutable revisions, transfers committed against a base version."""

    def __init__(self):
        self.heads, self.blobs, self.transfers, self.revision = {}, {}, {}, 0

    def api(self, request: httpx.Request) -> httpx.Response:
        path, body = request.url.path.removeprefix("/api/cloud"), json.loads(request.content or b"null")
        if path == "/me":
            return httpx.Response(200, json={"id": "account-1"})
        if path == "/sync/changes":
            return httpx.Response(200, json={"revision": f"r{self.revision}"})
        if path == "/sync/manifest":
            return httpx.Response(200, json=[head for head in self.heads.values() if head["version"]])
        if path.startswith("/sync/resources/"):
            resource_id = path.split("/")[3]
            head = next((item for item in self.heads.values() if item["id"] == resource_id), None)
            if not head:
                return httpx.Response(404, json={"detail": "Not found"})
            if path.endswith("/delete"):
                if body["expected_version"] != head["version"]:
                    return httpx.Response(409, json={"detail": "Stale", "current": head})
                head.update(version=head["version"] + 1, deleted_at=time.time())
                self.revision += 1
            return httpx.Response(200, json=head)
        if path == "/sync/transfers":
            transfer_id = str(uuid.uuid4())
            self.transfers[transfer_id] = body
            return httpx.Response(200, json={"transfer_id": transfer_id, "status": "pending",
                                             "upload": {"url": f"https://s3.test/{transfer_id}", "headers": {}}})
        if path.endswith("/complete"):
            transfer = self.transfers[path.split("/")[3]]
            head = self.heads.get(transfer["path"])
            if head and head["version"] != transfer["base_version"] and not head.get("deleted_at"):
                return httpx.Response(409, json={"transfer_id": path.split("/")[3], "status": "conflict", "current": head})
            revision_id = str(uuid.uuid4())
            self.blobs[revision_id] = self.blobs.pop(f"upload:{path.split('/')[3]}")
            version = (head["version"] if head else 0) + 1
            self.heads[transfer["path"]] = {
                "id": head["id"] if head else transfer["resource_id"], "path": transfer["path"], "version": version,
                "sha256": transfer["sha256"], "size": transfer["size"], "revision_id": revision_id,
                "modified_at": transfer["modified_at"], "deleted_at": None}
            self.revision += 1
            return httpx.Response(200, json={"status": "committed", "result_version": version, "sha256": transfer["sha256"]})
        if path.startswith("/sync/revisions/"):
            revision_id = path.split("/")[3]
            data = self.blobs[revision_id]
            return httpx.Response(200, json={"url": f"https://s3.test/blob/{revision_id}", "size": len(data),
                                             "sha256": hashlib.sha256(data).hexdigest()})
        return httpx.Response(404, json={"detail": f"No route {path}"})

    def s3(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.strip("/")
        if request.method == "PUT":
            self.blobs[f"upload:{name}"] = request.read()
            return httpx.Response(200)
        return httpx.Response(200, content=self.blobs[name.removeprefix("blob/")])


class Vault:
    def get(self):
        return "token"


@pytest.fixture
def cloud():
    return FakeCloud()


def device(cloud, tmp_path, name):
    root = tmp_path / name
    root.mkdir()
    return LocalSync("https://cloud.test", root, tmp_path / f"{name}.sqlite", vault=Vault(),
                     api_transport=httpx.MockTransport(cloud.api), s3_transport=httpx.MockTransport(cloud.s3))


def write(sync, relative, text):
    path = sync.root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def files(sync):
    return {path.relative_to(sync.root).as_posix(): path.read_text(encoding="utf-8")
            for path in sync.root.rglob("*") if path.is_file() and ".kavot-conflicts" not in path.parts}


def test_files_travel_between_devices_and_system_files_stay(cloud, tmp_path):
    laptop, desktop = device(cloud, tmp_path, "laptop"), device(cloud, tmp_path, "desktop")
    write(laptop, "notes/general/idea.html", "<p>Idea</p>")
    write(laptop, "notes/general/~$report.docx", "lock")
    write(laptop, ".DS_Store", "finder")
    laptop.sync_workspace()
    desktop.sync_workspace()
    assert files(desktop) == {"notes/general/idea.html": "<p>Idea</p>"}


def test_a_file_changed_on_both_devices_keeps_both_versions(cloud, tmp_path):
    laptop, desktop = device(cloud, tmp_path, "laptop"), device(cloud, tmp_path, "desktop")
    write(laptop, "notes/general/plan.html", "v1")
    laptop.sync_workspace(); desktop.sync_workspace()
    write(laptop, "notes/general/plan.html", "laptop edit")
    laptop.sync_workspace()
    write(desktop, "notes/general/plan.html", "desktop edit")
    summary = desktop.sync_workspace()
    laptop.sync_workspace()
    for sync in (laptop, desktop):
        contents = files(sync)
        assert contents["notes/general/plan.html"] == "laptop edit"
        copies = [path for path in contents if "conflict copy" in path]
        assert len(copies) == 1 and contents[copies[0]] == "desktop edit"
    assert summary["preserved"] and not summary["conflicts"]


def test_metadata_edited_on_both_devices_merges(cloud, tmp_path):
    laptop, desktop = device(cloud, tmp_path, "laptop"), device(cloud, tmp_path, "desktop")
    base = {"notes": [{"id": 1, "title": "Intro"}, {"id": 2, "title": "Methods"}]}
    write(laptop, "kavot.state.json", json.dumps(base))
    laptop.sync_workspace(); desktop.sync_workspace()
    write(laptop, "kavot.state.json", json.dumps({"notes": [{"id": 1, "title": "Intro v2"}, {"id": 2, "title": "Methods"}]}))
    laptop.sync_workspace()
    write(desktop, "kavot.state.json", json.dumps({"notes": [{"id": 1, "title": "Intro"}, {"id": 2, "title": "Methods v2"}]}))
    summary = desktop.sync_workspace()
    laptop.sync_workspace()
    assert summary["merged"] == ["kavot.state.json"]
    for sync in (laptop, desktop):
        state = json.loads((sync.root / "kavot.state.json").read_text(encoding="utf-8"))
        assert [note["title"] for note in state["notes"]] == ["Intro v2", "Methods v2"]
        assert not any("conflict copy" in path for path in files(sync))


def test_many_deletions_wait_for_a_confirmation(cloud, tmp_path):
    laptop, desktop = device(cloud, tmp_path, "laptop"), device(cloud, tmp_path, "desktop")
    for number in range(12):
        write(laptop, f"notes/general/note-{number}.html", str(number))
    laptop.sync_workspace(); desktop.sync_workspace()
    for path in (laptop.root / "notes" / "general").iterdir():
        path.unlink()
    summary = laptop.sync_workspace()
    assert summary["held_deletions"] == 12
    desktop.sync_workspace()
    assert len(files(desktop)) == 12  # nothing spread while waiting
    laptop.confirm_deletions()
    laptop.sync_workspace(); desktop.sync_workspace()
    assert files(desktop) == {}
