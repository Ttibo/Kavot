# PyInstaller spec shared by Windows, macOS and Linux. Run through install/build.py.
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
ICONS = Path(SPECPATH) / "build" / "icons"
VERSION = re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text(encoding="utf-8"), re.M).group(1)

# The built frontend and the backend resources are read relative to the app package.
datas = [
    (str(ROOT / "frontend" / "static"), "frontend/static"),
    (str(ROOT / "app" / "resources"), "app/resources"),
    # Plugin manifests are read from disk at startup.
    *[(str(manifest), f"app/plugins/{manifest.parent.name}") for manifest in (ROOT / "app" / "plugins").glob("*/plugin.json")],
]
for package in ("latex2mathml", "pdfminer", "pdfplumber", "mcp", "bleach", "tinycss2"):
    datas += collect_data_files(package)

# Routes, services and server internals are imported dynamically.
hiddenimports = [
    *collect_submodules("app"),
    *collect_submodules("uvicorn"),
    *collect_submodules("keyring.backends"),
    # mcp.cli is an optional developer CLI that exits when its extras are missing.
    *collect_submodules("mcp", filter=lambda name: not name.startswith("mcp.cli")),
]

analysis = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "mcp.cli"],
    noarchive=False,
)
pyz = PYZ(analysis.pure)

icon = {"win32": ICONS / "kavot.ico", "darwin": ICONS / "kavot.icns"}.get(sys.platform, ICONS / "kavot.png")
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="Kavot",
    console=False,
    icon=str(icon),
    upx=False,
)
collected = COLLECT(exe, analysis.binaries, analysis.datas, name="Kavot", upx=False)

if sys.platform == "darwin":
    app = BUNDLE(
        collected,
        name="Kavot.app",
        icon=str(icon),
        bundle_identifier="cloud.kavot.app",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": "Kavot",
            "CFBundleShortVersionString": VERSION,
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
        },
    )
