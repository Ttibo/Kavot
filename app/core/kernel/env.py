"""Settings and credentials kept in ``.env`` files.

Two files are read, the first match winning after the real environment:

- ``<repository>/.env``: a developer's overrides, never written by Kavot;
- ``<config folder>/Kavot/.env``: the user's local paths and credentials,
  written by Kavot when they change in the settings screen.

Values are kept here and never copied into ``os.environ``, so the agent CLIs
and scripts Kavot starts do not inherit the user's tokens.
"""
from __future__ import annotations

import os
import re
import sys
import threading
from pathlib import Path
from tempfile import NamedTemporaryFile

REPOSITORY_FILE = Path(__file__).resolve().parents[3] / ".env"
TEMPLATE = """# Kavot local settings and credentials. Kavot rewrites this file; edit it while Kavot is closed.
# Private to this computer: never commit or share it. Real environment variables win.
# Uncomment a line to set a value; Kavot also writes here when you change a setting.

# KAVOT_STORAGE_PATH=''
# KAVOT_CLOUD_URL='https://kavot.cloud'
# KAVOT_DISABLED_PLUGINS=''
# KAVOT_ZOTERO_API_KEY=''
# KAVOT_ZOTERO_USER_ID=''
# OPENALEX_API_KEY=''
# SEMANTIC_SCHOLAR_API_KEY=''
# OPENCITATIONS_ACCESS_TOKEN=''
"""
_line = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
_escapes = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}
_lock = threading.RLock()
_cache: dict[Path, tuple[int, dict[str, str]]] = {}


def parse(text: str) -> dict[str, str]:
    values = {}
    for raw in text.splitlines():
        match = _line.match(raw)
        if not match or raw.lstrip().startswith("#"):
            continue
        key, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        elif len(value) >= 2 and value[0] == value[-1] == '"':
            value = re.sub(r"\\(.)", lambda m: _escapes.get(m[1], "\\" + m[1]), value[1:-1])
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0]
        values[key] = value
    return values


def _quote(value: str) -> str:
    # Single quotes keep Windows paths literal; double quotes only when needed.
    if "'" not in value and "\n" not in value and "\r" not in value:
        return f"'{value}'"
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r") + '"'


def _read(path: Path) -> dict[str, str]:
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return {}
    with _lock:
        cached = _cache.get(path)
        if cached and cached[0] == stamp:
            return cached[1]
        try:
            values = parse(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError):
            values = {}
        _cache[path] = (stamp, values)
        return values


def _repository() -> dict[str, str]:
    # Tests and packaged builds can ignore a developer's checkout file.
    return {} if os.environ.get("KAVOT_DOTENV") == "0" else _read(REPOSITORY_FILE)


def user_file() -> Path:
    from app.core.kernel.user_settings import config_dir
    return config_dir() / ".env"


def get(name: str, default: str = "") -> str:
    if name in os.environ:
        return os.environ[name]
    repository = _repository()
    if name in repository:
        return repository[name]
    # The user file lives in the config folder, so it cannot choose that folder.
    if name == "KAVOT_CONFIG_PATH":
        return default
    return _read(user_file()).get(name, default)


def stored(name: str) -> str:
    """The value saved in the user file, ignoring overrides."""
    return _read(user_file()).get(name, "")


def overridden(name: str) -> bool:
    """True when the environment or the repository file pins this value."""
    return name in os.environ or name in _repository()


def update(values: dict[str, str | None]) -> None:
    """Write values to the user file; an empty value removes the line."""
    path = user_file()
    with _lock:
        try:
            lines = path.read_text(encoding="utf-8-sig").splitlines(keepends=True)
        except OSError:
            lines = TEMPLATE.splitlines(keepends=True)
        pending = dict(values)
        kept = []
        for line in lines:
            match = _line.match(line)
            if match and not line.lstrip().startswith("#") and match[1] in pending:
                value = pending.pop(match[1])
                if value:
                    kept.append(f"{match[1]}={_quote(str(value))}\n")
                continue
            kept.append(line if line.endswith("\n") else line + "\n")
        kept += [f"{key}={_quote(str(value))}\n" for key, value in pending.items() if value]
        _replace(path, kept)


def _replace(path: Path, lines: list[str]) -> None:
    temporary = None
    try:
        # NamedTemporaryFile is created readable by its owner only.
        with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False, newline="\n") as handle:
            temporary = Path(handle.name)
            handle.writelines(lines)
        if sys.platform != "win32":
            os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    _cache.pop(path, None)


def ensure_user_file() -> Path:
    """Create the user's .env with a commented template on first launch."""
    path = user_file()
    with _lock:
        if not path.exists():
            _replace(path, TEMPLATE.splitlines(keepends=True))
    return path


def write(name: str, value: str | None) -> None:
    update({name: value})
