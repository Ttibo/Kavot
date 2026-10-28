param(
    [ValidateSet('desktop', 'web')]
    [string]$Mode = 'desktop'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$projectPython = Join-Path $projectRoot '.venv/Scripts/python.exe'
if ($env:KAVOT_PYTHON) {
    $projectPython = $env:KAVOT_PYTHON
} elseif (-not (Test-Path -LiteralPath $projectPython)) {
    throw 'Create the Kavot environment: python -m venv .venv; then ./.venv/Scripts/python.exe -m pip install -e ".[desktop]"'
}

Push-Location $projectRoot
try {
    & $projectPython -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Kavot requires Python 3.10 or later.")'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($Mode -eq 'web') {
        & $projectPython -m uvicorn app.main:app --host 127.0.0.1 --port 8000
    } else {
        if (-not (Test-Path -LiteralPath 'frontend/static/index.html')) {
            throw 'Build the interface: npm --prefix frontend ci, then npm --prefix frontend run build'
        }
        & $projectPython desktop.py
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
