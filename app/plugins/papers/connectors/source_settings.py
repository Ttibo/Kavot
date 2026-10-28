"""Shared configuration for every supported scholarly API consumer."""
from __future__ import annotations

import re
from threading import RLock
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import HTTPException

from app.core.kernel import env
from app.core.kernel.user_settings import load_integrations, move_to_env, save_integration


SOURCES = {
    "openalex": {"name": "OpenAlex", "endpoint": "https://api.openalex.org", "description": "Article metadata, citations and PDF discovery", "auth_mode": "bearer", "auth_name": "Authorization"},
    "crossref": {"name": "Crossref", "endpoint": "https://api.crossref.org", "description": "DOI imports and references · Metadata Plus keys supported", "auth_mode": "bearer", "auth_name": "Crossref-Plus-API-Token"},
    "semantic_scholar": {"name": "Semantic Scholar", "endpoint": "https://api.semanticscholar.org/graph/v1", "description": "Citations, abstracts and open-access PDF links", "auth_mode": "header", "auth_name": "x-api-key"},
    "open_citations": {"name": "OpenCitations", "endpoint": "https://api.opencitations.net/index/v2", "description": "References and citing articles", "auth_mode": "header", "auth_name": "authorization"},
    "europe_pmc": {"name": "Europe PMC", "endpoint": "https://www.ebi.ac.uk/europepmc/webservices/rest", "description": "Biomedical citations and abstracts", "auth_mode": "none", "auth_name": ""},
    "arxiv": {"name": "arXiv", "endpoint": "https://export.arxiv.org/api", "description": "Preprint imports and PDF links", "auth_mode": "none", "auth_name": ""},
}
LEGACY_KEYS = {"semantic_scholar": "semantic_scholar_api_key", "open_citations": "opencitations_access_token"}
ENV_KEYS = {"semantic_scholar": "SEMANTIC_SCHOLAR_API_KEY", "open_citations": "OPENCITATIONS_ACCESS_TOKEN", "openalex": "OPENALEX_API_KEY"}
_settings_lock = RLock()


def env_name(source: str) -> str:
    return ENV_KEYS.get(source) or f"KAVOT_{source.upper()}_API_KEY"


def config(source: str) -> dict[str, Any]:
    if source not in SOURCES:
        raise HTTPException(422, "Unknown scholarly source")
    # Keys saved by older versions move from settings.json to the .env file.
    move_to_env(("integrations", "scholarly_sources", source, "api_key"), env_name(source))
    if source in LEGACY_KEYS:
        move_to_env(("integrations", "citation_providers", LEGACY_KEYS[source]), env_name(source))
    stored = (load_integrations().get("scholarly_sources") or {}).get(source) or {}
    return {"enabled": True, **SOURCES[source], **stored, "api_key": env.get(env_name(source))}


def enabled(source: str) -> bool:
    return bool(config(source)["enabled"])


def status() -> dict[str, Any]:
    providers = []
    for source, defaults in SOURCES.items():
        value = config(source)
        key = value.pop("api_key", "")
        providers.append({**value, "id": source, "default_endpoint": defaults["endpoint"], "api_key_configured": bool(key)})
    return {"sources": providers}


def configure(updates: list[dict[str, Any]]) -> dict[str, Any]:
    with _settings_lock:
        return _configure(updates)


def _configure(updates: list[dict[str, Any]]) -> dict[str, Any]:
    stored = dict(load_integrations().get("scholarly_sources") or {})
    keys: dict[str, str] = {}
    seen = set()
    for update in updates:
        source = update["id"]
        if source in seen:
            raise HTTPException(422, "Duplicate scholarly source")
        seen.add(source)
        value = config(source)
        old_endpoint = value["endpoint"]
        value.update({key: item for key, item in update.items() if key in {"enabled", "endpoint", "auth_mode", "auth_name"}})
        endpoint = str(value["endpoint"]).strip().rstrip("/")
        try:
            parsed = urlsplit(endpoint)
            valid = parsed.scheme == "https" and parsed.hostname and not (parsed.username or parsed.password or parsed.query or parsed.fragment)
            parsed.port
        except ValueError:
            valid = False
        if not valid or any(char.isspace() for char in endpoint):
            raise HTTPException(422, "Use an HTTPS API base URL without credentials, query parameters or fragments")
        value["endpoint"] = endpoint
        value["auth_name"] = str(value["auth_name"]).strip()
        if value["auth_mode"] != "none" and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value["auth_name"]):
            raise HTTPException(422, "Enter a valid authentication header or parameter name")
        if value["auth_mode"] in {"header", "bearer"} and value["auth_name"].lower() in {"host", "content-length", "connection", "transfer-encoding", "cookie"}:
            raise HTTPException(422, "This header cannot be used for API authentication")
        key = str(update.get("api_key") or "").strip()
        if any(ord(char) < 32 or ord(char) > 126 for char in key):
            raise HTTPException(422, "The API key contains invalid characters")
        if update.get("clear_api_key") or endpoint != old_endpoint:
            keys[env_name(source)] = ""
        if key and not update.get("clear_api_key"):
            keys[env_name(source)] = key
        stored[source] = {field: value[field] for field in ("enabled", "endpoint", "auth_mode", "auth_name")}
    save_integration("scholarly_sources", stored)
    env.update(keys)
    legacy = dict(load_integrations().get("citation_providers") or {})
    for source in seen:
        legacy.pop(LEGACY_KEYS.get(source, ""), None)
    if legacy != (load_integrations().get("citation_providers") or {}):
        save_integration("citation_providers", legacy)
    return status()


def request(source: str, path: str, requester: Callable, **kwargs):
    value = config(source)
    if not value["enabled"]:
        raise HTTPException(422, f"{value['name']} is disabled in Settings → Integrations")
    url = value["endpoint"].rstrip("/") + "/" + path.lstrip("/")
    headers = dict(kwargs.pop("headers", None) or {})
    key = value["api_key"]
    if key and value["auth_mode"] in {"header", "bearer"}:
        headers[value["auth_name"]] = ("Bearer " if value["auth_mode"] == "bearer" else "") + key
    elif key and value["auth_mode"] == "query":
        parsed = urlsplit(url)
        query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != value["auth_name"]]
        url = urlunsplit(parsed._replace(query=urlencode([*query, (value["auth_name"], key)])))
    return requester(url, **({"headers": headers} if headers else {}), restrict_redirects=True, **kwargs)
