"""
ParkingManager desktop entry point.

This is the file PyInstaller packages into ParkingManager.exe. It:
  1. Starts the FastAPI/Uvicorn server in a background thread, bound to
     0.0.0.0 so phones on the local Wi-Fi can reach the customer pages.
  2. Waits for it to come up.
  3. Opens a native window (via pywebview, using the OS's built-in web
     renderer -- WebView2 on Windows 10/11) pointing at the admin dashboard
     on 127.0.0.1. Because it connects through localhost, it automatically
     satisfies LocalOnlyMiddleware and behaves as the trusted admin client.
  4. When the window is closed, the whole process exits (server included).

Run directly during development with:  python desktop_app.py
(add --headless to start only the server, without the window)
This opens the SAME dashboard a packaged .exe would -- useful for testing
the UI without building an installer first (requires a system webview
backend; see README for platform notes).

Things a packaged, windowed (no console) .exe needs that a terminal run hides:
  * sys.stdout / sys.stderr are None, which makes uvicorn's logging setup
    crash ("Unable to configure formatter 'default'") -- so the streams are
    pointed at a log file first (also handy for support: it lives next to the
    database as parkingmanager.log).
  * There is nowhere to print an error -- problems are shown in a message box.
  * pywebview cancels file downloads unless ALLOW_DOWNLOADS is switched on,
    which would make the CSV/Excel export buttons do nothing.
"""
import json
import os
import socket
import sys
import threading
import time
import urllib.request

from app import config


# ---------------------------------------------------------------------------
# Windowed-exe plumbing
# ---------------------------------------------------------------------------
def _ensure_std_streams() -> None:
    """Gives sys.stdout / sys.stderr a real destination when the process has
    no console (PyInstaller console=False sets them to None)."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_path = config.DATA_DIR / "parkingmanager.log"
    try:
        if log_path.exists() and log_path.stat().st_size > 2 * 1024 * 1024:
            log_path.unlink()                      # keep the log from growing forever
        stream = open(log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        stream = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream


_ensure_std_streams()

import uvicorn  # noqa: E402  (must come after the stream fix above)

# Import the ASGI app OBJECT here instead of handing uvicorn the string
# "app.main:app". PyInstaller only follows import statements it can see;
# uvicorn resolves that string at runtime, so a frozen build would bundle
# just `app.config` and then die with "Could not import module app.main"
# -- the packaged .exe would never start. A normal import makes PyInstaller
# collect app.main and everything it pulls in (routers, crud, models, ...).
from app.main import app as asgi_app  # noqa: E402


def _show_error(title: str, message: str) -> None:
    """Visible error for a windowed app; falls back to stderr elsewhere."""
    print(f"{title}: {message}", file=sys.stderr)
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)  # MB_ICONERROR
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------
_server_error: list[BaseException] = []


def _run_server():
    try:
        uvicorn.run(
            asgi_app,
            host=config.SERVER_HOST,
            port=config.SERVER_PORT,
            log_level="warning",
        )
    except BaseException as exc:  # noqa: BLE001 -- report it instead of dying silently
        _server_error.append(exc)


def _health(port: int):
    """Parsed /health JSON from whatever is listening on `port`, or None."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":
            # Lets a port in TIME_WAIT after a recent close count as free (on
            # Windows SO_REUSEADDR would instead allow stealing a live port).
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((config.SERVER_HOST, port))
            return True
        except OSError:
            return False


def _wait_for_server(port: int, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline and not _server_error:
        info = _health(port)
        if info and info.get("app") == "ParkingManager":
            return True
        time.sleep(0.2)
    return False


def main():
    port = config.SERVER_PORT

    info = _health(port)
    if info and info.get("app") == "ParkingManager":
        # ParkingManager is already running on this PC (second double-click):
        # just open another window onto the running server.
        pass
    elif not _port_is_free(port):
        _show_error(
            "ParkingManager",
            f"Port {port} is already in use by another program, so ParkingManager can't start.\n\n"
            "Close that program, or start ParkingManager on a different port by setting the "
            "PARKINGMANAGER_PORT environment variable (for example 8001).",
        )
        sys.exit(1)
    else:
        threading.Thread(target=_run_server, daemon=True).start()
        if not _wait_for_server(port):
            detail = f"\n\nDetails: {_server_error[0]!r}" if _server_error else ""
            _show_error(
                "ParkingManager",
                "The ParkingManager server did not start." + detail +
                f"\n\nSee {config.DATA_DIR / 'parkingmanager.log'} for more information.",
            )
            sys.exit(1)

    admin_url = f"http://127.0.0.1:{port}/admin"

    if "--headless" in sys.argv:
        # Server only, no window: for smoke-testing a build or running on a
        # PC with no desktop session. Stop it with Ctrl+C / by killing it.
        print(f"ParkingManager running headless at {admin_url}", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return

    try:
        import webview
    except ImportError:
        _show_error(
            "ParkingManager",
            "pywebview is not installed. Install it with:\n    pip install pywebview\n"
            f"...or open {admin_url} manually in a browser on this machine.",
        )
        sys.exit(1)

    # Without this, pywebview silently cancels every download: the History
    # screen's "Export CSV / Export Excel" buttons would appear to do nothing.
    # With it on, Windows shows a normal "Save as" dialog.
    webview.settings["ALLOW_DOWNLOADS"] = True

    webview.create_window(
        "ParkingManager", admin_url,
        width=1360, height=860, min_size=(1024, 680),
        background_color="#0b0e14",
    )
    # gui=None lets pywebview auto-pick the right backend for the OS
    # (WebView2 on Windows, WebKitGTK on Linux, Cocoa WebView on macOS).
    webview.start()

    # The window has closed -- the whole process (including the daemon
    # server thread) exits here.


if __name__ == "__main__":
    main()
