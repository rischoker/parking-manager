"""Cloud sync v2: what is sent, how often, and what happens when the
destination fails. A tiny in-process HTTP server plays the cloud."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import free_port


class FakeCloud:
    """Records every request; `mode` decides how it answers."""

    def __init__(self, secret="s3cret"):
        self.secret, self.requests, self.mode = secret, [], "ok"
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append({"headers": dict(self.headers), "body": body})
                if outer.mode == "down":
                    code, payload = 503, {"ok": False, "error": "unavailable"}
                elif body.get("secret") != outer.secret:
                    code, payload = 401, {"ok": False, "error": "Invalid or missing secret"}
                elif outer.mode == "reject-audit" and body.get("kind") == "audit":
                    code, payload = 422, {"ok": False, "error": "bad record"}
                else:
                    code, payload = 200, {"ok": True}
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.port = free_port()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.port}/api/ingest"

    def stop(self):
        self.httpd.shutdown()

    def of(self, kind, **match):
        out = []
        for r in self.requests:
            b = r["body"]
            if b.get("kind") == kind and all(b["record"].get(k) == v for k, v in match.items()):
                out.append(b["record"])
        return out


@pytest.fixture()
def env():
    from app import cloud_sync, crud
    from app.database import SessionLocal, init_db
    from app.seed_data import seed_core
    init_db()
    db = SessionLocal()
    seed_core(db)
    cloud = FakeCloud()
    cloud_sync.set_config(db, enabled=True, url=cloud.url, secret=cloud.secret)
    yield db, cloud, cloud_sync, crud
    cloud.stop()
    cloud_sync.set_config(db, enabled=False)
    db.close()


def _drain(cloud_sync, db):
    """Run cycles until nothing is left (other tests share this database)."""
    for _ in range(40):
        r = cloud_sync.sync_pending_sessions(db, limit=500)
        if r["attempted"] == 0:
            return
    raise AssertionError("sync never settled")


def _free_space(crud, db):
    return next(s for s in crud.list_spaces(db) if s.status == "AVAILABLE" and s.id not in crud.reserved_space_ids(db))


def test_a_session_is_sent_only_when_it_changes(env):
    db, cloud, cloud_sync, crud = env
    actor = {"username": "vigi-sync", "role": "ATTENDANT", "user_id": None}
    s = crud.create_session(db, "Ana Sync", "SYN2AA", None, person_type="RESIDENT", unit="Torre 2 - 301",
                            vehicle_desc="Renault rojo", source="MANUAL", actor=actor)
    _drain(cloud_sync, db)
    first = cloud.of("session", plate="SYN2AA")
    assert len(first) == 1
    rec = first[0]
    assert (rec["person_type"], rec["unit"], rec["vehicle"], rec["source"], rec["checked_in_by"]) == \
           ("RESIDENT", "Torre 2 - 301", "Renault rojo", "MANUAL", "vigi-sync")

    # nothing changed -> nothing is sent, however many cycles run
    for _ in range(3):
        cloud_sync.sync_pending_sessions(db)
    assert len(cloud.of("session", plate="SYN2AA")) == 1

    space = _free_space(crud, db)
    crud.assign_space(db, s.id, space.id, actor)
    _drain(cloud_sync, db)
    sent = cloud.of("session", plate="SYN2AA")
    assert len(sent) == 2 and sent[-1]["space_number"] == space.number

    crud.register_exit(db, s.id, actor)
    _drain(cloud_sync, db)
    sent = cloud.of("session", plate="SYN2AA")
    assert len(sent) == 3 and sent[-1]["status"] == "COMPLETED" and sent[-1]["checked_out_by"] == "vigi-sync"
    db.refresh(s)
    assert s.synced_to_cloud is True

    for _ in range(3):
        cloud_sync.sync_pending_sessions(db)
    assert len(cloud.of("session", plate="SYN2AA")) == 3


def test_payload_hash_ignores_the_send_time():
    from app import cloud_sync
    a = {"x": 1, "synced_at": "2026-01-01T00:00:00"}
    b = {"x": 1, "synced_at": "2030-12-31T23:59:59"}
    assert cloud_sync.payload_hash(a) == cloud_sync.payload_hash(b)
    assert cloud_sync.payload_hash(a) != cloud_sync.payload_hash({"x": 2})


def test_audit_rows_and_monthly_movements_are_sent_once_by_uid(env):
    db, cloud, cloud_sync, crud = env
    actor = {"username": "vigi-sync", "role": "ATTENDANT", "user_id": None}
    space = _free_space(crud, db)
    sub = crud.create_subscription(db, "Mensual Sync", "MSY111", space.id, 90000)
    crud.toggle_currently_parked(db, sub.id, True, actor)
    crud.toggle_currently_parked(db, sub.id, False, actor)
    _drain(cloud_sync, db)

    events = cloud.of("monthly_event", plate="MSY111")
    assert [e["direction"] for e in events] == ["IN", "OUT"]
    assert all(e["recorded_by"] == "vigi-sync" and e["uid"] for e in events)
    audits = [a for a in cloud.of("audit") if a["username"] == "vigi-sync"]
    assert audits, "audit rows of that attendant were sent"
    assert len({a["uid"] for a in cloud.of("audit")}) == len(cloud.of("audit")), "each audit row sent once"

    before = len(cloud.requests)
    cloud_sync.sync_pending_sessions(db)
    assert len(cloud.requests) == before, "nothing is re-sent"


def test_secret_travels_in_header_and_body_but_never_into_the_audit_trail(env):
    db, cloud, cloud_sync, crud = env
    crud.create_session(db, "Header Check", "HDR001", None)
    _drain(cloud_sync, db)
    req = next(r for r in cloud.requests if r["body"].get("kind") == "session" and r["body"]["record"]["plate"] == "HDR001")
    assert req["headers"]["Authorization"] == "Bearer s3cret"
    assert req["body"]["secret"] == "s3cret"
    for a in cloud.of("audit"):
        assert "s3cret" not in json.dumps(a)


def test_wrong_secret_stops_the_cycle_after_one_request(env):
    db, cloud, cloud_sync, crud = env
    for i in range(3):
        crud.create_session(db, f"Wrong {i}", f"WRG00{i}", None)
    cloud_sync.set_config(db, secret="not-the-secret")
    cloud.requests.clear()
    r = cloud_sync.sync_pending_sessions(db, limit=500)
    assert r["attempted"] == 1 and r["succeeded"] == 0
    assert "secret" in r["message"].lower() or "401" in r["message"]
    assert len(cloud.requests) == 1


def test_service_down_stops_the_cycle_and_everything_is_retried_later(env):
    db, cloud, cloud_sync, crud = env
    crud.create_session(db, "Down Check", "DWN001", None)
    cloud.mode = "down"
    cloud.requests.clear()
    r = cloud_sync.sync_pending_sessions(db, limit=500)
    assert r["succeeded"] == 0 and len(cloud.requests) == 1
    assert cloud_sync.pending_count(db) > 0
    cloud.mode = "ok"
    _drain(cloud_sync, db)
    assert len(cloud.of("session", plate="DWN001")) == 1


def test_one_rejected_record_does_not_block_the_others(env):
    db, cloud, cloud_sync, crud = env
    crud.create_session(db, "Reject Check", "REJ001", None)
    cloud.mode = "reject-audit"
    r = cloud_sync.sync_pending_sessions(db, limit=500)
    assert len(cloud.of("session", plate="REJ001")) == 1, "the session still went through"
    assert cloud_sync.get_config(db)["last_error"]
    cloud.mode = "ok"
    _drain(cloud_sync, db)
    assert cloud_sync.pending_count(db) == 0


def test_changing_the_destination_queues_the_whole_history_again(env):
    db, cloud, cloud_sync, crud = env
    crud.create_session(db, "History Check", "HST001", None)
    _drain(cloud_sync, db)
    assert cloud_sync.pending_count(db) == 0
    second = FakeCloud(secret="other")
    try:
        cloud_sync.set_config(db, url=second.url, secret="other")
        assert cloud_sync.pending_count(db) > 0
        _drain(cloud_sync, db)
        assert len(second.of("session", plate="HST001")) == 1
        assert second.of("audit"), "audit history was re-sent to the new destination"
        # saving the SAME url again must not re-queue anything
        cloud_sync.set_config(db, url=second.url)
        assert cloud_sync.pending_count(db) == 0
    finally:
        second.stop()


def test_connection_test_reports_ok_and_bad_secret(env):
    db, cloud, cloud_sync, crud = env
    ok, msg = cloud_sync.check_connection(db)
    assert ok, msg
    assert cloud.requests[-1]["body"]["kind"] == "ping"
    cloud_sync.set_config(db, secret="nope")
    ok, msg = cloud_sync.check_connection(db)
    assert not ok and ("secret" in msg.lower() or "401" in msg)


def test_the_api_tests_a_connection_and_only_for_full_admins(server, admin):
    cloud = FakeCloud(secret="api-secret")
    try:
        assert admin.call("PUT", "/api/admin/cloud-sync",
                          {"enabled": False, "url": cloud.url, "secret": "api-secret"})[0] == 200
        status, body, _ = admin.call("POST", "/api/admin/cloud-sync/test")
        assert status == 200 and body["ok"] is True, body
        assert cloud.requests and cloud.requests[-1]["body"]["kind"] == "ping"

        admin.call("PUT", "/api/admin/cloud-sync", {"secret": "wrong"})
        status, body, _ = admin.call("POST", "/api/admin/cloud-sync/test")
        assert status == 200 and body["ok"] is False and "secret" in body["message"].lower()

        # an attendant may not use it
        admin.call("POST", "/api/admin/users", {"username": "vigi-cs", "display_name": "V", "pin": "5555", "role": "ATTENDANT"})
        vigi = server.client()
        assert vigi.login("vigi-cs", "5555")[0] == 200
        assert vigi.call("POST", "/api/admin/cloud-sync/test")[0] == 403
    finally:
        admin.call("PUT", "/api/admin/cloud-sync", {"enabled": False, "url": "", "secret": ""})
        cloud.stop()
