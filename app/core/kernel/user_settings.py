"""Persisted user preferences that must survive application restarts.

These preferences live outside the workspace.  This is required for the
storage location itself and also prevents desktop WebView preferences from
being tied to the ephemeral loopback port used for a particular launch.

Interface preferences stay in ``settings.json``; local paths and credentials
live in the ``.env`` file next to it (see ``app.core.kernel.env``).
"""

from __future__ import annotations

import json
import os
import re
import sys
from tempfile import NamedTemporaryFile
from pathlib import Path
from typing import Any, Optional

from app.core.kernel import env

APP_NAME = "Kavot"
FONT_SIZES = {"navigation": 13, "interface": 13, "titles": 26, "editor": 12, "tables": 13, "assistant": 14, "code": 12}
# Interface colors the user may override, per theme; unset roles keep the theme's own.
COLOR_ROLES = ("canvas", "surface", "sidebar", "ink", "muted", "line", "accent")
# Colors offered by the color pickers (cards, projects, labels…).
PALETTE = ["#087e86", "#3282c4", "#39917d", "#d08b33", "#bc4c7b", "#59aaba", "#c75555", "#7b61c4"]
HEX_COLOR = re.compile(r"^#[0-9a-f]{6}$")
DEFAULT_PREFERENCES = {
    "theme": "light",
    "font_sizes": FONT_SIZES,
    "colors": {"light": {}, "dark": {}},
    "palette": PALETTE,
    # Local embeddings for search (downloads a small model once when turned on).
    "semantic_search": False,
    # Plugin ids turned off by the user; plugins the core still needs stay on.
    "disabled_plugins": [],
}


def _config_base() -> Path:
    override = env.get("KAVOT_CONFIG_PATH")
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        return Path(os.getenv("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    return Path(os.getenv("XDG_CONFIG_HOME", Path.home() / ".config"))


def config_dir() -> Path:
    directory = _config_base() / APP_NAME
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _settings_file() -> Path:
    return config_dir() / "settings.json"


def _read() -> dict:
    settings_file = _settings_file()
    if not settings_file.is_file():
        return {}
    try:
        return json.loads(settings_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write(payload: dict) -> None:
    _settings_file().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def move_to_env(path: tuple[str, ...], name: str) -> None:
    """Move a value saved by an older version from settings.json to the .env file."""
    payload = _read()
    parent = payload
    for key in path[:-1]:
        parent = parent.get(key) if isinstance(parent, dict) else None
    if not isinstance(parent, dict) or path[-1] not in parent:
        return
    value = parent.pop(path[-1])
    if value not in (None, "") and not env.stored(name):
        env.write(name, str(value))
    _write(payload)


def load_storage_path() -> Optional[Path]:
    move_to_env(("storage_path",), "KAVOT_STORAGE_PATH")
    value = env.get("KAVOT_STORAGE_PATH")
    return Path(value).expanduser() if value else None


def save_storage_path(path: Path) -> None:
    env.write("KAVOT_STORAGE_PATH", str(path))


def _theme_colors(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {role: color.lower() for role, color in value.items()
            if role in COLOR_ROLES and isinstance(color, str) and HEX_COLOR.match(color.lower())}


def _palette(value: Any) -> list[str]:
    colors = [color.lower() for color in value if isinstance(color, str) and HEX_COLOR.match(color.lower())] if isinstance(value, list) else []
    return colors[:24] or list(PALETTE)


def load_preferences() -> dict[str, Any]:
    """Return validated interface preferences with stable defaults."""
    stored = _read().get("preferences")
    preferences = dict(DEFAULT_PREFERENCES)
    preferences["font_sizes"] = dict(FONT_SIZES)
    colors = stored.get("colors") if isinstance(stored, dict) and isinstance(stored.get("colors"), dict) else {}
    preferences["colors"] = {theme: _theme_colors(colors.get(theme)) for theme in ("light", "dark")}
    preferences["palette"] = _palette(stored.get("palette") if isinstance(stored, dict) else None)
    if isinstance(stored, dict) and isinstance(stored.get("font_sizes"), dict):
        preferences["font_sizes"].update({key: value for key, value in stored["font_sizes"].items() if key in FONT_SIZES and type(value) is int and 10 <= value <= (40 if key == "titles" else 24)})
    if isinstance(stored, dict) and stored.get("theme") in {"light", "dark"}:
        preferences["theme"] = stored["theme"]
    if isinstance(stored, dict) and type(stored.get("semantic_search")) is bool:
        preferences["semantic_search"] = stored["semantic_search"]
    if isinstance(stored, dict) and isinstance(stored.get("disabled_plugins"), list):
        preferences["disabled_plugins"] = [str(item) for item in stored["disabled_plugins"] if isinstance(item, str)]
    return preferences


def save_preferences(value: dict[str, Any]) -> dict[str, Any]:
    """Merge and persist supported interface preferences."""
    preferences = load_preferences()
    if isinstance(value.get("font_sizes"), dict):
        preferences["font_sizes"].update({key: size for key, size in value["font_sizes"].items() if key in FONT_SIZES and type(size) is int and 10 <= size <= (40 if key == "titles" else 24)})
    if value.get("theme") in {"light", "dark"}:
        preferences["theme"] = value["theme"]
    if isinstance(value.get("colors"), dict):
        # A theme sent replaces its colors: a role left out goes back to the theme's own.
        preferences["colors"].update({theme: _theme_colors(colors) for theme, colors in value["colors"].items() if theme in {"light", "dark"}})
    if isinstance(value.get("palette"), list):
        preferences["palette"] = _palette(value["palette"])
    if type(value.get("semantic_search")) is bool:
        preferences["semantic_search"] = value["semantic_search"]
    if isinstance(value.get("disabled_plugins"), list):
        preferences["disabled_plugins"] = sorted({str(item) for item in value["disabled_plugins"]})
    payload = _read()
    payload["preferences"] = preferences
    _settings_file().write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return preferences


BACKUP_SCHEDULES = {"off", "daily", "weekly"}
DEFAULT_BACKUPS = {"schedule": "daily", "online": False}


def load_backup_settings() -> dict[str, Any]:
    stored = _read().get("backups")
    result = dict(DEFAULT_BACKUPS)
    if isinstance(stored, dict):
        if stored.get("schedule") in BACKUP_SCHEDULES:
            result["schedule"] = stored["schedule"]
        if isinstance(stored.get("online"), bool):
            result["online"] = stored["online"]
    return result


def save_backup_settings(value: dict[str, Any]) -> dict[str, Any]:
    result = load_backup_settings()
    if value.get("schedule") in BACKUP_SCHEDULES:
        result["schedule"] = value["schedule"]
    if isinstance(value.get("online"), bool):
        result["online"] = value["online"]
    payload = _read()
    payload["backups"] = result
    _settings_file().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def load_integrations() -> dict[str, Any]:
    """Return local integration credentials without placing them in workspace data."""
    stored = _read().get("integrations")
    return dict(stored) if isinstance(stored, dict) else {}


def save_integration(name: str, value: dict[str, Any]) -> None:
    payload = _read()
    integrations = payload.get("integrations")
    if not isinstance(integrations, dict):
        integrations = {}
    integrations[name] = value
    payload["integrations"] = integrations
    target = _settings_file()
    # Readers may run concurrently during citation lookups. Publish a complete
    # file atomically; NamedTemporaryFile also restricts credentials to its owner.
    temporary = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def load_script_network() -> list[dict[str, Any]]:
    """URLs the user allowed note scripts to call, kept on this computer only."""
    stored = _read().get("script_network")
    if not isinstance(stored, list):
        return []
    return [dict(entry) for entry in stored if isinstance(entry, dict) and isinstance(entry.get("url"), str)]


def save_script_network(entries: list[dict[str, Any]]) -> None:
    payload = _read()
    payload["script_network"] = entries
    _settings_file().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
