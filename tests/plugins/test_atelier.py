"""Atelier: code folders, Git views, the code map and agent runs in worktrees."""
import subprocess
from pathlib import Path

import pytest


def git(folder: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(folder), "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
                          capture_output=True, text=True, check=True).stdout


def make_repository(folder: Path, files: dict[str, str]) -> Path:
    for name, content in files.items():
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(content)
    git(folder, "init", "-q", "-b", "main")
    git(folder, "add", ".")
    git(folder, "commit", "-q", "-m", "First commit")
    return folder


@pytest.fixture()
def repository(tmp_path):
    return make_repository(tmp_path / "repo", {
        "pkg/__init__.py": "",
        "pkg/util.py": '"""Helpers."""\n\ndef helper():\n    return 1\n',
        "pkg/main.py": "from pkg.util import helper\n\n\ndef run():\n    return helper()\n",
        "web/app.ts": "import { view } from './view';\nexport function start() { view(); }\n",
        "web/view.ts": "export const view = () => 1;\n",
    })


@pytest.fixture()
def project(client):
    return client.post("/api/projects", json={"name": "Atelier test"}).json()


def test_folders_git_and_map(client, project, repository):
    base = f"/api/atelier/projects/{project['id']}"
    folder = client.post(f"{base}/folders", json={"path": str(repository), "name": "Backend"}).json()
    assert folder["name"] == "Backend"
    assert folder["is_git"] and folder["branch"] == "main" and folder["commits"][0]["subject"] == "First commit"
    assert client.post(f"{base}/folders", json={"path": str(repository)}).status_code == 409

    overview = client.get(base).json()
    assert [item["id"] for item in overview["folders"]] == [folder["id"]]

    tree = client.get(f"{base}/folders/{folder['id']}/tree").json()
    assert {entry["name"] for entry in tree["entries"]} == {"pkg", "web"}
    assert client.get(f"{base}/folders/{folder['id']}/file", params={"path": "../outside"}).status_code == 422

    (repository / "pkg" / "util.py").write_text('"""Helpers."""\n\ndef helper():\n    return 2\n')
    (repository / "notes.txt").write_text("new")
    changes = {item["path"]: item for item in client.get(f"{base}/folders/{folder['id']}/changes").json()["files"]}
    assert changes["pkg/util.py"]["additions"] == 1 and changes["notes.txt"]["status"] == "untracked"

    sha = client.get(f"{base}/folders/{folder['id']}/log").json()[0]["sha"]
    shown = client.get(f"{base}/folders/{folder['id']}/commits/{sha}").json()
    assert shown["message"] == "First commit" and len(shown["files"]) == 5

    code_map = client.get(f"{base}/folders/{folder['id']}/map").json()
    files = {item["path"]: item for item in code_map["files"]}
    assert files["pkg/main.py"]["imports"] == ["pkg/util.py"]
    assert files["web/app.ts"]["imports"] == ["web/view.ts"]
    run_symbol = next(s for s in files["pkg/main.py"]["symbols"] if s["name"] == "run")
    assert run_symbol["calls"] == ["pkg/util.py#helper"]
    assert files["pkg/util.py"]["symbols"][0]["called_by"] == ["pkg/main.py#run"]

    assert client.delete(f"{base}/folders/{folder['id']}").status_code == 204
    assert client.get(base).json()["folders"] == []


def fake_agent(runs, edits):
    """An agent that writes `edits` ({workspace index: {path: content}}) and reports usage."""
    def execute(project_id, run, prompt, config):
        assert "Request" in prompt and "kavot/agent/" in prompt
        for index, files in edits.items():
            for name, content in files.items():
                Path(run["workspaces"][index]["worktree"], name).write_text(content)
        meter = runs.Meter("claude")
        meter.feed({"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 50, "output_tokens": 10}}})
        meter.feed({"type": "result", "usage": {"input_tokens": 120, "output_tokens": 30, "cache_read_input_tokens": 400},
                    "total_cost_usd": 0.012, "num_turns": 2, "duration_ms": 900})
        run["usage"] = runs._add(run.get("usage") or {}, meter.value())
        for space in run["workspaces"]:
            space["files"] = [{k: f[k] for k in ("path", "status", "additions", "deletions")} for f in runs._changes(Path(space["worktree"]))["files"]]
        runs._sync(run)
        run.update(status="review", response="Done.")
        with runs._lock:
            runs._live.pop(run["id"], None)
        runs._persist(project_id, run)
    return execute


def start_run(client, base, payload):
    response = client.post(f"{base}/runs", json={"engine": "claude", "prompt": "Return 3", **payload})
    assert response.status_code == 201, response.text
    for _ in range(100):
        current = client.get(f"{base}/runs/{response.json()['id']}").json()
        if current["status"] != "running":
            return current
    raise AssertionError("The run did not finish")


def test_run_in_worktree(client, project, repository, monkeypatch):
    from app.plugins.atelier import runs
    monkeypatch.setattr(runs, "_engine", lambda engine: {"model": "", "executable": ""})
    monkeypatch.setattr(runs, "_execute", fake_agent(runs, {0: {"pkg/util.py": "def helper():\n    return 3\n", "added.py": "X = 1\n"}}))
    base = f"/api/atelier/projects/{project['id']}"
    folder = client.post(f"{base}/folders", json={"path": str(repository)}).json()

    run = start_run(client, base, {"folder_id": folder["id"]})
    assert run["status"] == "review" and run["worktree_exists"]
    assert {f["path"] for f in run["files"]} == {"pkg/util.py", "added.py"}
    assert run["usage"]["input"] == 120 and run["usage"]["cache_read"] == 400 and run["usage"]["cost_usd"] == 0.012
    assert (repository / "pkg" / "util.py").read_text().endswith("return 1\n"), "The checkout must stay untouched"
    assert {f["path"] for f in client.get(f"{base}/runs/{run['id']}/diff").json()["files"]} == {"pkg/util.py", "added.py"}

    accepted = client.post(f"{base}/runs/{run['id']}/accept", json={"message": "Return 3", "merge": True}).json()
    assert accepted["status"] == "merged" and not accepted["worktree_exists"]
    assert (repository / "added.py").is_file()
    assert git(repository, "log", "-1", "--format=%s").strip() == "Return 3"

    second = start_run(client, base, {"folder_id": folder["id"]})
    discarded = client.post(f"{base}/runs/{second['id']}/discard").json()
    assert discarded["status"] == "discarded" and not Path(second["worktree"]).exists()
    assert second["branch"] not in git(repository, "branch", "--list")
    assert client.delete(f"{base}/runs/{second['id']}").status_code == 204
    assert [r["id"] for r in client.get(f"{base}/runs").json()] == [run["id"]]


def test_run_on_several_folders(client, project, repository, tmp_path, monkeypatch):
    from app.plugins.atelier import runs
    frontend = make_repository(tmp_path / "front", {"index.ts": "export const a = 1;\n"})
    docs = make_repository(tmp_path / "docs", {"README.md": "# Docs\n"})
    monkeypatch.setattr(runs, "_engine", lambda engine: {"model": "", "executable": ""})
    # The agent changes the API and the frontend, not the docs.
    monkeypatch.setattr(runs, "_execute", fake_agent(runs, {0: {"pkg/util.py": "def helper():\n    return 4\n"}, 1: {"index.ts": "export const a = 2;\n"}}))
    base = f"/api/atelier/projects/{project['id']}"
    api = client.post(f"{base}/folders", json={"path": str(repository), "name": "API"}).json()
    front = client.post(f"{base}/folders", json={"path": str(frontend), "name": "Frontend"}).json()
    doc = client.post(f"{base}/folders", json={"path": str(docs), "name": "Docs"}).json()

    run = start_run(client, base, {"folder_id": api["id"], "extra_folder_ids": [front["id"], doc["id"]]})
    assert [space["name"] for space in run["workspaces"]] == ["API", "Frontend", "Docs"]
    assert all(space["open"] and space["branch"] == run["branch"] for space in run["workspaces"])
    changes = {item["name"]: [f["path"] for f in item["files"]] for item in client.get(f"{base}/runs/{run['id']}/diff").json()["folders"]}
    assert changes == {"API": ["pkg/util.py"], "Frontend": ["index.ts"], "Docs": []}
    assert client.delete(f"{base}/folders/{front['id']}").status_code == 409, "A folder in use by a run stays linked"

    merged = client.post(f"{base}/runs/{run['id']}/accept", json={"message": "Both sides", "merge": True}).json()
    assert merged["status"] == "merged"
    assert (frontend / "index.ts").read_text() == "export const a = 2;\n"
    assert git(frontend, "log", "-1", "--format=%s").strip() == "Both sides"
    assert git(docs, "log", "-1", "--format=%s").strip() == "First commit"
    assert run["branch"] not in git(docs, "branch", "--list"), "A folder without changes keeps no branch"
    # The diff of an accepted run comes from each folder's commit.
    after = {item["name"]: [f["path"] for f in item["files"]] for item in client.get(f"{base}/runs/{run['id']}/diff").json()["folders"]}
    assert after == {"API": ["pkg/util.py"], "Frontend": ["index.ts"], "Docs": []}


def test_usage_meter():
    from app.plugins.atelier.runs import Meter
    codex = Meter("codex")
    codex.feed({"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 4, "output_tokens": 3}})
    codex.feed({"type": "turn.completed", "usage": {"input_tokens": 5, "output_tokens": 2}})
    assert (codex.value()["input"], codex.value()["cache_read"], codex.value()["output"], codex.value()["turns"]) == (11, 4, 5, 2)
    opencode = Meter("opencode")
    opencode.feed({"type": "step_finish", "part": {"tokens": {"input": 7, "output": 1, "cache": {"read": 2}}, "cost": 0.5}})
    assert opencode.value()["cost_usd"] == 0.5 and opencode.value()["cache_read"] == 2
    claude = Meter("claude")
    claude.feed({"type": "assistant", "message": {"id": "a", "usage": {"input_tokens": 3, "output_tokens": 1}}})
    claude.feed({"type": "assistant", "message": {"id": "a", "usage": {"input_tokens": 3, "output_tokens": 2}}})
    assert claude.value()["output"] == 2 and claude.value()["turns"] == 1, "A streamed message is counted once"


def test_legacy_single_folder_run(client, project):
    """Runs saved before several folders existed still read and close."""
    from app.plugins.atelier import runs, store
    doc = store.read(project["id"])
    doc["runs"].insert(0, {"id": "legacy0001", "title": "Old", "status": "discarded", "engine": "claude", "model": "",
                           "folder_id": "x", "branch": "kavot/agent/legacy0001", "base_branch": "main", "base_sha": "0" * 40,
                           "worktree": None, "files": [], "commit": None, "merged": False, "messages": [], "events": []})
    store.write(project["id"], doc)
    listed = runs.listing({"id": project["id"]})[0]
    assert listed["workspaces"][0]["branch"] == "kavot/agent/legacy0001"
