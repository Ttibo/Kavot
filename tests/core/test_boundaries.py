"""The core may only depend on plugins where a coupling is still listed here.

Each entry is debt to remove by moving the code behind a registry. The test
fails when a new coupling appears, and when one listed here disappears (so the
list shrinks with the code).
"""
import ast
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# (core module, plugin): number of import statements.
KNOWN = {
    ("app/core/agents/context.py", "papers"): 2,      # article sources and citation graph in the chat context
    ("app/core/agents/context.py", "planning"): 1,    # displayed calendar events
    ("app/core/agents/organization.py", "papers"): 3,  # paper folders and paper_* organization actions
    ("app/core/agents/organization.py", "planning"): 1,
    ("app/core/agents/organization.py", "research"): 1,
    ("app/core/automation/watchers.py", "papers"): 1,  # library watches
    ("app/core/automation/workflows.py", "papers"): 1,  # paper_folder / paper_folder_file blocks
    ("app/core/automation/workflows.py", "planning"): 2,  # task output block
    ("app/core/kernel/system.py", "papers"): 1,        # dashboard and demo workspace
    ("app/core/kernel/system.py", "planning"): 1,
    ("app/core/workspace/documents.py", "papers"): 2,  # reading notes stored next to their article
    ("app/core/workspace/html_documents.py", "papers"): 1,
}


def core_to_plugin_imports() -> Counter:
    found = Counter()
    for path in (ROOT / "app" / "core").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("app.plugins."):
                found[(path.relative_to(ROOT).as_posix(), node.module.split(".")[2])] += 1
    return found


def test_core_plugin_couplings_are_known():
    assert dict(core_to_plugin_imports()) == KNOWN


def test_research_is_fully_behind_registries():
    assert not any(plugin == "research" and "organization" not in module for module, plugin in core_to_plugin_imports())


def test_api_routes_of_the_core_import_no_plugin():
    for path in (ROOT / "app" / "api").rglob("*.py"):
        assert "app.plugins" not in path.read_text(encoding="utf-8"), path
