"""Local Tesseract OCR used by PDF extraction. Source files never leave the computer."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def executable() -> str | None:
    located = shutil.which("tesseract")
    if located:
        return located
    # Desktop launches on macOS do not always inherit the terminal PATH.
    return next((str(path) for path in (Path("/opt/homebrew/bin/tesseract"), Path("/usr/local/bin/tesseract")) if path.is_file()), None)


def capabilities() -> dict:
    binary = executable()
    languages: list[str] = []
    if binary:
        try:
            result = subprocess.run([binary, "--list-langs"], capture_output=True, text=True, encoding="utf-8", timeout=10, check=False)
            if result.returncode == 0:
                languages = [line.strip() for line in result.stdout.splitlines() if line.strip() and " " not in line.strip() and line.strip() not in {"osd", "snum"}]
        except (OSError, subprocess.TimeoutExpired):
            pass
    default = "+".join(language for language in ("fra", "eng") if language in languages) or next(iter(languages), "")
    return {"available": bool(languages), "languages": languages, "default_language": default,
            "message": "OCR runs locally. Select the language in your image." if languages else "Install Tesseract and its language data, then reopen this image to use OCR."}

