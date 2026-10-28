from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


# app/ and the repository (or bundle) root.
APP_DIR = Path(__file__).resolve().parents[2]
BASE_DIR = APP_DIR.parent
RESOURCES_DIR = APP_DIR / "resources"


def _default_storage_root() -> Path:
    # KAVOT_STORAGE_PATH from the environment or a .env file, then older settings.json.
    from app.core.kernel.user_settings import load_storage_path

    persisted = load_storage_path()
    return persisted if persisted else BASE_DIR / "data"

@dataclass(frozen=True)
class Settings:
    storage_root: Path = field(default_factory=_default_storage_root)

    @property
    def storage_path(self) -> Path:
        return self.storage_root

    @property
    def library_path(self) -> Path:
        return self.storage_path / "library"

    @property
    def projects_path(self) -> Path:
        return self.storage_path / "projects"

    @property
    def notes_path(self) -> Path:
        return self.storage_path / "notes"

    @property
    def databases_path(self) -> Path:
        return self.storage_path / "databases"

    @property
    def state_path(self) -> Path:
        return self.storage_path / "kavot.state.json"


settings = Settings()
