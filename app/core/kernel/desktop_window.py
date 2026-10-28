"""Platform-specific window lifecycle and borderless Windows gestures."""

import ctypes
import math
import re
import sys
import threading
from ctypes import wintypes
from app.core.kernel.config import RESOURCES_DIR

RESIZE_SCRIPT = (RESOURCES_DIR / "window-resize.js").read_text(encoding="utf-8")
HIT_TESTS = {"w": 10, "e": 11, "n": 12, "nw": 13, "ne": 14, "s": 15, "sw": 16, "se": 17}


def install_close_support(window):
    """Close without sending a bridge reply to a destroyed Cocoa webview.

    pywebview calls evaluate_js after every exposed function returns. On Cocoa,
    closing the last window stops the event loop that would complete that call,
    leaving its non-daemon bridge thread waiting forever.
    """
    if sys.platform != "darwin":
        def close_window():
            window.destroy()
        return close_window

    closing = threading.Event()
    evaluate_js = window.evaluate_js

    def evaluate(script, *args, **kwargs):
        if closing.is_set():
            return None
        return evaluate_js(script, *args, **kwargs)

    def mark_closed():
        closing.set()

    def close_window():
        if closing.is_set():
            return
        closing.set()
        window.destroy()

    window.evaluate_js = evaluate
    # Also cover the native traffic light and the application menu.
    window.events.closed += mark_closed
    return close_window


def guard_native_replies(window) -> None:
    """Discard native gesture replies belonging to a document that has unloaded.

    pywebview delivers exposed API results through evaluate_js. Its generated
    callback is unconditional, even when navigation removed that callback while
    Windows was running the modal move/resize loop. Only guard these two replies;
    other scripts and JavaScript failures retain their normal behavior.
    """
    if getattr(window, '_kavot_native_replies_guarded', False):
        return
    evaluate_js = window.evaluate_js
    reply = re.compile(
        r'^window\.pywebview\._returnValuesCallbacks\["(move_window|resize_window)"\]'
        r'\["([0-9]+)"\]\(([\s\S]*)\)$'
    )

    def evaluate(script, *args, **kwargs):
        match = reply.fullmatch(script)
        if match:
            command, request_id, result = match.groups()
            script = (
                '(() => { const callback = window.pywebview?._returnValuesCallbacks'
                f'?.["{command}"]?.["{request_id}"]; '
                f'if (typeof callback === "function") return callback({result}); '
                '})()'
            )
        return evaluate_js(script, *args, **kwargs)

    window.evaluate_js = evaluate
    window._kavot_native_replies_guarded = True


def begin_resize(window, edge: str) -> bool:
    if sys.platform != "win32" or edge not in HIT_TESTS or not window.resizable:
        return False

    # Bridge functions run on worker threads. Release WebView2's mouse capture
    # and enter the OS sizing loop on the owning WinForms UI thread.
    from System import Action

    native = window.native
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.ReleaseCapture.argtypes = []
    user32.ReleaseCapture.restype = wintypes.BOOL
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.IsZoomed.restype = wintypes.BOOL
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.SendMessageW.restype = ctypes.c_ssize_t
    user32.GetMessagePos.argtypes = []
    user32.GetMessagePos.restype = wintypes.DWORD

    def resize():
        hwnd = native.Handle.ToInt64()
        if user32.IsZoomed(hwnd):
            return
        user32.ReleaseCapture()
        # WM_NCLBUTTONDOWN with an edge hit-test enters native mouse sizing.
        # Windows handles DPI, minimum size, and dragging beyond the webview.
        user32.SendMessageW(hwnd, 0x00A1, HIT_TESTS[edge], user32.GetMessagePos())

    native.Invoke(Action(resize))
    return True


def begin_move(window, horizontal_anchor: float, header_offset: float) -> bool:
    if sys.platform != "win32":
        return False
    if not all(isinstance(value, (int, float)) and math.isfinite(value)
               for value in (horizontal_anchor, header_offset)):
        return False
    from System import Action

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    signatures = {
        "GetCursorPos": ([ctypes.POINTER(wintypes.POINT)], wintypes.BOOL),
        "GetWindowRect": ([wintypes.HWND, ctypes.POINTER(wintypes.RECT)], wintypes.BOOL),
        "IsZoomed": ([wintypes.HWND], wintypes.BOOL),
        "GetAsyncKeyState": ([ctypes.c_int], ctypes.c_short),
        "GetDpiForWindow": ([wintypes.HWND], wintypes.UINT),
        "ShowWindow": ([wintypes.HWND, ctypes.c_int], wintypes.BOOL),
        "SetWindowPos": ([wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                          ctypes.c_int, ctypes.c_int, wintypes.UINT], wintypes.BOOL),
        "ReleaseCapture": ([], wintypes.BOOL),
        "SendMessageW": ([wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM], ctypes.c_ssize_t),
    }
    for name, (args, result) in signatures.items():
        function = getattr(user32, name)
        function.argtypes, function.restype = args, result

    def move():
        # A quick release can reach Windows before the asynchronous bridge call.
        if not user32.GetAsyncKeyState(1) & 0x8000:
            return
        hwnd = window.native.Handle.ToInt64()
        cursor = wintypes.POINT()
        if not user32.GetCursorPos(ctypes.byref(cursor)):
            return
        if user32.IsZoomed(hwnd):
            scale = (user32.GetDpiForWindow(hwnd) or 96) / 96
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE preserves the previous size.
            window.state.maximized = False
            bounds = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(bounds)):
                x = cursor.x - round((bounds.right - bounds.left) * max(0, min(1, horizontal_anchor)))
                y = cursor.y - round(max(0, min(42, header_offset)) * scale)
                user32.SetWindowPos(hwnd, None, x, y, 0, 0, 0x0015)  # NOSIZE | NOZORDER | NOACTIVATE
        user32.ReleaseCapture()
        position = (cursor.x & 0xFFFF) | ((cursor.y & 0xFFFF) << 16)
        user32.SendMessageW(hwnd, 0x00A1, 2, position)  # HTCAPTION: native move loop

    window.native.Invoke(Action(move))
    return True


def install_resize_support(window) -> None:
    if sys.platform != "win32":
        return

    guard_native_replies(window)

    def resize_window(edge: str):
        return begin_resize(window, edge)

    def move_window(horizontal_anchor: float, header_offset: float):
        return begin_move(window, horizontal_anchor, header_offset)

    def install_handles():
        window.run_js(RESIZE_SCRIPT)

    window.expose(resize_window, move_window)
    window.events.loaded += install_handles
