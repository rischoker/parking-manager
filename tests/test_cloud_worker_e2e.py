"""End to end: the REAL ParkingManager server pushes to the REAL cloud service
(the Cloudflare Worker running locally under wrangler with a throw-away D1
database), then the panel API is read back with a real owner key.

Needs Node.js and `npm ci` inside cloud_worker/. Skipped when they are missing,
unless REQUIRE_UI_TESTS=1 (set in CI).
"""
import json
import os
import re
import shutil
import signal
import subprocess
import urllib.error
import urllib.request

import pytest

from conftest import PROJECT_ROOT, Server, free_port

WORKER_DIR = PROJECT_ROOT / "cloud_worker"
WRANGLER = WORKER_DIR / "node_modules" / ".bin" / "wrangler"
INGEST, SETUP = "e2e-ingest-secret-123", "e2e-setup-token-456"

if not (shutil.which("node") and WRANGLER.exists()):
    if os.environ.get("REQUIRE_UI_TESTS") == "1":
        raise RuntimeError("REQUIRE_UI_TESTS=1 but Node.js / cloud_worker dependencies are missing")
    pytestmark = pytest.mark.skip(reason="needs Node.js and `npm ci` in cloud_worker/")


@pytest.fixture(scope="module")
def worker():
    port = free_port()
    proc = subprocess.Popen(
        ["node", str(WORKER_DIR / "tests" / "local.mjs"), "--serve", "--port", str(port),
         "--ingest", INGEST, "--setup", SETUP],
        cwd=WORKER_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    ready = proc.stdout.readline()
    if not ready.startswith("READY"):
        proc.kill()
        raise RuntimeError("local Worker did not start: " + ready + proc.stdout.read())
    yield f"http://127.0.0.1:{port}"
    os.killpg(proc.pid, signal.SIGTERM)
    proc.wait(30)


@pytest.fixture(scope="module")
def pc(tmp_path_factory):
    srv = Server(tmp_path_factory.mktemp("pm-e2e"), free_port()).start()
    yield srv
    srv.stop()


def web(base, method, path, body=None, cookie=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null"), e.headers


def test_everything_the_gate_does_reaches_the_cloud_panel(worker, pc):
    admin = pc.client()
    assert admin.login()[0] == 200

    # -- connect the PC to the cloud service -------------------------------
    assert admin.call("PUT", "/api/admin/cloud-sync", {"enabled": True, "url": worker + "/api/ingest", "secret": "wrong"})[0] == 200
    bad = admin.call("POST", "/api/admin/cloud-sync/test")[1]
    assert bad["ok"] is False and "secret" in bad["message"].lower()
    assert admin.call("PUT", "/api/admin/cloud-sync", {"secret": INGEST})[0] == 200
    assert admin.call("POST", "/api/admin/cloud-sync/test")[1]["ok"] is True

    # -- a day at the gate -------------------------------------------------------
    assert admin.call("POST", "/api/admin/users", {"username": "vigi-e2e", "display_name": "Vigilante E2E",
                                                  "pin": "7777", "role": "ATTENDANT"})[0] == 200
    guard = pc.client()
    assert guard.login("vigi-e2e", "7777")[0] == 200
    dash = admin.call("GET", "/api/admin/dashboard")[1]
    free = [s["id"] for s in dash["spaces"] if s["status"] == "AVAILABLE" and not s["monthly"]]

    st, body, _ = guard.call("POST", "/api/admin/sessions/check-in", {
        "name": "Marta Gómez", "plate": "e2e123", "person_type": "RESIDENT", "unit": "Torre 3 - 402",
        "vehicle": "Mazda 3 rojo", "space_id": free[0]})
    assert st == 200, body
    checked_in_id = body["id"]

    st, body, _ = pc.client().call("POST", "/api/customer/register", {
        "name": "Visita Ruiz", "plate": "VIS456", "person_type": "VISITOR", "unit": "Torre 2 - 305", "visiting": "Familia Ruiz"},
        headers={"CF-Connecting-IP": "203.0.113.77"})
    assert st == 200, body
    qr_token = body["session_token"]

    st, sub, _ = admin.call("POST", "/api/admin/subscriptions", {
        "customer_name": "Mensual Uno", "plate": "MEN001", "space_id": free[1], "monthly_fee": 90000})
    assert st == 200, sub
    assert guard.call("POST", f"/api/admin/subscriptions/{sub['id']}/toggle-parked", {"parked": True})[0] == 200

    # -- push, and check it is incremental ---------------------------------------
    r = admin.call("POST", "/api/admin/cloud-sync/sync-now")[1]
    assert r["attempted"] > 0 and r["succeeded"] == r["attempted"], r
    assert admin.call("GET", "/api/admin/cloud-sync/status")[1]["pending_count"] == 0
    again = admin.call("POST", "/api/admin/cloud-sync/sync-now")[1]
    assert again["attempted"] == 0, "nothing changed, so nothing is sent"

    # -- the owner opens the panel ---------------------------------------------------------
    st, setup, _ = web(worker, "POST", "/api/setup", {"setup_token": SETUP, "name": "Dueño"})
    assert st == 200, setup
    st, _, hdr = web(worker, "POST", "/api/monitor/login", {"key": setup["key"]})
    assert st == 200
    cookie = hdr["Set-Cookie"].split(";")[0]
    get = lambda p: web(worker, "GET", p, cookie=cookie)[1]  # noqa: E731

    now = get("/api/monitor/now?today=" + re.sub(r"T.*", "", get("/api/monitor/sessions")["results"][0]["entry_ts"]))
    by_plate = {s["plate"]: s for s in now["sessions"]}
    assert set(by_plate) == {"E2E123", "VIS456"}
    resident = by_plate["E2E123"]
    assert (resident["person_type"], resident["unit"], resident["vehicle"], resident["source"], resident["checked_in_by"]) == \
           ("RESIDENT", "Torre 3 - 402", "Mazda 3 rojo", "MANUAL", "vigi-e2e")
    assert re.search(r"[+-]\d\d:\d\d$", resident["entry_ts"]), "timestamps travel with the PC's UTC offset"
    assert by_plate["VIS456"]["status"] == "PENDING_ASSIGNMENT" and by_plate["VIS456"]["visiting"] == "Familia Ruiz"
    assert [m["plate"] for m in now["monthly_inside"]] == ["MEN001"]

    audit = get("/api/monitor/audit?limit=200")["results"]
    checkin = [a for a in audit if a["action"] == "SESSION_CHECKIN"]
    assert checkin and checkin[0]["username"] == "vigi-e2e" and "E2E123" in (checkin[0]["subject"] or "")
    assert any(a["action"] == "SESSION_REGISTERED" and a["username"] == "QR" for a in audit)
    assert any(a["action"] == "CLOUD_SYNC_UPDATED" for a in audit)
    assert INGEST not in json.dumps(audit), "the shared secret never reaches the cloud audit trail"

    events = get("/api/monitor/monthly-events")["results"]
    assert [(e["direction"], e["plate"], e["recorded_by"]) for e in events] == [("IN", "MEN001", "vigi-e2e")]

    # -- the customer's page, from anywhere --------------------------------------------------
    st, pub, _ = web(worker, "GET", f"/api/session?token={qr_token}")
    assert st == 200 and pub["record"]["status"] == "PENDING_ASSIGNMENT" and pub["record"]["plate"] == "VIS456"
    assert "Visita Ruiz" not in json.dumps(pub) and "Familia Ruiz" not in json.dumps(pub) and "Torre" not in json.dumps(pub)
    assert json.loads(pub["record"]["pricing_config_json"]), "the page can compute the live fare itself"

    # -- exit and payment, then the history is complete ---------------------------------------
    st, ex, _ = guard.call("POST", f"/api/admin/sessions/{checked_in_id}/exit")
    assert st == 200, ex
    assert admin.call("POST", "/api/admin/cloud-sync/sync-now")[1]["succeeded"] >= 2   # the session + the audit row
    done = [s for s in get("/api/monitor/sessions?status=COMPLETED")["results"] if s["plate"] == "E2E123"]
    assert len(done) == 1 and done[0]["checked_out_by"] == "vigi-e2e" and done[0]["final_amount"] is not None
    assert get("/api/monitor/now")["counts"]["inside"] == 0

    # -- moving to a new cloud address re-sends everything, without duplicates ---------------------
    before = {k: get(f"/api/monitor/{k}")["total"] for k in ("sessions", "audit", "monthly-events")}
    assert admin.call("PUT", "/api/admin/cloud-sync", {"url": worker + "/api/ingest?moved=1"})[0] == 200
    assert admin.call("GET", "/api/admin/cloud-sync/status")[1]["pending_count"] > 0
    for _ in range(5):
        if admin.call("POST", "/api/admin/cloud-sync/sync-now")[1]["attempted"] == 0:
            break
    assert admin.call("GET", "/api/admin/cloud-sync/status")[1]["pending_count"] == 0
    after = {k: get(f"/api/monitor/{k}")["total"] for k in ("sessions", "audit", "monthly-events")}
    # Everything was sent again, yet nothing is duplicated: the only new row is the
    # audit entry for changing the address itself.
    assert after["sessions"] == before["sessions"]
    assert after["monthly-events"] == before["monthly-events"]
    assert after["audit"] == before["audit"] + 1
