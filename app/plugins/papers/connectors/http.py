from __future__ import annotations

import json
import re
from tempfile import SpooledTemporaryFile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from fastapi import HTTPException


USER_AGENT = "Kavot/0.1 (local research workspace)"
PDF_ACCEPT = "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8"
# A few repository hosts reject a PDF-only Accept header with HTTP 406, despite
# serving the same file when it is opened as a normal browser navigation.
BROWSER_DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7"


class SameOriginRedirectHandler(HTTPRedirectHandler):
    """Do not forward API credentials to another host or a downgraded URL."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urlsplit(req.full_url), urlsplit(newurl)
        if (old.scheme, old.hostname, old.port or 443) != (new.scheme, new.hostname, new.port or 443):
            raise HTTPException(502, "The API redirected to another origin; update its endpoint in Settings")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request_bytes(url: str, *, headers: dict[str, str] | None = None, timeout: int = 25, restrict_redirects: bool = False) -> tuple[bytes, dict[str, str]]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})})
    try:
        open_request = build_opener(SameOriginRedirectHandler()).open if restrict_redirects else urlopen
        with open_request(request, timeout=timeout) as response:
            return response.read(), dict(response.headers.items())
    except HTTPError as error:
        if error.code in {401, 403}:
            detail = "The integration credentials were rejected"
        elif error.code == 404:
            detail = "No scholarly record was found for this identifier"
        elif error.code == 429:
            detail = "The scholarly service rate limit was reached; retry shortly"
        else:
            detail = f"The scholarly service returned HTTP {error.code}"
        raise HTTPException(status_code=502, detail=detail) from error
    except (URLError, TimeoutError, OSError) as error:
        raise HTTPException(status_code=503, detail="The scholarly service is currently unreachable") from error


def request_json(url: str, *, headers: dict[str, str] | None = None, timeout: int = 25, restrict_redirects: bool = False) -> Any:
    body, _ = request_bytes(url, headers=headers, timeout=timeout, restrict_redirects=restrict_redirects)
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail="The scholarly service returned an invalid response") from error


def canonical_pdf_url(url: str) -> str:
    """Avoid arXiv's legacy .pdf redirect, including for previously saved links."""
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or parsed.netloc.lower() not in {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}:
        return url
    match = re.fullmatch(r"/pdf/(\d{4}\.\d{4,5}(?:v\d+)?|[A-Za-z][A-Za-z.-]*/\d{7}(?:v\d+)?)(?:\.pdf)?", parsed.path)
    if not match:
        return url
    return urlunsplit(("https", "arxiv.org", f"/pdf/{match.group(1)}", parsed.query, parsed.fragment))


class FileRedirectHandler(HTTPRedirectHandler):
    """Allow signed storage redirects without forwarding the API credentials."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https" or target.username or target.password:
            raise HTTPException(502, "The file service returned an unsafe download redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_pdf(url: str, *, max_bytes: int = 75 * 1024 * 1024, timeout: int = 45, headers: dict[str, str] | None = None):
    """Download a bounded PDF into a seekable temporary stream."""
    url = canonical_pdf_url(url)
    def fetch(accept: str):
        request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        # urllib excludes unredirected headers from subsequent requests. Zotero
        # redirects its authenticated /file endpoint to signed storage URLs.
        for name, value in (headers or {}).items():
            request.add_unredirected_header(name, value)
        open_request = build_opener(FileRedirectHandler()).open if headers else urlopen
        with open_request(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            if length and int(length) > max_bytes:
                raise HTTPException(status_code=413, detail="The discovered PDF is larger than 75 MB")
            stream = SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b")
            try:
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise HTTPException(status_code=413, detail="The discovered PDF is larger than 75 MB")
                    stream.write(chunk)
                stream.seek(0)
                if stream.read(5) != b"%PDF-":
                    raise HTTPException(status_code=422, detail="The discovered link did not return a valid PDF")
                stream.seek(0)
                return stream
            except BaseException:
                stream.close()
                raise

    try:
        return fetch(PDF_ACCEPT)
    except HTTPException:
        raise
    except HTTPError as error:
        if error.code == 406:
            try:
                return fetch(BROWSER_DOCUMENT_ACCEPT)
            except HTTPException:
                raise
            except HTTPError as retry_error:
                if retry_error.code == 406:
                    raise HTTPException(status_code=502, detail="The PDF host refused the download (HTTP 406). Retry later, provide another direct PDF link, or download the PDF in your browser and attach it to the article.") from retry_error
                raise HTTPException(status_code=502, detail=f"The PDF host returned HTTP {retry_error.code}") from retry_error
            except (URLError, TimeoutError, OSError, ValueError) as retry_error:
                raise HTTPException(status_code=503, detail="The discovered PDF could not be downloaded") from retry_error
        raise HTTPException(status_code=502, detail=f"The PDF host returned HTTP {error.code}") from error
    except (URLError, TimeoutError, OSError, ValueError) as error:
        raise HTTPException(status_code=503, detail="The discovered PDF could not be downloaded") from error
