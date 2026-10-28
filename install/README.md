# Building the installers

Each platform is built on that platform. The scripts create a dedicated Python
environment in `install/build/venv`, build the frontend, bundle the app with
[PyInstaller](https://pyinstaller.org) (`kavot.spec`) and package it. Results go to
`install/dist/`.

| Platform | Command | Output |
| --- | --- | --- |
| Windows | `.\install\build-windows.ps1` | `Kavot-<version>-windows-x64-setup.exe` |
| macOS | `sh install/build-macos.sh` | `Kavot-<version>-macos-<arch>.dmg` |
| Linux | `sh install/build-linux.sh` | `Kavot-<version>-linux-<arch>.AppImage` and `.tar.gz` |

The version comes from `pyproject.toml`.

Options, passed to any of the three scripts:

- `--skip-frontend` reuses the current `frontend/static` build;
- `--bundle-only` stops after the PyInstaller bundle (`install/dist/Kavot` or `Kavot.app`).

## Requirements

All platforms: Python 3.10+, Node.js 20.19+ (or 22.12+) and npm.

**Windows**
- [Inno Setup 6](https://jrsoftware.org/isinfo.php) to produce the `setup.exe`. Without it,
  the script produces a `.zip` of the app instead.
- Users need the Microsoft Edge WebView2 runtime, included in Windows 10 and 11.
- Unsigned installers trigger a SmartScreen warning. Sign `Kavot.exe` and the setup with
  `signtool` and a code-signing certificate before publishing.

**macOS**
- Xcode command line tools (`xcode-select --install`).
- Build on each architecture you ship (Apple silicon `arm64`, Intel `x86_64`).
- To sign, set `KAVOT_CODESIGN_IDENTITY` to your *Developer ID Application* identity. Then
  notarize the disk image so Gatekeeper accepts it:

  ```sh
  xcrun notarytool submit install/dist/Kavot-<version>-macos-arm64.dmg \
    --apple-id <id> --team-id <team> --password <app-specific-password> --wait
  xcrun stapler staple install/dist/Kavot-<version>-macos-arm64.dmg
  ```

**Linux**
- The window uses Qt WebEngine, installed in the build environment through `pywebview[qt]`.
- Put [appimagetool](https://github.com/AppImage/appimagetool) on the `PATH` to also produce
  an AppImage. Build on the oldest distribution you support (glibc compatibility).

## Files

```text
build.py               Orchestrates frontend build, bundle and packaging
kavot.spec             PyInstaller spec shared by every platform
make_icons.py          Draws kavot.ico / .icns / .png from the logo
build-*.ps1, build-*.sh  Platform entry points
windows/kavot.iss      Inno Setup script (keep its AppId: it identifies upgrades)
macos/entitlements.plist  Hardened runtime entitlements for signing
linux/kavot.desktop    Menu entry for the AppImage and the archive
```

`install/build/` and `install/dist/` are generated and ignored by git.
