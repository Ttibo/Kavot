"""Local file helpers of the cloud sync: which files sync, how they are read, hashed and walked."""
from __future__ import annotations

import hashlib
import io
import os
import platform
import re
import time
from pathlib import Path
from typing import Iterator

# .kavot-local holds derived, per-device data (search index, change journal).
EXCLUDED_PARTS = {".kavot-conflicts", ".kavot-backups", ".kavot-local"}
# Files of the system and of editors that a drive never syncs.
IGNORED_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", ".localized", "Icon\r"}
IGNORED_SUFFIXES = (".tmp", ".swp", ".swo", ".crdownload", ".part", ".partial")


def ignored(name: str) -> bool:
    """System and editor files (Office locks, temporary files) stay on this device."""
    return (name in IGNORED_NAMES or name.startswith(("~$", ".~lock.", ".kavot-download-"))
            or name.endswith(IGNORED_SUFFIXES))


def walk(root: Path) -> Iterator[tuple[str, os.DirEntry]]:
    """(relative POSIX path, entry) of the regular files and links of a workspace.

    Kavot's own folders are pruned without being entered, links are yielded
    but never followed, and ignored file names are left out. Entries come in
    a stable order so a signature of the walk is deterministic.
    """
    stack = [("", str(root))]
    while stack:
        prefix, folder = stack.pop()
        try:
            with os.scandir(folder) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError:
            continue
        for entry in entries:
            if entry.name in EXCLUDED_PARTS:
                continue
            relative = prefix + entry.name
            try:
                if entry.is_symlink():
                    yield relative, entry
                elif entry.is_dir():
                    stack.append((relative + "/", entry.path))
                elif entry.is_file() and not ignored(entry.name):
                    yield relative, entry
            except OSError:
                continue


def tree_fingerprint(root) -> str:
    """Cheap stat-only signature of a folder, ignoring Kavot copies."""
    digest = hashlib.sha256()
    for relative, entry in walk(Path(root)):
        try:
            if entry.is_symlink() or any(ignored(part) for part in relative.split("/")[:-1]):
                continue
            info = entry.stat()
        except OSError:
            continue
        digest.update(f"{entry.path}|{info.st_size}|{info.st_mtime_ns}|".encode("utf-8", "surrogatepass"))
    return digest.hexdigest()


def device_name() -> str:
    return re.sub(r"[^\w .-]", "", platform.node() or "this device")[:40].strip() or "this device"


def conflict_copy(target: Path) -> Path:
    """The name a drive gives the other version of a file changed on two devices."""
    suffix = target.suffix
    stem = target.name[:-len(suffix)] if suffix else target.name
    stamp = time.strftime("%Y-%m-%d %H.%M")
    candidate = target.with_name(f"{stem[:120]} (conflict copy {stamp} {device_name()}){suffix}")
    number = 2
    while candidate.exists():
        candidate = target.with_name(f"{stem[:120]} (conflict copy {stamp} {device_name()} {number}){suffix}")
        number += 1
    return candidate


class FileData:
    """A bounded-memory file payload, optionally owning a temporary download."""
    def __init__(self, path, temporary=False):
        self.path, self.temporary = Path(path), temporary

    def __len__(self):
        return self.path.stat().st_size

    def __bool__(self):
        return True

    def decode(self, encoding):
        return self.path.read_bytes().decode(encoding)

    def __del__(self):
        if self.temporary:
            self.path.unlink(missing_ok=True)


def reader(data):
    return data.path.open("rb") if isinstance(data, FileData) else io.BytesIO(data)


def sha(data) -> str:
    digest = hashlib.sha256()
    with reader(data) as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def create_without_overwrite(source: Path, target: Path, *, move=False):
    """Publish a file only if target is absent, including restricted Windows hosts."""
    try:
        os.link(source, target)
        return
    except PermissionError:
        if os.name != "nt":
            raise
    if move:
        # On Windows rename is atomic and refuses to replace an existing file.
        os.rename(source, target)
        return
    with source.open("rb") as source_file, target.open("xb") as writer:
        while chunk := source_file.read(1024 * 1024):
            writer.write(chunk)
        writer.flush()
        os.fsync(writer.fileno())
