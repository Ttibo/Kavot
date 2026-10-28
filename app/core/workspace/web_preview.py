"""Bounded, public-web metadata previews. Never execute or return page HTML."""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from functools import lru_cache
from html.parser import HTMLParser
from time import time
from urllib.parse import urljoin, urlsplit, urlunsplit

MAX_BYTES = 1024 * 1024


def public_target(url: str):
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("A public HTTP or HTTPS address is required")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in {80, 443}:
        raise ValueError("Unsupported web port")
    addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses):
        raise ValueError("Only public websites can be previewed")
    return parsed, addresses[0][4][0], port


def fetch_html(url: str) -> tuple[str, str]:
    for _ in range(4):
        parsed, address, port = public_target(url)
        connection = http.client.HTTPConnection(parsed.hostname, port, timeout=5)
        try:
            # Pin the validated IP while retaining the original Host and TLS identity.
            connection.sock = socket.create_connection((address, port), timeout=5)
            if parsed.scheme == "https":
                connection.sock = ssl.create_default_context().wrap_socket(connection.sock, server_hostname=parsed.hostname)
            path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
            connection.request("GET", path, headers={"User-Agent": "Kavot/0.1 (link preview)", "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    raise ValueError("Missing redirect address")
                url = urljoin(url, location)
                continue
            if response.status != 200 or response.headers.get_content_type() not in {"text/html", "application/xhtml+xml"}:
                raise ValueError("No HTML preview available")
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("Page exceeds preview size limit")
            return url, raw.decode(response.headers.get_content_charset() or "utf-8", errors="replace")
        finally:
            connection.close()
    raise ValueError("Too many redirects")


class MetadataParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            self.meta.setdefault(key, values.get("content") or "")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)


def extract_metadata(url: str, html: str) -> dict:
    parser = MetadataParser()
    parser.feed(html)
    meta = parser.meta
    image = urljoin(url, meta.get("og:image") or meta.get("twitter:image") or "")
    if not (meta.get("og:image") or meta.get("twitter:image")):
        image = None
    elif urlsplit(image).scheme not in {"http", "https"}:
        image = None
    return {
        "available": True, "url": url,
        "title": " ".join((meta.get("og:title") or meta.get("twitter:title") or "".join(parser.title) or urlsplit(url).hostname).split())[:300],
        "description": " ".join((meta.get("og:description") or meta.get("description") or meta.get("twitter:description") or "").split())[:600],
        "image": image,
    }


@lru_cache(maxsize=128)
def _preview(url: str, time_bucket: int) -> dict:
    fallback = {"available": False, "url": url, "title": "Website", "description": "Preview unavailable. Open the website to read this source.", "image": None}
    try:
        final_url, html = fetch_html(url)
        result = extract_metadata(final_url, html)
        if result["image"]:
            try:
                public_target(result["image"])
            except (ValueError, OSError):
                result["image"] = None
        return result
    except (ValueError, OSError, http.client.HTTPException, LookupError):
        return fallback


def link_preview(url: str) -> dict:
    return _preview(url, int(time() // 300))
