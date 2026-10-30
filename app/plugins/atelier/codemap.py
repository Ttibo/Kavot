"""Static map of a code folder: files, their symbols, imports between files and calls.

The code is only parsed, never executed. Python uses `ast` (imports, definitions and
calls); JavaScript and TypeScript use import patterns and top-level declarations.
Parsed files are cached by size and modification time, so a rebuild only reads
what changed.
"""
from __future__ import annotations

import ast
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from app.core.projects import code as project_code

PYTHON = {".py"}
SCRIPT = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"}
LANGUAGES = {**{ext: "python" for ext in PYTHON}, **{ext: "typescript" if "t" in ext[1:3] else "javascript" for ext in SCRIPT}}
MAX_FILES = 4000
_cache: dict[tuple[str, str], tuple[tuple[int, int], dict[str, Any]]] = {}
_lock = threading.Lock()

JS_IMPORT = re.compile(r"""(?:\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+[\w*{}\s,$]+\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]""")
JS_SYMBOLS = [
    (re.compile(r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)", re.M), "function"),
    (re.compile(r"^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)", re.M), "class"),
    (re.compile(r"^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)", re.M), "function"),
    (re.compile(r"^(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)", re.M), "type"),
]


def _files(base: Path) -> tuple[list[Path], bool]:
    """Source files of the folder; in a Git repository, the ones Git does not ignore (no build output)."""
    listed = project_code.git(base, "ls-files", "--cached", "--others", "--exclude-standard", "-z", optional=True)
    if listed and project_code.inspect(str(base))["is_git"]:
        names = [name for name in listed.split("\0") if name and PurePosixPath(name).suffix.lower() in LANGUAGES
                 and not any(part.lower() in project_code.SKIP for part in PurePosixPath(name).parts)]
        paths = [base / name for name in sorted(set(names))]
        paths = [path for path in paths if path.is_file() and not path.is_symlink()]
        return paths[:MAX_FILES], len(paths) > MAX_FILES
    found: list[Path] = []
    for directory, folders, names in os.walk(base):
        folders[:] = sorted(f for f in folders if f.lower() not in project_code.SKIP and not f.startswith("."))
        for name in sorted(names):
            path = Path(directory) / name
            if path.suffix.lower() in LANGUAGES and not path.is_symlink():
                found.append(path)
                if len(found) >= MAX_FILES:
                    return found, True
    return found, False


def _python(source: str) -> dict[str, Any]:
    tree = ast.parse(source)
    imports: list[dict[str, Any]] = []
    symbols: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports += [{"module": alias.name, "level": 0, "names": []} for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            imports.append({"module": node.module or "", "level": node.level,
                            "names": [(alias.name, alias.asname or alias.name) for alias in node.names]})

    def calls(body: ast.AST) -> list[str]:
        names = set()
        for child in ast.walk(body):
            if isinstance(child, ast.Call):
                target = child.func
                if isinstance(target, ast.Name):
                    names.add(target.id)
                elif isinstance(target, ast.Attribute):
                    names.add(target.attr)
        return sorted(names)

    def visit(nodes, prefix=""):
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kind = "class" if isinstance(node, ast.ClassDef) else "method" if prefix else "function"
                symbols.append({"name": prefix + node.name, "kind": kind, "line": node.lineno,
                                "end": getattr(node, "end_lineno", node.lineno), "doc": (ast.get_docstring(node) or "").split("\n")[0][:200],
                                "raw_calls": [] if kind == "class" else calls(node)})
                if isinstance(node, ast.ClassDef):
                    visit(node.body, prefix + node.name + ".")
    visit(tree.body)
    return {"imports": imports, "symbols": symbols, "doc": (ast.get_docstring(tree) or "").split("\n")[0][:200]}


def _script(source: str) -> dict[str, Any]:
    symbols = []
    for pattern, kind in JS_SYMBOLS:
        for match in pattern.finditer(source):
            symbols.append({"name": match.group(1), "kind": kind, "line": source.count("\n", 0, match.start()) + 1, "raw_calls": []})
    symbols.sort(key=lambda item: item["line"])
    return {"imports": [{"module": spec, "level": 0, "names": []} for spec in dict.fromkeys(JS_IMPORT.findall(source))],
            "symbols": symbols, "doc": ""}


def _parse(base: Path, path: Path) -> dict[str, Any] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    if stat.st_size > project_code.MAX_FILE:
        return {"lines": 0, "imports": [], "symbols": [], "doc": "", "skipped": "too large"}
    key, signature = (str(base), path.as_posix()), (stat.st_size, stat.st_mtime_ns)
    with _lock:
        cached = _cache.get(key)
    if cached and cached[0] == signature:
        return cached[1]
    source = ""
    try:
        source = path.read_text(encoding="utf-8-sig", errors="replace")
        parsed = _python(source) if path.suffix.lower() in PYTHON else _script(source)
    except (OSError, SyntaxError, ValueError, RecursionError) as error:
        parsed = {"imports": [], "symbols": [], "doc": "", "error": str(error)[:200]}
    parsed["lines"] = source.count("\n") + 1 if source else 0
    with _lock:
        _cache[key] = (signature, parsed)
    return parsed


def _python_modules(paths: list[str]) -> dict[str, str]:
    modules = {}
    for path in paths:
        if not path.endswith(".py"):
            continue
        parts = list(PurePosixPath(path).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        # Register every suffix, so `from core.x import y` resolves inside `app/core/x.py` too.
        for start in range(len(parts)):
            modules.setdefault(".".join(parts[start:]), path)
        if parts:
            modules[".".join(parts)] = path
    return modules


def _resolve_python(path: str, item: dict[str, Any], modules: dict[str, str]) -> list[tuple[str, list]]:
    module = item["module"]
    if item["level"]:
        package = list(PurePosixPath(path).parent.parts)
        package = package[:len(package) - (item["level"] - 1)] if item["level"] > 1 else package
        module = ".".join([*package, *([module] if module else [])])
    targets = []
    for name, alias in item["names"] or []:
        submodule = modules.get(f"{module}.{name}" if module else name)
        if submodule:
            targets.append((submodule, []))
        elif module in modules:
            targets.append((modules[module], [(name, alias)]))
    if not item["names"] and module in modules:
        targets.append((modules[module], []))
    return targets


def _resolve_script(path: str, spec: str, known: set[str]) -> str | None:
    if not spec.startswith("."):
        return None
    joined = os.path.normpath(os.path.join(os.path.dirname(path), spec)).replace("\\", "/")
    stem = re.sub(r"\.(m|c)?js$", "", joined)
    for candidate in (joined, *(stem + ext for ext in SCRIPT), *(f"{joined}/index{ext}" for ext in SCRIPT)):
        if candidate in known:
            return candidate
    return None


def build(base: Path) -> dict[str, Any]:
    paths, truncated = _files(base)
    parsed = {path.relative_to(base).as_posix(): _parse(base, path) for path in paths}
    parsed = {path: value for path, value in parsed.items() if value is not None}
    known = set(parsed)
    modules = _python_modules(list(known))
    files: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str], int] = {}
    for path, value in parsed.items():
        imports, external, bindings = [], [], {}
        for item in value["imports"]:
            if path.endswith(".py"):
                targets = _resolve_python(path, item, modules)
                if not targets:
                    external.append(item["module"].split(".")[0] or "." * item["level"])
                for target, names in targets:
                    imports.append(target)
                    bindings.update({alias: f"{target}#{name}" for name, alias in names})
            else:
                target = _resolve_script(path, item["module"], known)
                if target:
                    imports.append(target)
                else:
                    external.append(item["module"].split("/")[0] if not item["module"].startswith("@") else "/".join(item["module"].split("/")[:2]))
        imports = sorted({target for target in imports if target != path})
        for target in imports:
            edges[(path, target)] = edges.get((path, target), 0) + 1
        files[path] = {"path": path, "lang": LANGUAGES[PurePosixPath(path).suffix.lower()], "lines": value["lines"],
                       "doc": value.get("doc", ""), "error": value.get("error") or value.get("skipped"),
                       "imports": imports, "imported_by": [], "external": sorted(set(e for e in external if e)),
                       "symbols": [{k: v for k, v in symbol.items() if k != "raw_calls"} | {"id": f"{path}#{symbol['name']}", "calls": [], "called_by": []}
                                   for symbol in value["symbols"]], "_bindings": bindings, "_raw": value["symbols"]}
    for source, target in edges:
        files[target]["imported_by"].append(source)
    # Calls: a name resolves to a symbol of the same file, then to an imported name.
    index = {symbol["id"]: symbol for file in files.values() for symbol in file["symbols"]}
    for path, file in files.items():
        local = {symbol["name"].split(".")[-1]: symbol["id"] for symbol in file["symbols"] if symbol["kind"] in {"function", "class"}}
        methods = {symbol["name"].split(".")[-1]: symbol["id"] for symbol in file["symbols"] if symbol["kind"] == "method"}
        for symbol, raw in zip(file["symbols"], file.pop("_raw")):
            targets = set()
            for name in raw.get("raw_calls", []):
                target = local.get(name) or file["_bindings"].get(name) or methods.get(name)
                if target and target != symbol["id"] and target in index:
                    targets.add(target)
            symbol["calls"] = sorted(targets)
            for target in targets:
                index[target]["called_by"].append(symbol["id"])
        file.pop("_bindings")
    directories: dict[str, dict[str, Any]] = {}
    for path, file in files.items():
        directory = str(PurePosixPath(path).parent)
        entry = directories.setdefault(directory, {"path": directory, "files": 0, "lines": 0})
        entry["files"] += 1
        entry["lines"] += file["lines"]
    return {"files": sorted(files.values(), key=lambda item: item["path"]),
            "edges": [{"source": s, "target": t} for s, t in sorted(edges)],
            "directories": sorted(directories.values(), key=lambda item: item["path"]),
            "languages": sorted({file["lang"] for file in files.values()}),
            "truncated": truncated, "built_at": datetime.now(timezone.utc).isoformat()}
