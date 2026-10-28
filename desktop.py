"""Native desktop launcher for Kavot.

The launcher starts the local FastAPI service on an available loopback port,
then displays it in a pywebview window. Project manifests, canvases and user
resources stay in the selected local workspace as portable files.

On first launch (no storage location saved yet), the user is asked where to
keep their data via a native folder dialog. The choice is persisted outside
the storage folder itself (see app.core.user_settings) so it survives restarts.
Changing it later from the Configuration page goes through the exposed
`pick_storage_folder` bridge below plus the `/api/settings/storage` endpoint.
"""

from __future__ import annotations

import html
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn
import webview

from app.core.kernel import env

HOST = "127.0.0.1"
# Also retain window controls while the service starts or displays an error.
BOOTSTRAP_HEADER = """
<style>
.startup-header { position:fixed; inset:0 0 auto; height:42px; display:flex;
align-items:stretch; background:#10171d; color:#eef2f4; user-select:none; }
.startup-drag { flex:1; padding:12px 18px; font-size:13px; }
.startup-header button { width:46px; border:0; background:transparent; color:inherit; }
.startup-header button:hover { background:#293440; }
.startup-header button:last-child:hover { background:#c42b3b; }
</style>
<header class="startup-header">
<div class="startup-drag pywebview-drag-region"
ondblclick="window.pywebview?.api?.toggle_maximize_window()">Kavot</div>
<button aria-label="Minimize" onclick="window.pywebview?.api?.minimize_window()">&#8722;</button>
<button aria-label="Agrandir ou restaurer" onclick="window.pywebview?.api?.toggle_maximize_window()">&#9633;</button>
<button aria-label="Close" onclick="window.pywebview?.api?.close_window()">&#215;</button>
</header>
"""
LOADING_HTML = """
<!doctype html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;
justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
background:#10171d;color:#eef2f4">
<p>Starting Kavot…</p>
</body></html>
"""

ERROR_HTML = """
<!doctype html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="box-sizing:border-box;margin:0;min-height:100vh;padding:48px;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
background:#10171d;color:#eef2f4;display:grid;place-items:center">
<main style="max-width:720px"><p style="color:#e9aa6a">Kavot could not start</p>
<h1 style="font-size:28px">Erreur du service local</h1>
<p>Close this window, fix the error below, then start Kavot again.</p>
<pre style="white-space:pre-wrap;background:#18232b;padding:18px;border-radius:10px;
color:#ffccba">{message}</pre></main></body></html>
"""

if sys.platform == "darwin":
    BOOTSTRAP_HEADER += """
    <style>
    .startup-header button { position:relative; isolation:isolate; color:transparent; }
    .startup-header button::before { content:''; position:absolute; width:13px; height:13px;
      border-radius:50%; background:#febc2e; inset:0; margin:auto; z-index:-1; }
    .startup-header button:nth-of-type(2)::before { background:#28c840; }
    .startup-header button:last-child::before { background:#ff5f57; }
    .startup-header button:hover { background:transparent; color:#302b25; }
    </style>
    """
LOADING_HTML = LOADING_HTML.replace("</body>", BOOTSTRAP_HEADER + "</body>")
ERROR_HTML = ERROR_HTML.replace("</body>", BOOTSTRAP_HEADER + "</body>")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        return sock.getsockname()[1]


def _wait_until_ready(url: str, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            time.sleep(0.1)
    raise RuntimeError("The Kavot server did not start in time")


def _choose_initial_storage_path(window) -> Path:
    from app.core.kernel.user_settings import load_storage_path, save_storage_path

    existing = load_storage_path()
    if existing:
        existing.mkdir(parents=True, exist_ok=True)
        return existing
    selection = window.create_file_dialog(
        webview.FileDialog.FOLDER, directory=str(Path.home())
    )
    chosen = Path(selection[0]) if selection else Path.home() / "Kavot"
    chosen.mkdir(parents=True, exist_ok=True)
    save_storage_path(chosen)
    return chosen


def _bootstrap(window) -> None:
    server: uvicorn.Server | None = None
    server_thread: threading.Thread | None = None
    try:
        storage_path = _choose_initial_storage_path(window)
        os.environ["KAVOT_STORAGE_PATH"] = str(storage_path)
        os.environ["KAVOT_DESKTOP"] = "1"

        from app.main import (
            app,  # deferred: app.core.config.settings must see the workspace first
        )

        port = _free_port()
        base_url = f"http://{HOST}:{port}"
        config = uvicorn.Config(
            app,
            host=HOST,
            port=port,
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(config)

        started_at = time.monotonic()
        server_thread = threading.Thread(
            target=server.run,
            name="kavot-local-api",
            daemon=True,
        )
        server_thread.start()
        _wait_until_ready(f"{base_url}/api/health", timeout=30.0)
        print(
            f"[kavot-desktop] server ready in "
            f"{time.monotonic() - started_at:.2f}s sur {base_url}",
            flush=True,
        )

        def stop_server() -> None:
            if server is not None:
                server.should_exit = True
            if server_thread is not None and server_thread.is_alive():
                server_thread.join(timeout=5.0)

        window.events.closed += stop_server
        # Replace the bootstrap document so Back cannot reopen the splash screen.
        window.evaluate_js(f"window.location.replace({json.dumps(base_url)})")
    except Exception as error:
        if server is not None:
            server.should_exit = True
        message = f"{type(error).__name__}: {error}"
        print(f"[kavot-desktop] {message}", file=sys.stderr, flush=True)
        window.load_html(ERROR_HTML.replace("{message}", html.escape(message)))


def main() -> None:
    import multiprocessing
    multiprocessing.freeze_support()
    from app.core.kernel.user_settings import config_dir
    from app.core.kernel.desktop_window import install_resize_support, install_close_support

    window = webview.create_window(
        "Kavot",
        html=LOADING_HTML,
        width=1320,
        height=860,
        min_size=(760, 520),
        resizable=True,
        frameless=True,
        easy_drag=False,
        shadow=True,
        background_color="#10171d",
        text_select=True,
    )
    if window is None:
        raise RuntimeError("pywebview could not create the Kavot window")

    window.state.maximized = False

    def remember_maximized():
        window.state.maximized = True

    def remember_restored():
        window.state.maximized = False

    window.events.maximized += remember_maximized
    window.events.restored += remember_restored

    def minimize_window():
        window.minimize()

    def toggle_maximize_window():
        if window.state.maximized:
            window.restore()
        else:
            window.maximize()

    close_window = install_close_support(window)

    def pick_storage_folder():
        selection = window.create_file_dialog(
            webview.FileDialog.FOLDER, directory=str(Path.home())
        )
        return selection[0] if selection else None

    def open_external_url(url: str):
        if not isinstance(url, str) or not url.lower().startswith(("https://", "http://", "mailto:")):
            return False
        return webbrowser.open(url)

    def pick_project_resource_folder():
        selection = window.create_file_dialog(
            webview.FileDialog.FOLDER, directory=str(Path.home())
        )
        return selection[0] if selection else None

    def open_project_resource(target: str):
        """Open a validated web address or an existing local folder for a project."""
        if not isinstance(target, str) or not target.strip():
            return False
        target = target.strip()
        if target.startswith(("https://", "http://")):
            return webbrowser.open(target)
        path = Path(target).expanduser()
        if not path.is_absolute() or not path.exists():
            return False
        try:
            if sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            elif os.name == "nt":
                os.startfile(str(path))
            else:
                subprocess.Popen(["xdg-open", str(path)])
            return True
        except OSError:
            return False

    window.expose(
        minimize_window,
        toggle_maximize_window,
        close_window,
        pick_storage_folder,
        open_external_url,
        pick_project_resource_folder,
        open_project_resource,
    )
    install_resize_support(window)
    webview.start(
        _bootstrap,
        window,
        debug=env.get("KAVOT_WEBVIEW_DEBUG").lower() in {"1", "true", "yes"},
        private_mode=False,
        storage_path=str(config_dir() / "webview"),
    )


if __name__ == "__main__":
    main()
