"""Portable derived data, mirrored under .meta_kavot by media type and source path."""
from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

from PIL import Image

from app.core.kernel.config import settings
from app.core.kernel.files import atomic_write_json, atomic_write_text, read_json_object, resolve_inside
from app.core.workspace import pdf_extraction

SCHEMA_VERSION = 1
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
# Imports, regeneration and moves serialize so a late extraction cannot overwrite a newer one.
_lock = threading.RLock()


def relative(path: Path) -> str:
    return path.resolve().relative_to(settings.storage_path.resolve()).as_posix()


def kind(path: Path) -> str | None:
    return "PDF" if path.suffix.lower() == ".pdf" else "Images" if path.suffix.lower() in IMAGE_SUFFIXES else None


def metadata_path(path: Path, extension: str = "json") -> Path:
    media = kind(path)
    if not media:
        raise ValueError("No metadata extractor for this file type")
    return resolve_inside(settings.storage_path, f".meta_kavot/{media}/{relative(path)}.{extension}")


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def markdown(data: dict, target: Path) -> str:
    source = data["source"]["path"]
    link = quote(os.path.relpath(settings.storage_path / source, target.parent), safe="/.")
    parts = [f"# {Path(source).name}", f"Source: [{source}]({link})", f"Extraction: {data['status']}",
             f"SHA-256: `{data['source']['sha256']}`"]
    parts.extend(f"> {warning}" for warning in data.get("warnings", []))
    for page in data.get("pages", []):
        parts.extend([f"## Page {page['page']}", f"Method: {page['method']}"])
        parts.extend(f"> {warning}" for warning in page.get("warnings", []))
        parts.append(page["text"])
        if page.get("native_text") and page["native_text"] != page["text"]:
            parts.extend(["### Original text layer", page["native_text"]])
        for table in page.get("tables", []):
            parts.extend([f"### Table {table['id']}", table["markdown"]])
    if data.get("text"):
        parts.append(data["text"])
    return "\n\n".join(parts) + "\n"


def _write(path: Path, data: dict) -> dict:
    from app.core.workspace.html_documents import generated
    from app.core.records.repository import store
    target = metadata_path(path)
    readable = target.with_suffix('.html')
    data["artifacts"] = {"json": relative(target), "html": relative(readable)}
    # JSON is the authoritative commit; HTML is a portable readable derivative.
    atomic_write_text(readable, generated(path.name, markdown(data, readable), readable, store.read()))
    atomic_write_json(target, data)
    target.with_suffix('.md').unlink(missing_ok=True)
    return data


def _image_data(path: Path) -> dict:
    try:
        with Image.open(path) as image:
            return {"status": "not_extracted", "width": image.width, "height": image.height, "format": image.format,
                    "warnings": ["Image text has not been extracted."]}
    except Exception as error:
        return {"status": "failed", "warnings": [f"Image could not be read: {type(error).__name__}"]}


def ensure(path: Path, *, force: bool = False) -> dict | None:
    if not kind(path):
        return None
    with _lock:
        checksum = fingerprint(path)
        existing = read_json_object(metadata_path(path))
        if not force and existing and existing.get("schema_version") == SCHEMA_VERSION and existing.get("source", {}).get("sha256") == checksum:
            if not metadata_path(path, "html").is_file():
                _write(path, existing)
            return existing
        data = pdf_extraction.extract(path) if kind(path) == "PDF" else _image_data(path)
        data.update(schema_version=SCHEMA_VERSION, media_type=kind(path),
                    extracted_at=datetime.now(timezone.utc).isoformat(),
                    source={"path": relative(path), "sha256": checksum, "size_bytes": path.stat().st_size},
                    trashed=".trash" in path.parts)
        return _write(path, data)


def read(path: Path) -> dict | None:
    if not kind(path):
        return None
    with _lock:
        data = read_json_object(metadata_path(path))
        if data:
            if not data.get('artifacts', {}).get('html'):
                _write(path, data)
            data["stale"] = data.get("schema_version") != SCHEMA_VERSION or data.get("source", {}).get("sha256") != fingerprint(path)
        return data


def summary(path: Path) -> dict | None:
    try:
        data = read_json_object(metadata_path(path)) if kind(path) else None
    except ValueError:
        return None
    return {key: data.get(key) for key in ("status", "artifacts", "extracted_at")} if data else None



def save_upload(path: Path, source: BinaryIO, *, extract: bool = True) -> dict | None:
    """Replace the source atomically; bulk imports can leave extraction on demand."""
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
                temporary = Path(handle.name)
                shutil.copyfileobj(source, handle)
            temporary.replace(path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
        if extract:
            return ensure(path)
        # A replaced file must not advertise results from an older PDF.
        remove(path)
        return None


def remove(path: Path) -> None:
    """Drop sidecars for a source file or a directory (including deleted sources)."""
    with _lock:
        rel = relative(path)
        for media in ("PDF", "Images"):
            base = resolve_inside(settings.storage_path, f".meta_kavot/{media}/{rel}")
            if base.is_dir():
                shutil.rmtree(base)
            for extension in ("json", "md", "html"):
                base.with_name(f"{base.name}.{extension}").unlink(missing_ok=True)


def move(source: Path, target: Path) -> None:
    """Move a workspace asset/folder and relocate its metadata without rerunning OCR."""
    with _lock:
        if source.resolve() == target.resolve():
            return
        old = relative(source)
        new = relative(target)
        shutil.move(str(source), str(target))
        for media in ("PDF", "Images"):
            base = resolve_inside(settings.storage_path, f".meta_kavot/{media}/{old}")
            candidates = list(base.rglob("*.json")) if base.is_dir() else [base.with_name(base.name + ".json")]
            for candidate in candidates:
                data = read_json_object(candidate)
                if not data:
                    continue
                old_path = data.get("source", {}).get("path", "")
                if old_path != old and not old_path.startswith(old + "/"):
                    continue
                moved = resolve_inside(settings.storage_path, new + old_path[len(old):])
                if not kind(moved):
                    continue
                if kind(moved) != data.get("media_type"):
                    ensure(moved, force=True)
                    continue
                data["source"]["path"] = relative(moved)
                data["trashed"] = ".trash" in moved.parts
                _write(moved, data)
        remove(source)
