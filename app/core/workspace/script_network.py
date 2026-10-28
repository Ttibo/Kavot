"""Network access for note scripts.

Scripts run in a sandbox without network access. `kavot.fetch` reaches this
proxy instead, which only calls URLs the user approved one by one (scheme, host,
port and path; the query string is not part of the approval). Approvals live in
the local settings, never in the workspace, so a shared or synced script cannot
bring its own. Local and private network addresses are always refused, so a
script cannot reach the Kavot API or other services on the machine or the LAN.
"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import socket
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.core.kernel.user_settings import load_script_network, save_script_network

METHODS = {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"}
MAX_REQUEST_BYTES = 1_000_000
MAX_RESPONSE_BYTES = 5_000_000
MAX_REDIRECTS = 5
TIMEOUT = httpx.Timeout(20, connect=10)
# Headers the proxy sets itself, or that would leak the app's identity or session.
DROPPED_REQUEST_HEADERS = {
    "host", "cookie", "cookie2", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade",
    "te", "trailer", "expect", "origin", "referer", "accept-encoding",
}
# Bodies are returned decoded, and cookies are never kept or exposed.
DROPPED_RESPONSE_HEADERS = {"set-cookie", "set-cookie2", "content-encoding", "content-length", "transfer-encoding",
                            "connection", "keep-alive"}


class ScriptNetworkError(ValueError):
    """A request the proxy refuses or cannot complete; the message is shown to the script."""


def url_key(url: str) -> str:
    """Normalized form of a URL as approved by the user: no query, fragment or credentials."""
    try:
        parts = urlsplit(str(url).strip())
        port = parts.port
    except ValueError as error:
        raise ScriptNetworkError(f"Invalid URL: {url}") from error
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ScriptNetworkError("Scripts can only call http:// and https:// URLs")
    if parts.username or parts.password:
        raise ScriptNetworkError("URLs with credentials are not allowed")
    host = parts.hostname.lower()
    netloc = f"[{host}]" if ":" in host else host
    if port and port != {"http": 80, "https": 443}[parts.scheme]:
        netloc += f":{port}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", "", ""))


def _check_public(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError) as error:
        raise ScriptNetworkError(f"Unknown host: {host}") from error
    for info in infos:
        address = ipaddress.ip_address(str(info[4][0]).split("%")[0])
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global or address.is_multicast:
            raise ScriptNetworkError("Scripts cannot reach local or private network addresses")


def approvals() -> list[dict[str, Any]]:
    return load_script_network()


def approve(url: str, script: str = "") -> dict[str, Any]:
    key = url_key(url)
    entries = load_script_network()
    existing = next((entry for entry in entries if entry["url"] == key), None)
    if existing:
        return existing
    entry = {"url": key, "script": script[:120], "approved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    save_script_network([*entries, entry])
    return entry


def revoke(url: str) -> None:
    key = url_key(url)
    save_script_network([entry for entry in load_script_network() if entry["url"] != key])


def fetch(url: str, method: str = "GET", headers: dict[str, str] | None = None, body: str | None = None) -> dict[str, Any]:
    """Call an approved URL. An unapproved URL (or redirect target) returns {"approved": False, "url": key}."""
    method = method.upper()
    if method not in METHODS:
        raise ScriptNetworkError(f"Method not allowed: {method}")
    try:
        content = base64.b64decode(body, validate=True) if body else None
    except (binascii.Error, ValueError) as error:
        raise ScriptNetworkError("Invalid request body") from error
    if content and len(content) > MAX_REQUEST_BYTES:
        raise ScriptNetworkError("The request body is larger than 1 MB")
    sent_headers = {name: value for name, value in (headers or {}).items()
                    if name.lower() not in DROPPED_REQUEST_HEADERS and not name.lower().startswith(("sec-", "proxy-"))}
    approved = {entry["url"] for entry in load_script_network()}
    try:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=False, trust_env=False) as client:
            for _ in range(MAX_REDIRECTS + 1):
                key = url_key(url)
                if key not in approved:
                    return {"approved": False, "url": key}
                _check_public(urlsplit(url).hostname or "")
                with client.stream(method, url, headers=sent_headers, content=content) as response:
                    location = response.headers.get("location")
                    if response.is_redirect and location:
                        url = str(response.url.join(location))
                        # Same rewrite as browsers: 303, and 301/302 after a POST, continue as GET without body.
                        if response.status_code == 303 or (response.status_code in (301, 302) and method == "POST"):
                            method, content = ("HEAD" if method == "HEAD" else "GET"), None
                        continue
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > MAX_RESPONSE_BYTES:
                            raise ScriptNetworkError("The response is larger than 5 MB")
                        chunks.append(chunk)
                    return {
                        "approved": True,
                        "url": str(response.url),
                        "status": response.status_code,
                        "status_text": response.reason_phrase,
                        "headers": [[name, value] for name, value in response.headers.multi_items()
                                    if name.lower() not in DROPPED_RESPONSE_HEADERS],
                        "body": base64.b64encode(b"".join(chunks)).decode("ascii"),
                    }
    except httpx.TimeoutException as error:
        raise ScriptNetworkError(f"The request to {urlsplit(url).hostname} timed out") from error
    except httpx.HTTPError as error:
        raise ScriptNetworkError(f"The request to {urlsplit(url).hostname} failed: {error}") from error
    raise ScriptNetworkError("Too many redirects")
