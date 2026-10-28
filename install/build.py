"""Build the Kavot desktop installer for the current platform.

    python install/build.py                 # frontend + app bundle + installer
    python install/build.py --skip-frontend # reuse frontend/static
    python install/build.py --bundle-only   # stop after the PyInstaller bundle

Outputs go to install/dist/:
  Windows  Kavot-<version>-windows-x64-setup.exe (Inno Setup) or a .zip without it
  macOS    Kavot-<version>-macos-<arch>.dmg
  Linux    Kavot-<version>-linux-x86_64.AppImage (with appimagetool) and a .tar.gz

Run it with the Python environment that has Kavot installed with the desktop and
build extras (the platform scripts next to this file prepare it).
"""

from __future__ import annotations

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

INSTALL = Path(__file__).resolve().parent
ROOT = INSTALL.parent
BUILD = INSTALL / "build"
DIST = INSTALL / "dist"


def run(*command: str | Path, cwd: Path = ROOT) -> None:
    print("$", " ".join(str(part) for part in command), flush=True)
    subprocess.run([str(part) for part in command], cwd=cwd, check=True)


def version() -> str:
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    return re.search(r'^version = "([^"]+)"', text, re.M).group(1)


def build_frontend() -> None:
    npm = shutil.which("npm") or sys.exit("npm is required to build the frontend.")
    # Vite keeps old hashed files (emptyOutDir is off for development): start clean
    # so the installer only ships the current build.
    shutil.rmtree(ROOT / "frontend" / "static", ignore_errors=True)
    run(npm, "--prefix", "frontend", "ci")
    run(npm, "--prefix", "frontend", "run", "build")


def build_bundle() -> Path:
    run(sys.executable, INSTALL / "make_icons.py", BUILD / "icons")
    shutil.rmtree(DIST / "Kavot", ignore_errors=True)
    shutil.rmtree(DIST / "Kavot.app", ignore_errors=True)
    run(sys.executable, "-m", "PyInstaller", INSTALL / "kavot.spec", "--noconfirm", "--clean",
        "--distpath", DIST, "--workpath", BUILD / "pyinstaller")
    return DIST / ("Kavot.app" if sys.platform == "darwin" else "Kavot")


def package_windows(bundle: Path, name: str) -> Path:
    iscc = shutil.which("iscc") or next((str(path) for path in (
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Inno Setup 6" / "ISCC.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Inno Setup 6" / "ISCC.exe") if path.is_file()), None)
    if not iscc:
        print("Inno Setup (iscc) not found: creating a zip instead of a setup.exe.")
        return Path(shutil.make_archive(str(DIST / f"{name}-windows-x64"), "zip", bundle.parent, bundle.name))
    run(iscc, f"/DAppVersion={version()}", f"/DSourceDir={bundle}", f"/DOutputDir={DIST}",
        f"/DOutputName={name}-windows-x64-setup", f"/DIconFile={BUILD / 'icons' / 'kavot.ico'}",
        INSTALL / "windows" / "kavot.iss")
    return DIST / f"{name}-windows-x64-setup.exe"


def package_macos(bundle: Path, name: str) -> Path:
    identity = os.environ.get("KAVOT_CODESIGN_IDENTITY")
    if identity:
        run("codesign", "--deep", "--force", "--options", "runtime", "--timestamp",
            "--entitlements", INSTALL / "macos" / "entitlements.plist", "--sign", identity, bundle)
    else:
        print("KAVOT_CODESIGN_IDENTITY not set: the app is not signed (Gatekeeper will warn).")
    staging = BUILD / "dmg"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    run("ditto", bundle, staging / bundle.name)
    (staging / "Applications").symlink_to("/Applications")
    dmg = DIST / f"{name}-macos-{platform.machine()}.dmg"
    dmg.unlink(missing_ok=True)
    run("hdiutil", "create", "-volname", "Kavot", "-srcfolder", staging, "-ov", "-format", "UDZO", dmg)
    return dmg


def package_linux(bundle: Path, name: str) -> Path:
    arch = platform.machine() or "x86_64"
    archive = DIST / f"{name}-linux-{arch}.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(bundle, arcname="Kavot")
        tar.add(INSTALL / "linux" / "kavot.desktop", arcname="Kavot/kavot.desktop")
        tar.add(BUILD / "icons" / "kavot-256.png", arcname="Kavot/kavot.png")
    tool = shutil.which("appimagetool")
    if not tool:
        print("appimagetool not found: only the .tar.gz was created.")
        return archive
    appdir = BUILD / "Kavot.AppDir"
    shutil.rmtree(appdir, ignore_errors=True)
    shutil.copytree(bundle, appdir / "usr" / "bin")
    shutil.copy(INSTALL / "linux" / "kavot.desktop", appdir / "kavot.desktop")
    shutil.copy(BUILD / "icons" / "kavot-256.png", appdir / "kavot.png")
    launcher = appdir / "AppRun"
    launcher.write_text('#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/Kavot" "$@"\n')
    launcher.chmod(0o755)
    image = DIST / f"{name}-linux-{arch}.AppImage"
    run(tool, appdir, image, cwd=BUILD)
    return image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-frontend", action="store_true", help="reuse the existing frontend/static build")
    parser.add_argument("--bundle-only", action="store_true", help="stop after the PyInstaller bundle")
    options = parser.parse_args()
    DIST.mkdir(parents=True, exist_ok=True)
    if not options.skip_frontend:
        build_frontend()
    if not (ROOT / "frontend" / "static" / "index.html").is_file():
        sys.exit("frontend/static is missing: run without --skip-frontend.")
    bundle = build_bundle()
    if options.bundle_only:
        print(f"Bundle ready: {bundle}")
        return
    name = f"Kavot-{version()}"
    packagers = {"win32": package_windows, "darwin": package_macos}
    output = packagers.get(sys.platform, package_linux)(bundle, name)
    print(f"\nInstaller ready: {output}")


if __name__ == "__main__":
    main()
