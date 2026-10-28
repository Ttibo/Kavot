"""Recognize older generated reviews so workspace mutations preserve them."""

from pathlib import Path

from app.core.kernel.config import settings


FILENAME = "relations.generated.html"
GENERAL_FILENAME = "general-review.generated.html"


def is_overview(path: Path) -> bool:
    resolved = path.resolve()
    if resolved == (settings.notes_path / "general" / GENERAL_FILENAME).resolve():
        return True
    return path.name in {FILENAME, "relations.generated.md"} and resolved.parent.parent == settings.projects_path.resolve()
