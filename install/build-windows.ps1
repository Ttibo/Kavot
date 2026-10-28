# Builds the Kavot Windows installer (install\dist\Kavot-<version>-windows-x64-setup.exe).
# Requirements: Python 3.10+, Node.js 20.19+ with npm, and Inno Setup 6 for the setup.exe
# (without it, a .zip of the app is produced instead).
# Usage: .\install\build-windows.ps1 [--skip-frontend] [--bundle-only]
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $PSScriptRoot 'build\venv'
$Python = if ($env:KAVOT_PYTHON) { $env:KAVOT_PYTHON } else { 'python' }

# A dedicated environment keeps the bundle free of unrelated packages.
if (-not (Test-Path (Join-Path $Venv 'Scripts\python.exe'))) { & $Python -m venv $Venv }
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -e "${Root}[desktop,build]"
& $VenvPython (Join-Path $PSScriptRoot 'build.py') @args
exit $LASTEXITCODE
