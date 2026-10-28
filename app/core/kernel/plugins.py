"""Discover and load the plugins under ``app/plugins``.

A plugin is a package with a ``plugin.json`` manifest. The manifest declares
its collections, state keys, link types, settings and connectors; the package
may also define ``register(registry, manifest)`` for what a declaration cannot
express (HTTP routers, MCP tools, calendar or search sources, state hooks).
"""
from __future__ import annotations

import importlib
import json
import logging
import threading
from pathlib import Path
from typing import Any

from app.core.kernel import env
from app.core.kernel.config import APP_DIR
from app.core.kernel.registry import Registry, registry

CORE_VERSION = (2, 0)
PLUGINS_DIR = APP_DIR / "plugins"
REQUIRED = ("id", "name", "version", "requires_core")
# Keys of a collection declaration written to databases/<id>/database.kavot.json.
CATALOG_KEYS = ("id", "name", "record_kind", "source", "views", "tools", "storage")

logger = logging.getLogger(__name__)
_lock = threading.RLock()


class PluginError(ValueError):
    pass


def _version(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))


def _compatible(requirement: str) -> bool:
    """Only ``>=X.Y`` is supported for now."""
    if not requirement.startswith(">="):
        raise PluginError(f"Unsupported requires_core {requirement!r}; use '>=X.Y'.")
    return CORE_VERSION >= _version(requirement[2:].strip())


def read_manifest(folder: Path) -> dict[str, Any]:
    manifest = json.loads((folder / "plugin.json").read_text(encoding="utf-8"))
    missing = [key for key in REQUIRED if key not in manifest]
    if missing:
        raise PluginError(f"{folder.name}/plugin.json is missing {', '.join(missing)}.")
    if manifest["id"] != folder.name:
        raise PluginError(f"Plugin id {manifest['id']!r} must match its folder {folder.name!r}.")
    for collection in manifest.get("collections", []):
        if not {"id", "name"} <= collection.keys():
            raise PluginError(f"{folder.name}: every collection needs an id and a name.")
    for link in manifest.get("link_types", []):
        if not {"id", "from", "to"} <= link.keys():
            raise PluginError(f"{folder.name}: every link type needs id, from and to.")
    return manifest


def disabled_plugins() -> set[str]:
    names = {name.strip() for name in env.get("KAVOT_DISABLED_PLUGINS").split(",") if name.strip()}
    from app.core.kernel.user_settings import load_preferences
    return names | set(load_preferences().get("disabled_plugins") or [])


def available() -> list[dict[str, Any]]:
    """Every plugin folder with its manifest, enabled or not."""
    found = []
    for folder in sorted(PLUGINS_DIR.iterdir()):
        if (folder / "plugin.json").is_file():
            found.append(read_manifest(folder))
    return found


def _install(target: Registry, manifest: dict[str, Any]) -> None:
    plugin_id = manifest["id"]
    target.plugins[plugin_id] = manifest
    for collection in manifest.get("collections", []):
        target.collections.append({**collection, "plugin": plugin_id})
    target.state_collections.extend(manifest.get("state_collections", []))
    for link in manifest.get("link_types", []):
        target.link_types[link["id"]] = {**link, "plugin": plugin_id}
    if manifest.get("settings"):
        target.settings[plugin_id] = manifest["settings"]
    for connector in manifest.get("connectors", []):
        target.connectors[f"{plugin_id}.{connector['id']}"] = {**connector, "plugin": plugin_id}
    module = importlib.import_module(f"app.plugins.{plugin_id}")
    if hasattr(module, "register"):
        module.register(target, manifest)


def load(target: Registry = registry) -> Registry:
    """Fill the registry once; later calls return it unchanged."""
    with _lock:
        if target.plugins or getattr(target, "_loaded", False):
            return target
        disabled = disabled_plugins()
        for manifest in available():
            if manifest["id"] in disabled:
                if manifest.get("removable", True):
                    continue
                logger.warning("Plugin %s cannot be disabled yet: the core still depends on it.", manifest["id"])
            if not _compatible(manifest["requires_core"]):
                logger.warning("Plugin %s needs core %s; skipped.", manifest["id"], manifest["requires_core"])
                continue
            _install(target, manifest)
        target.collections.sort(key=lambda item: item.get("position", 100))
        target._loaded = True
        return target


def public() -> list[dict[str, Any]]:
    """Plugins for the settings screen: manifest summary and whether each one is active."""
    load()
    return [{"id": m["id"], "name": m["name"], "version": m["version"], "description": m.get("description", ""),
             "removable": m.get("removable", True), "enabled": m["id"] in registry.plugins,
             "collections": [{"id": c["id"], "name": c["name"], "removable": c.get("removable", False)}
                             for c in m.get("collections", [])],
             "connectors": [{"id": c["id"], "label": c.get("label", c["id"]), "permissions": c.get("permissions", [])}
                            for c in m.get("connectors", [])]}
            for m in available()]


__all__ = ["CATALOG_KEYS", "CORE_VERSION", "PluginError", "available", "load", "public", "read_manifest"]
