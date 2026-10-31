"""Atelier: code folders, Git views, the code map and agent conversations in worktrees."""
import subprocess
from pathlib import Path

import pytest

from app.core.agents import mcp_server as agent_mcp


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


def code_of(client, session_id):
    return client.get(f"/api/atelier/conversations/{session_id}/code").json()


def test_conversation_in_worktree(client, project, repository, agent, conversation):
    """Any conversation can be given a project's code: it changes it in a worktree, with Kavot's MCP tools."""
    base = f"/api/atelier/projects/{project['id']}"
    folder = client.post(f"{base}/folders", json={"path": str(repository)}).json()
    agent.edits = {0: {"pkg/util.py": "def helper():\n    return 3\n", "added.py": "X = 1\n"}}

    session_id = conversation()
    run = agent.say(client, session_id, "Return 3", project_id=project["id"], code_folder_ids=[folder["id"]])
    assert run["status"] == "completed" and run["usage"]["input"] == 120
    space, command = agent.last["space"], agent.last["command"]
    assert space.write and space.cwd == space.writable[0], "The conversation runs in its main worktree"
    assert "Exception to the read-only rule" in agent.last["prompt"] and "kavot/agent/" in agent.last["prompt"]
    # MCP tool guidance stays on the MCP server's own instructions, not repeated in every user message.
    assert "get_context" not in agent.last["prompt"] and "get_context" in agent_mcp.INSTRUCTIONS, "The agent gets Kavot's MCP tools"
    assert command[command.index("--tools") + 1].endswith("Edit,Write")

    code = code_of(client, session_id)
    assert code["status"] == "review" and code["worktree_exists"]
    assert {f["path"] for f in code["files"]} == {"pkg/util.py", "added.py"}
    session = client.get(f"/api/external-agents/sessions/{session_id}").json()
    assert session["project_id"] == project["id"] and session["usage"]["cache_read"] == 400
    assert [m["role"] for m in session["messages"]] == ["user", "assistant"]
    assert (repository / "pkg" / "util.py").read_text().endswith("return 1\n"), "The checkout must stay untouched"
    assert {f["path"] for f in client.get(f"/api/atelier/conversations/{session_id}/diff").json()["files"]} == {"pkg/util.py", "added.py"}
    assert client.delete(f"/api/external-agents/sessions/{session_id}").status_code == 409, "Changes to review are kept"
    assert client.delete(f"{base}/folders/{folder['id']}").status_code == 409, "A folder with changes to review stays linked"

    # The next message continues in the same worktree, and /plan only reads.
    agent.edits = {}
    agent.say(client, session_id, "Explain the change", mode="answer")
    assert agent.last["vendor_id"] == "vendor-session" and agent.last["space"].cwd == space.cwd
    assert not agent.last["space"].write and "Edit" not in agent.last["command"][agent.last["command"].index("--tools") + 1]
    assert code_of(client, session_id)["status"] == "review", "Earlier changes stay to review"

    accepted = client.post(f"/api/atelier/conversations/{session_id}/accept", json={"message": "Return 3", "merge": True}).json()
    assert accepted["status"] == "merged" and not accepted["worktree_exists"]
    assert (repository / "added.py").is_file()
    assert git(repository, "log", "-1", "--format=%s").strip() == "Return 3"
    assert [item["id"] for item in client.get(base).json()["conversations"]] == [session_id]

    second = conversation(project["id"])
    agent.say(client, second, "Try something", code_folder_ids=[folder["id"]])
    branch = code_of(client, second)["workspaces"][0]["branch"]
    discarded = client.post(f"/api/atelier/conversations/{second}/discard").json()
    assert discarded["status"] == "discarded" and not discarded["worktree_exists"]
    assert branch not in git(repository, "branch", "--list")
    assert client.delete(f"/api/external-agents/sessions/{second}").status_code == 204
    assert [item["id"] for item in client.get(f"/api/external-agents/sessions?project_id={project['id']}").json()] == [session_id]


def test_conversation_on_several_folders(client, project, repository, tmp_path, agent, conversation):
    frontend = make_repository(tmp_path / "front", {"index.ts": "export const a = 1;\n"})
    docs = make_repository(tmp_path / "docs", {"README.md": "# Docs\n"})
    base = f"/api/atelier/projects/{project['id']}"
    api = client.post(f"{base}/folders", json={"path": str(repository), "name": "API"}).json()
    front = client.post(f"{base}/folders", json={"path": str(frontend), "name": "Frontend"}).json()
    doc = client.post(f"{base}/folders", json={"path": str(docs), "name": "Docs"}).json()
    # The agent changes the API and the frontend, not the docs.
    agent.edits = {0: {"pkg/util.py": "def helper():\n    return 4\n"}, 1: {"index.ts": "export const a = 2;\n"}}

    session_id = conversation(project["id"])
    agent.say(client, session_id, "Both sides", code_folder_ids=[api["id"], front["id"], doc["id"]])
    code = code_of(client, session_id)
    assert [space["name"] for space in code["workspaces"]] == ["API", "Frontend", "Docs"]
    assert all(space["open"] and space["branch"] == code["workspaces"][0]["branch"] for space in code["workspaces"])
    command = agent.last["command"]
    assert command.count("--add-dir") == 2, "The other worktrees are opened to the agent"
    changes = {item["name"]: [f["path"] for f in item["files"]] for item in client.get(f"/api/atelier/conversations/{session_id}/diff").json()["folders"]}
    assert changes == {"API": ["pkg/util.py"], "Frontend": ["index.ts"], "Docs": []}

    merged = client.post(f"/api/atelier/conversations/{session_id}/accept", json={"message": "Both sides", "merge": True}).json()
    assert merged["status"] == "merged"
    assert (frontend / "index.ts").read_text() == "export const a = 2;\n"
    assert git(frontend, "log", "-1", "--format=%s").strip() == "Both sides"
    assert git(docs, "log", "-1", "--format=%s").strip() == "First commit"
    assert code["workspaces"][0]["branch"] not in git(docs, "branch", "--list"), "A folder without changes keeps no branch"
    # The diff of merged changes comes from each folder's commit.
    after = {item["name"]: [f["path"] for f in item["files"]] for item in client.get(f"/api/atelier/conversations/{session_id}/diff").json()["folders"]}
    assert after == {"API": ["pkg/util.py"], "Frontend": ["index.ts"], "Docs": []}

    # Giving code again starts a new round, on a new branch, in the same working folder.
    agent.edits = {0: {"pkg/util.py": "def helper():\n    return 5\n"}}
    agent.say(client, session_id, "Again", code_folder_ids=[api["id"]])
    again = code_of(client, session_id)
    assert again["status"] == "review" and again["workspaces"][0]["branch"].endswith("-1")
    assert agent.last["space"].cwd == agent.calls[0]["space"].cwd
    client.post(f"/api/atelier/conversations/{session_id}/discard")


def test_mcp_with_code(project, agent):
    """The CLI of a code conversation gets Kavot's MCP server next to its file tools."""
    from app.core.agents import mcp_server, sessions
    from app.core.agents.workspace import Workspace
    space = Workspace(cwd="/tmp/main", write=True, writable=["/tmp/main", "/tmp/other"], readable=["/tmp/data"])
    for engine in ("claude", "codex", "opencode"):
        run = {"id": "r1", "engine": engine}
        command, environment = sessions._cli_command(run, engine, {"model": "", "effort": ""}, None, "Hello", "Title", space)
        command = mcp_server.configure_client(engine, command, environment, mcp_server.Connection("http://127.0.0.1:1/mcp", "token"))
        if engine == "claude":
            assert "mcp__kavot__*" in command[command.index("--allowedTools") + 1]
            assert command[command.index("--tools") + 1] == "Read,Glob,Grep,WebSearch,WebFetch,Edit,Write"
            assert [command[i + 1] for i, part in enumerate(command) if part == "--add-dir"] == ["/tmp/other", "/tmp/data"]
        elif engine == "codex":
            assert any("writable_roots" in part and "/tmp/other" in part for part in command)
            assert any(part.startswith("mcp_servers.kavot.url=") for part in command)
        else:
            import json
            permission = json.loads(environment["OPENCODE_PERMISSION"])
            assert permission["edit"] == "allow" and permission["kavot_*"] == "allow" and permission["external_directory"] == "allow"
            run.get("request_path") and run["request_path"].unlink(missing_ok=True)


def test_usage_meter():
    from app.core.agents.usage import Meter
    codex = Meter("codex")
    codex.feed({"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 4, "output_tokens": 3}})
    assert (codex.value()["input"], codex.value()["cache_read"], codex.value()["output"], codex.value()["turns"]) == (6, 4, 3, 1)
    # A resumed thread reports its running total: the message costs the difference.
    resumed = Meter("codex", codex.cumulative)
    resumed.feed({"type": "turn.completed", "usage": {"input_tokens": 25, "cached_input_tokens": 12, "output_tokens": 5}})
    assert (resumed.value()["input"], resumed.value()["cache_read"], resumed.value()["output"]) == (7, 8, 2)
    fresh = Meter("codex", resumed.cumulative)
    fresh.feed({"type": "turn.completed", "usage": {"input_tokens": 5, "output_tokens": 2}})
    assert (fresh.value()["input"], fresh.value()["output"]) == (5, 2), "A smaller total starts a new thread"
    opencode = Meter("opencode")
    opencode.feed({"type": "step_finish", "part": {"tokens": {"input": 7, "output": 1, "cache": {"read": 2}}, "cost": 0.5}})
    assert opencode.value()["cost_usd"] == 0.5 and opencode.value()["cache_read"] == 2
    claude = Meter("claude")
    claude.feed({"type": "assistant", "message": {"id": "a", "usage": {"input_tokens": 3, "output_tokens": 1}}})
    claude.feed({"type": "assistant", "message": {"id": "a", "usage": {"input_tokens": 3, "output_tokens": 2}}})
    assert claude.value()["output"] == 2 and claude.value()["turns"] == 1, "A streamed message is counted once"


def test_legacy_runs_are_deleted(client, project, repository):
    """Runs of the first Atelier are removed with their worktree; a committed branch stays."""
    from app.core.kernel.files import read_json_object
    from app.plugins.atelier import agents, store
    folder = client.post(f"/api/atelier/projects/{project['id']}/folders", json={"path": str(repository)}).json()
    worktree = store.worktrees() / "legacy0001"
    git(repository, "worktree", "add", "-q", "-b", "kavot/agent/legacy0001", str(worktree), "HEAD")
    git(repository, "branch", "kavot/agent/legacy0002")
    doc = store.read(project["id"])
    doc["runs"] = [{"id": "legacy0001", "status": "review", "folder_id": folder["id"], "branch": "kavot/agent/legacy0001", "worktree": str(worktree)},
                   {"id": "legacy0002", "status": "accepted", "workspaces": [{"folder_id": folder["id"], "branch": "kavot/agent/legacy0002",
                                                                              "worktree": None, "commit": "abc"}]}]
    store.write(project["id"], doc)
    agents.drop_legacy_runs()
    assert "runs" not in read_json_object(store._path(project["id"]))
    assert not worktree.exists()
    branches = git(repository, "branch", "--list")
    assert "legacy0001" not in branches and "legacy0002" in branches
