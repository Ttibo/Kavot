"""The sidebar tree: notes by workspace and folder, project files, the article library and the trash."""
from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.core.kernel.config import settings
from app.core.kernel.files import read_json_object, safe_name
from app.core.projects import projects
from app.core.records.repository import store
from app.core.workspace.documents import folder_parts, note_path


def _note_node(note: dict[str, Any], path: str) -> dict[str, Any]:
    kind = "drawing" if note.get("drawing") else "markdown"
    return {"name": note["file_name"], "label": note["title"], "path": path, "kind": kind, "type": kind, "note_id": note["id"], "project_id": note.get("project_id"), "root": False, "protected": note.get("system_kind") == "project_home", "url": f"/api/workspace/file?path={quote(path, safe='')}"}


def _file_node(path: Path, virtual_path: str, *, protected: bool = False) -> dict[str, Any]:
    suffix = path.suffix.lower()
    kind = "canvas" if suffix == ".canvas" else "image" if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"} else "pdf" if suffix == ".pdf" else "video" if suffix in {".mp4", ".webm", ".ogv", ".mov"} else "audio" if suffix in {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"} else "markdown" if suffix in {".md", ".txt", ".html"} else "file"
    return {"name": path.name, "label": path.stem, "path": virtual_path, "kind": kind, "type": kind, "root": False, "protected": protected, "url": f"/api/workspace/file?path={quote(virtual_path, safe='')}"}


class _Tree:
    """One build of the tree: each note's path is computed (and resolved) once.

    The sidebar reloads the tree after every change, so a build must not cost
    one pass over all notes per article, folder or assets directory.
    """

    def __init__(self, state: dict[str, Any]):
        self.state = state
        self._paths: dict[Any, Path] = {}
        self._resolved: dict[Any, Path] = {}
        self._asset_notes: dict[Path, dict[str, Any]] | None = None

    def path(self, note: dict[str, Any]) -> Path:
        if note["id"] not in self._paths:
            self._paths[note["id"]] = note_path(note, self.state)
        return self._paths[note["id"]]

    def resolved(self, note: dict[str, Any]) -> Path:
        if note["id"] not in self._resolved:
            self._resolved[note["id"]] = self.path(note).resolve()
        return self._resolved[note["id"]]

    def asset_directories(self, root: Path, prefix: str) -> list[dict[str, Any]]:
        assets = root / "assets"
        if not assets.is_dir() or assets.is_symlink():
            return []
        return [self.asset_directory(assets, f"{prefix}/assets")]

    def asset_directory(self, path: Path, virtual_path: str) -> dict[str, Any]:
        """Expose attachments and registered OCR notes together in their assets folder."""
        if self._asset_notes is None:
            self._asset_notes = {self.path(note): note for note in self.state["notes"]
                                 if note.get("source_image_path") and not note.get("trashed_at")}
        children: list[dict[str, Any]] = []
        for entry in sorted(path.iterdir(), key=lambda value: (not value.is_dir(), value.name.casefold())):
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            entry_path = f"{virtual_path}/{entry.name}"
            if entry.is_dir():
                children.append(self.asset_directory(entry, entry_path))
            elif entry.is_file():
                note = self._asset_notes.get(entry.resolve())
                children.append(_note_node(note, entry_path) if note else _file_node(entry, entry_path, protected=True))
        return {
            "name": path.name,
            "label": "Assets" if path.name == "assets" else path.name,
            "path": virtual_path,
            "kind": "directory",
            "root": False,
            "protected": True,
            "asset_directory": True,
            "children": children,
        }

    @staticmethod
    def extra_files(root: Path, prefix: str, known: set[Path]) -> list[dict[str, Any]]:
        if not root.is_dir():
            return []
        return [
            _file_node(path, f"{prefix}/{path.name}")
            for path in sorted(root.iterdir(), key=lambda value: value.name.casefold())
            if not path.name.startswith(".") and path.is_file() and path.resolve() not in known
        ]

    def folder_tree(self, notes: list[dict[str, Any]], project_id: int | None, root: Path, prefix: str) -> list[dict[str, Any]]:
        state = self.state
        folders = [item for item in state["note_folders"] if item.get("project_id") == project_id]
        nodes: dict[int, dict[str, Any]] = {}
        folder_paths: dict[int, list[str]] = {}
        for folder in folders:
            parts = folder_paths[folder["id"]] = [safe_name(part, "folder") for part in folder_parts(state, folder["id"])]
            nodes[folder["id"]] = {
                "name": safe_name(folder["name"], "folder"), "label": folder["name"], "path": f"{prefix}/{'/'.join(parts)}",
                "kind": "directory", "root": False, "protected": False, "folder_id": folder["id"],
                "color": folder.get("color"),
                "creation_context": {"project_id": project_id, "folder_id": folder["id"]}, "children": [],
            }
        top: list[dict[str, Any]] = []
        for folder in folders:
            node = nodes[folder["id"]]
            parent = nodes.get(folder.get("parent_id"))
            (parent["children"] if parent else top).append(node)
        known = {self.resolved(item) for item in notes}
        for note in notes:
            if note.get("source_image_path") and '/assets/' in note['source_image_path']:
                continue
            node = _note_node(note, self.path(note).relative_to(settings.storage_path).as_posix())
            folder = nodes.get(note.get("folder_id"))
            (folder["children"] if folder else top).append(node)
            for folder_id in note.get("zotero_folder_ids") or []:
                if folder_id != note.get("folder_id") and folder_id in nodes:
                    nodes[folder_id]["children"].append({**node, "shortcut": True})
        for folder in folders:
            node = nodes[folder["id"]]
            folder_root = root.joinpath(*folder_paths[folder["id"]])
            node["children"].extend(self.extra_files(folder_root, node["path"], known))
            node["children"].extend(self.asset_directories(folder_root, node["path"]))
        top.extend(self.extra_files(root, prefix, known))
        top.extend(self.asset_directories(root, prefix))
        return top


def workspace_tree() -> list[dict[str, Any]]:
    state = store.read()
    tree = _Tree(state)
    live_notes = [item for item in state["notes"] if not item.get("trashed_at")]
    general_notes = [item for item in live_notes if not item.get("project_id") and not item.get("paper_id")]
    general_children = tree.folder_tree(general_notes, None, settings.notes_path / "general", "notes/general")
    general_children = [node for node in general_children if node["name"] != "general-review.generated.html"]
    general = {"name": "general", "label": "General", "path": "notes/general", "kind": "directory", "root": False, "protected": True, "creation_context": {"project_id": None, "folder_id": None}, "children": general_children}
    project_nodes = []
    for project in state["projects"]:
        if project.get("status") == "archived":
            continue
        project_dir = projects.directory(project).name
        note_dir = f"notes/projects/{project_dir}"
        project_notes = [item for item in live_notes if item.get("project_id") == project["id"]]
        canvas_path = f"projects/{project_dir}/{projects.CANVAS}"
        children = [{"name": projects.CANVAS, "label": "Project canvas", "path": canvas_path, "kind": "canvas", "type": "canvas", "project_id": project["id"], "root": False, "protected": True, "url": f"/api/workspace/file?path={quote(canvas_path, safe='')}"}]
        children.extend(tree.asset_directories(projects.directory(project), f"projects/{project_dir}"))
        children.extend(tree.folder_tree(project_notes, project["id"], settings.notes_path / "projects" / project_dir, note_dir))
        project_nodes.append({"name": project_dir, "label": project["name"], "path": note_dir, "kind": "directory", "root": False, "protected": True, "project_id": project["id"], "color": project.get("color"), "creation_context": {"project_id": project["id"], "folder_id": None}, "children": children})
    project_root = {"name": "projects", "label": "Projects", "path": "notes/projects", "kind": "directory", "root": False, "protected": True, "children": project_nodes}
    paper_nodes = []
    library_folders = {
        folder["id"]: {"name": folder["name"], "label": folder["name"],
                       "path": f"notes/library/folder-{folder['id']}", "kind": "directory",
                       "protected": True, "virtual_paper_folder": True,
                       "paper_folder_id": folder["id"], "children": []}
        for folder in state.get("paper_folders", [])
    }
    for folder in state.get("paper_folders", []):
        node = library_folders[folder["id"]]
        parent = library_folders.get(folder.get("parent_id"))
        (parent["children"] if parent else paper_nodes).append(node)
    known_note_files = None
    notes_by_paper: dict[Any, list[dict[str, Any]]] = {}
    for note in live_notes:
        if note.get("paper_id"):
            notes_by_paper.setdefault(note["paper_id"], []).append(note)
    from app.plugins.papers.library import local_pdf_path, paper_directory, paper_folder_ids
    unfiled = {"name": "unfiled", "label": "Unfiled", "path": "notes/library/unfiled",
               "kind": "directory", "protected": True, "virtual_paper_folder": True, "children": []}
    for paper in state["papers"]:
        article_children = []
        pdf = local_pdf_path(paper)
        if pdf:
            path = f"library/{pdf.parent.name}/paper.pdf"
            article_children.append({"name": "paper.pdf", "label": "PDF", "path": path, "kind": "pdf", "type": "pdf", "paper_id": paper["id"], "root": False, "protected": True, "url": f"/api/papers/{paper['id']}/file"})
        for note in notes_by_paper.get(paper["id"], []):
            path = tree.path(note)
            article_children.append(_note_node(note, f"library/{path.parent.name}/{path.name}"))
        article_root = pdf.parent if pdf else paper_directory(paper)
        if article_root:
            if known_note_files is None:
                known_note_files = {tree.resolved(note) for note in state['notes']}
            # The PDF is listed above and metadata.kavot.json is internal: show only the user's other files.
            hidden = {"metadata.kavot.json", pdf.name if pdf else None}
            article_children.extend(node for node in tree.extra_files(article_root, f"library/{article_root.name}", known_note_files) if node["name"] not in hidden)
            article_children.extend(tree.asset_directories(article_root, f"library/{article_root.name}"))
        destinations = [library_folders[value] for value in paper_folder_ids(paper) if value in library_folders] or [unfiled]
        for folder in destinations:
            folder["children"].append({"name": f"paper-{paper['id']}", "label": paper["title"], "path": f"library/paper-{paper['id']}", "kind": "directory", "paper_id": paper["id"], "has_pdf": any(child.get("kind") == "pdf" for child in article_children), "root": False, "protected": True, "children": article_children})
    if unfiled["children"]:
        paper_nodes.append(unfiled)
    library = {"name": "library", "label": "Article library", "path": "notes/library", "kind": "directory", "root": False, "protected": True, "children": paper_nodes, "paper_count": len(state["papers"])}
    trash_items = [{"name": item["file_name"], "label": item["title"], "path": f"trash/{item['trash_id']}", "kind": "markdown", "trash_id": item["trash_id"], "trashed": True, "root": False, "children": []} for item in state["notes"] if item.get("trashed_at")]
    trash_root = settings.notes_path / ".trash"
    if trash_root.is_dir():
        for entry in sorted(trash_root.iterdir(), key=lambda value: value.name.casefold()):
            metadata_path = entry / "trash.kavot.json"
            metadata = read_json_object(metadata_path) if metadata_path.is_file() else None
            if not metadata:
                continue
            source = next((item for item in entry.iterdir() if item.name != metadata_path.name), None)
            if not source:
                continue
            trash_items.append({
                "name": source.name,
                "label": metadata.get("name") or source.name,
                "path": f"trash/{entry.name}",
                "kind": "directory" if source.is_dir() else _file_node(source, "")["kind"],
                "trash_id": entry.name,
                "trashed": True,
                "root": False,
                "children": [],
            })
    return [
        {"name": "notes", "label": "Notes", "path": "notes", "kind": "directory", "root": True, "protected": True, "children": [general, project_root, library]},
        {"name": "trash", "label": "Trash", "path": "trash", "kind": "directory", "root": True, "protected": True, "children": trash_items},
    ]
