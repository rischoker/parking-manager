"""Drives the real admin console and the customer's QR page in jsdom (a
browser simulator) against a REAL server: catches broken wiring that unit and
API tests cannot (a missing element id, a typo in a handler, an untranslated
label, an uncaught exception on a screen).

Needs Node.js and the `jsdom` package:  npm install --no-save jsdom
Skipped when they are missing, unless REQUIRE_UI_TESTS=1 (set in CI).
"""
import os
import shutil
import subprocess

import pytest

from conftest import PROJECT_ROOT, Server, free_port

NODE = shutil.which("node")


def _has_jsdom() -> bool:
    if not NODE:
        return False
    r = subprocess.run([NODE, "-e", "require('jsdom')"], cwd=PROJECT_ROOT,
                       capture_output=True, env=dict(os.environ))
    return r.returncode == 0


if not _has_jsdom():
    if os.environ.get("REQUIRE_UI_TESTS") == "1":
        raise RuntimeError("REQUIRE_UI_TESTS=1 but Node.js / jsdom are not available")
    pytestmark = pytest.mark.skip(reason="Node.js or jsdom not installed (npm install --no-save jsdom)")


@pytest.fixture(scope="module")
def ui_server(tmp_path_factory):
    # Own server and data folder: these tests register vehicles and users that
    # other tests should never see.
    srv = Server(tmp_path_factory.mktemp("pm-ui"), free_port()).start()
    yield srv
    srv.stop()


@pytest.mark.parametrize("script", ["admin_ui.test.js", "mobile_ui.test.js"])
def test_ui_flow(ui_server, script):
    r = subprocess.run([NODE, str(PROJECT_ROOT / "tests" / "ui" / script), ui_server.base],
                       cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"{script} failed:\n{r.stdout}\n{r.stderr}"
    assert "ALL OK" in r.stdout
