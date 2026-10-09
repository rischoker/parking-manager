"""In-process unit tests plus checks on how the desktop app starts."""
import json
import os
import socket
import sqlite3
import subprocess
import sys
import textwrap
import time
import urllib.request
from datetime import datetime

import pytest

from conftest import PROJECT_ROOT, Server, free_port


# ---------------------------------------------------------- monthly fees ----
def test_monthly_due_date_returns_to_the_original_billing_day():
    """v1.0: Jan 31 -> Feb 28 -> Mar 28 -> ... drifted to the 28th for good."""
    from app.crud import _add_one_month
    due, seen = datetime(2026, 1, 31, 9, 0), []
    for _ in range(4):
        due = _add_one_month(due, anchor_day=31)
        seen.append(due.strftime("%m-%d"))
    assert seen == ["02-28", "03-31", "04-30", "05-31"]


# ------------------------------------------------------------ cloud sync ----
def test_cloud_sync_gives_up_the_cycle_at_the_first_connectivity_failure():
    """v1.0: every active session waited out its own 8-second timeout."""
    from app import cloud_sync, crud
    from app.database import SessionLocal, init_db
    from app.seed_data import seed_core

    init_db()
    db = SessionLocal()
    try:
        seed_core(db)
        for i in range(3):
            crud.create_session(db, f"Sync {i}", f"SYN{i:03d}", None)
        # port 1 on localhost: connection refused immediately
        cloud_sync.set_config(db, enabled=True, url="http://127.0.0.1:1/exec", secret="x")
        started = time.time()
        result = cloud_sync.sync_pending_sessions(db)
        assert result["attempted"] == 1 and result["succeeded"] == 0, result
        assert time.time() - started < 5
        assert "Connection failed" in result["message"]
    finally:
        db.close()


# -------------------------------------------------------- DB migration ------
def test_migration_adds_and_backfills_pricing_type_on_an_old_database(tmp_path):
    """An existing parking.db from v1.0 has no pricing_type column."""
    srv = Server(tmp_path, free_port()).start()
    try:
        admin = srv.client(); admin.login()
        status, body, _ = srv.client().call(
            "POST", "/api/customer/register", {"name": "Legacy", "plate": "LEG001"},
            headers={"CF-Connecting-IP": "192.0.2.1"})
        assert status == 200
    finally:
        srv.stop()

    db_path = tmp_path / "parking.db"
    con = sqlite3.connect(db_path)
    con.execute("ALTER TABLE parking_sessions DROP COLUMN pricing_type")      # recreate the v1.0 schema
    con.execute("UPDATE parking_sessions SET pricing_config_snapshot = ?", (json.dumps({"flat_rate": 25000}),))
    con.commit(); con.close()

    srv = Server(tmp_path, free_port()).start()      # boot -> migration runs
    try:
        con = sqlite3.connect(db_path)
        cols = {r[1] for r in con.execute("PRAGMA table_info(parking_sessions)")}
        assert "pricing_type" in cols
        assert con.execute("SELECT pricing_type FROM parking_sessions").fetchone()[0] == "FLAT"
        con.close()
    finally:
        srv.stop()


# --------------------------------------------- desktop app / packaged .exe ----
def _run_desktop(code: str, data_dir, port: int, wait: float):
    env = dict(os.environ, PARKINGMANAGER_DATA_DIR=str(data_dir), PARKINGMANAGER_PORT=str(port))
    return subprocess.Popen([sys.executable, "-c", textwrap.dedent(code)], cwd=PROJECT_ROOT, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def test_server_starts_when_the_process_has_no_console(tmp_path):
    """v1.0: a windowed PyInstaller exe has sys.stdout/stderr = None, which made
    uvicorn crash with "Unable to configure formatter 'default'" -- the server
    (and so the app) never started."""
    port = free_port()
    proc = _run_desktop("""
        import sys
        sys.stdout = None; sys.stderr = None      # what console=False gives you
        sys.argv = ["ParkingManager.exe", "--headless"]
        import desktop_app
        desktop_app.main()
    """, tmp_path, port, 20)
    try:
        ok = False
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                    ok = json.loads(r.read())["app"] == "ParkingManager"
                    break
            except Exception:
                time.sleep(0.2)
        assert ok, proc.poll()
        assert (tmp_path / "parkingmanager.log").exists(), "output is redirected to a log file"
    finally:
        proc.kill()


def test_port_already_in_use_fails_fast_with_a_clear_message(tmp_path):
    """v1.0: waited 15 s, then printed to a console that does not exist."""
    with socket.socket() as blocker:
        blocker.bind(("0.0.0.0", 0))
        blocker.listen()
        port = blocker.getsockname()[1]
        started = time.time()
        proc = _run_desktop("""
            import sys
            sys.argv = ["ParkingManager.exe", "--headless"]
            import desktop_app
            desktop_app.main()
        """, tmp_path, port, 20)
        out, err = proc.communicate(timeout=20)
    assert proc.returncode == 1
    assert time.time() - started < 10
    assert f"Port {port} is already in use" in err


def test_a_second_launch_reuses_the_running_server(tmp_path):
    port = free_port()
    code = """
        import sys
        sys.argv = ["ParkingManager.exe", "--headless"]
        import desktop_app
        desktop_app.main()
    """
    first = _run_desktop(code, tmp_path, port, 20)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1); break
            except Exception:
                time.sleep(0.2)
        second = _run_desktop(code, tmp_path, port, 20)
        time.sleep(2)
        assert second.poll() is None, "second instance keeps running (headless) instead of erroring"
        second.kill()
    finally:
        first.kill()


def test_pyinstaller_will_see_the_backend_modules():
    """PyInstaller only follows import statements. v1.0 started uvicorn from the
    string "app.main:app", so a frozen build bundled `app.config` alone and the
    .exe could not even start. desktop_app must import the app object itself."""
    source = (PROJECT_ROOT / "desktop_app.py").read_text()
    assert "from app.main import app" in source
    assert 'uvicorn.run(\n            "app.main:app"' not in source


def test_downloads_are_enabled_for_the_export_buttons():
    """pywebview cancels every download unless ALLOW_DOWNLOADS is True."""
    assert 'webview.settings["ALLOW_DOWNLOADS"] = True' in (PROJECT_ROOT / "desktop_app.py").read_text()
