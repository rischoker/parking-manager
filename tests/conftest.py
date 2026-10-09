"""Shared fixtures: a REAL ParkingManager server (uvicorn on a free port with
its own throw-away data folder) plus a tiny HTTP client.

Why a real server instead of FastAPI's TestClient: several protections only
exist at the network layer (the "admin only from this machine" check looks at
the connecting address and the Host header), so they have to be exercised over
a genuine socket.

Run with:  pip install -r requirements-dev.txt  &&  python -m pytest -q
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# In-process unit tests (crud / cloud_sync / pricing) import `app`, which reads
# its data folder from this variable at import time -- point it at a temp dir
# BEFORE anything imports `app`.
_UNIT_DATA_DIR = tempfile.mkdtemp(prefix="pm-unit-")
os.environ["PARKINGMANAGER_DATA_DIR"] = _UNIT_DATA_DIR
sys.path.insert(0, str(PROJECT_ROOT))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Client:
    """Minimal JSON-over-HTTP client (no third-party dependency)."""

    def __init__(self, base: str, token: str | None = None):
        self.base, self.token = base, token

    def call(self, method, path, body=None, headers=None, raw=False):
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        h.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status, payload, hdrs = r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            status, payload, hdrs = e.code, e.read(), dict(e.headers)
        if raw:
            return status, payload, hdrs
        try:
            return status, json.loads(payload), hdrs
        except ValueError:
            return status, payload, hdrs

    def login(self, username="admin", pin="1234"):
        status, body, _ = self.call("POST", "/api/admin/login", {"username": username, "pin": pin})
        if status == 200:
            self.token = body["token"]
        return status, body


class Server:
    def __init__(self, data_dir: Path, port: int, extra_env: dict | None = None):
        self.data_dir, self.port = data_dir, port
        self.base = f"http://127.0.0.1:{port}"
        self.extra_env = extra_env or {}
        self.proc = None

    def start(self):
        env = dict(os.environ, PARKINGMANAGER_DATA_DIR=str(self.data_dir), **self.extra_env)
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
             "--port", str(self.port), "--log-level", "warning"],
            cwd=PROJECT_ROOT, env=env,
            stdout=open(self.data_dir / "server.log", "ab"), stderr=subprocess.STDOUT,
        )
        for _ in range(100):
            try:
                urllib.request.urlopen(self.base + "/health", timeout=1)
                return self
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("server did not start:\n" + (self.data_dir / "server.log").read_text())

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def client(self, **kw):
        return Client(self.base, **kw)


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    srv = Server(tmp_path_factory.mktemp("pm-server"), free_port()).start()
    yield srv
    srv.stop()


@pytest.fixture()
def admin(server):
    c = server.client()
    status, _ = c.login()
    assert status == 200
    return c


_ip_counter = iter(range(1, 10_000))


@pytest.fixture()
def customer(server):
    """A customer 'device' with its own (fake) address, so the per-device
    registration limit in one test never affects another."""
    n = next(_ip_counter)
    c = server.client()
    c.call_orig = c.call

    def call(method, path, body=None, headers=None, raw=False):
        h = {"CF-Connecting-IP": f"203.0.113.{n % 250}-{n}"}
        h.update(headers or {})
        return c.call_orig(method, path, body, h, raw)
    c.call = call
    return c


# -- helpers shared by several test modules -----------------------------------
def register(customer, name, plate, phone=None):
    return customer.call("POST", "/api/customer/register", {"name": name, "plate": plate, "phone": phone})


def pending(admin):
    return admin.call("GET", "/api/admin/dashboard")[1]["pending"]


def free_space_id(admin):
    d = admin.call("GET", "/api/admin/dashboard")[1]
    return next(s["id"] for s in d["spaces"] if s["status"] == "AVAILABLE" and not s["monthly"])


def check_in(admin, customer, name, plate):
    """Register through the public endpoint, then assign a free space."""
    status, body, _ = register(customer, name, plate)
    assert status == 200, body
    token = body["session_token"]
    sid = next(p["session_id"] for p in pending(admin) if p["plate"] == plate)
    status, body, _ = admin.call("POST", f"/api/admin/sessions/{sid}/assign-space", {"space_id": free_space_id(admin)})
    assert status == 200, body
    return sid, token


def clear_pending(admin):
    for p in pending(admin):
        admin.call("POST", f"/api/admin/sessions/{p['session_id']}/cancel")
