"""v1.2: the access log of a residential complex.

Who came in, when, to where, with what vehicle, and which guard recorded it --
plus real entry/exit times for monthly (resident) subscribers and an
append-only audit trail of actions.
"""
import csv
import io

import pytest

from conftest import clear_pending, free_space_id, pending, register


def attendant_client(server, admin, username="vigi1", pin="4321"):
    """An ATTENDANT ("Vigilante") account, logged in."""
    status, _, _ = admin.call("POST", "/api/admin/users",
                              {"username": username, "display_name": "Vigilante Uno", "pin": pin, "role": "ATTENDANT"})
    assert status in (200, 400)           # 400 = already created by an earlier test
    c = server.client()
    assert c.login(username, pin)[0] == 200
    return c


def audit_text(rows):
    """The free-text columns of audit rows, for "this value was never written" checks.

    Do NOT search `str(rows)`: the id/ts/uid columns are digits and hex, and a short PIN such
    as "5555" or "0000" shows up in them by chance (a timestamp ending ".155558").
    """
    return " ".join(f"{r['username']} {r['role']} {r['action']} {r['subject']} {r['details']}" for r in rows)


def audit(admin, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    status, body, _ = admin.call("GET", "/api/admin/audit?limit=500" + ("&" + q if q else ""))
    assert status == 200, body
    return body["results"]


# ------------------------------------------------------------ manual check-in --
def test_attendant_can_check_in_a_vehicle_without_the_customer_scanning(server, admin):
    guard = attendant_client(server, admin)
    sid_space = free_space_id(admin)
    status, body, _ = guard.call("POST", "/api/admin/sessions/check-in", {
        "name": "Marta Gómez", "plate": "res 101", "person_type": "resident",
        "unit": "Torre 3 Apto 502", "vehicle": "Mazda 3 gris", "space_id": sid_space,
    })
    assert status == 200, body
    assert body["status"] == "OCCUPIED" and body["space_number"]
    assert body["plate"] == "RES101"
    assert body["person_type"] == "RESIDENT" and body["unit"] == "Torre 3 Apto 502"
    assert body["vehicle"] == "Mazda 3 gris"
    assert body["source"] == "MANUAL" and body["checked_in_by"] == "vigi1"


def test_manual_check_in_without_a_space_waits_in_the_pending_queue(server, admin):
    guard = attendant_client(server, admin)
    status, body, _ = guard.call("POST", "/api/admin/sessions/check-in", {
        "name": "Pedro Visita", "plate": "VIS202", "person_type": "VISITOR",
        "unit": "Torre 1 Apto 101", "visiting": "Laura Ríos",
    })
    assert status == 200 and body["status"] == "PENDING_ASSIGNMENT"
    row = next(p for p in pending(admin) if p["plate"] == "VIS202")
    assert row["visiting"] == "Laura Ríos" and row["unit"] == "Torre 1 Apto 101"
    assert guard.call("POST", f"/api/admin/sessions/{row['session_id']}/cancel")[0] == 200


def test_check_in_requires_login_and_rejects_bad_input(server, admin):
    anonymous = server.client()
    assert anonymous.call("POST", "/api/admin/sessions/check-in", {"name": "Ana Ruiz", "plate": "ABC999"})[0] == 401
    status, _, _ = admin.call("POST", "/api/admin/sessions/check-in", {"name": "Ana Ruiz", "plate": "AB$C", "person_type": "VISITOR"})
    assert status == 422
    status, _, _ = admin.call("POST", "/api/admin/sessions/check-in", {"name": "Ana Ruiz", "plate": "ABC999", "person_type": "ALIEN"})
    assert status == 422


def test_check_in_refuses_a_plate_that_is_already_inside_and_a_taken_space(server, admin):
    sp = free_space_id(admin)
    base = {"name": "Dos Veces", "plate": "DUP303", "space_id": sp}
    assert admin.call("POST", "/api/admin/sessions/check-in", base)[0] == 200
    status, body, _ = admin.call("POST", "/api/admin/sessions/check-in", base)
    assert status == 400 and "already has an active" in body["detail"]
    status, body, _ = admin.call("POST", "/api/admin/sessions/check-in", {"name": "Otro Carro", "plate": "OTH404", "space_id": sp})
    assert status == 400 and "not available" in body["detail"]
    # the refused attempt must not leave a half-created entry behind
    assert not any(p["plate"] == "OTH404" for p in pending(admin))


def test_a_guard_can_register_two_cars_that_share_a_phone_number(server, admin):
    for plate in ("TEL501", "TEL502"):
        status, body, _ = admin.call("POST", "/api/admin/sessions/check-in",
                                     {"name": "Familia Uno", "plate": plate, "phone": "3001234567"})
        assert status == 200, body


# --------------------------------------------------------------- QR extras ---
def test_qr_registration_accepts_the_visit_details_and_marks_the_source(server, admin, customer):
    status, body, _ = customer.call("POST", "/api/customer/register", {
        "name": "Camila Torres", "plate": "QRX606", "person_type": "VISITOR",
        "unit": "Torre 2 Apto 204", "visiting": "Juan Pérez", "vehicle": "Renault rojo",
    })
    assert status == 200, body
    row = next(p for p in pending(admin) if p["plate"] == "QRX606")
    assert (row["unit"], row["visiting"], row["vehicle"]) == ("Torre 2 Apto 204", "Juan Pérez", "Renault rojo")
    clear_pending(admin)
    hist = admin.call("GET", "/api/admin/history?plate=QRX606")[1]["results"][0]
    assert hist["source"] == "QR" and hist["checked_in_by"] is None


def test_free_text_fields_are_cleaned_and_capped(server, admin, customer):
    status, body, _ = customer.call("POST", "/api/customer/register", {
        "name": "Limpio Test", "plate": "CLN707", "unit": "  Torre\x00  9 \n Apto 1  ", "visiting": "x" * 500,
    })
    assert status in (200, 422), body        # over-long input is refused, not silently stored
    if status == 200:
        row = next(p for p in pending(admin) if p["plate"] == "CLN707")
        assert row["unit"] == "Torre 9 Apto 1"
        clear_pending(admin)


# ------------------------------------------------------------------ history ---
def test_history_can_be_filtered_by_person_type_and_unit_and_exported(server, admin):
    sp = free_space_id(admin)
    admin.call("POST", "/api/admin/sessions/check-in", {
        "name": "Entrega Rápida", "plate": "SRV808", "person_type": "SERVICE", "unit": "Torre 5 Apto 11", "space_id": sp})
    res = admin.call("GET", "/api/admin/history?person_type=SERVICE&unit=Torre%205")[1]["results"]
    assert res and all(r["person_type"] == "SERVICE" for r in res)
    assert any(r["plate"] == "SRV808" for r in res)
    status, payload, _ = admin.call("GET", "/api/admin/export/csv?person_type=SERVICE", raw=True)
    rows = list(csv.DictReader(io.StringIO(payload.decode("utf-8-sig"))))
    assert {"person_type", "unit", "visiting", "vehicle", "source", "checked_in_by"} <= set(rows[0])
    assert any(r["plate"] == "SRV808" and r["unit"] == "Torre 5 Apto 11" for r in rows)


def test_exit_records_who_registered_it(server, admin):
    guard = attendant_client(server, admin)
    sp = free_space_id(admin)
    sid = guard.call("POST", "/api/admin/sessions/check-in", {"name": "Sale Pronto", "plate": "EXT909", "space_id": sp})[1]["id"]
    status, body, _ = admin.call("POST", f"/api/admin/sessions/{sid}/exit")
    assert status == 200 and body["checked_in_by"] == "vigi1" and body["checked_out_by"] == "admin"


# --------------------------------------------------- monthly (resident) log ---
def make_subscription(admin, plate, name="Residente Mensual"):
    sp = free_space_id(admin)
    status, body, _ = admin.call("POST", "/api/admin/subscriptions", {
        "customer_name": name, "plate": plate, "space_id": sp, "monthly_fee": 120000})
    assert status == 200, body
    return body["id"]


def test_monthly_subscriber_entries_and_exits_are_recorded_with_time_and_guard(server, admin):
    guard = attendant_client(server, admin)
    sub = make_subscription(admin, "MEN111")
    assert guard.call("POST", f"/api/admin/subscriptions/{sub}/toggle-parked", {"parked": True})[0] == 200
    assert guard.call("POST", f"/api/admin/subscriptions/{sub}/toggle-parked", {"parked": True})[0] == 200  # double click
    assert admin.call("POST", f"/api/admin/subscriptions/{sub}/toggle-parked", {"parked": False})[0] == 200
    status, events, _ = guard.call("GET", f"/api/admin/subscriptions/{sub}/events")
    assert status == 200
    assert [e["direction"] for e in events] == ["OUT", "IN"], "newest first, and the repeated click made no extra row"
    assert events[1]["recorded_by"] == "vigi1" and events[0]["recorded_by"] == "admin"
    assert events[0]["plate"] == "MEN111" and events[0]["ts"]
    allv = admin.call("GET", "/api/admin/monthly-events?q=MEN111")[1]
    assert allv["total"] == 2
    status, payload, _ = admin.call("GET", "/api/admin/export/monthly-events?q=MEN111", raw=True)
    assert status == 200 and payload.decode("utf-8-sig").count("MEN111") == 2


def test_a_cancelled_subscription_cannot_register_an_entry(server, admin):
    sub = make_subscription(admin, "CAN222")
    assert admin.call("POST", f"/api/admin/subscriptions/{sub}/cancel")[0] == 200
    status, body, _ = admin.call("POST", f"/api/admin/subscriptions/{sub}/toggle-parked", {"parked": True})
    assert status == 400 and "cancelled" in body["detail"]


def test_events_keep_the_old_name_after_the_subscription_is_edited(server, admin):
    sub = make_subscription(admin, "OLD333", name="Nombre Antiguo")
    admin.call("POST", f"/api/admin/subscriptions/{sub}/toggle-parked", {"parked": True})
    admin.call("PUT", f"/api/admin/subscriptions/{sub}", {"customer_name": "Nombre Nuevo"})
    ev = admin.call("GET", f"/api/admin/subscriptions/{sub}/events")[1][0]
    assert ev["customer_name"] == "Nombre Antiguo"


# -------------------------------------------------------------- audit trail ---
def test_the_audit_trail_tells_who_did_what(server, admin, customer):
    guard = attendant_client(server, admin)
    plate = "AUD444"
    sp = free_space_id(admin)
    sid = guard.call("POST", "/api/admin/sessions/check-in", {"name": "Auditado", "plate": plate, "space_id": sp})[1]["id"]
    admin.call("POST", f"/api/admin/sessions/{sid}/exit")
    rows = [r for r in audit(admin, q=plate)]
    actions = {r["action"]: r for r in rows}
    assert actions["SESSION_CHECKIN"]["username"] == "vigi1"
    assert actions["SESSION_EXIT"]["username"] == "admin"
    assert "type=VISITOR" in actions["SESSION_CHECKIN"]["details"]           # visitor by default
    # a QR registration is attributed to "QR", not to a person
    register(customer, "Escaneado QR", "AUD445")
    qr = next(r for r in audit(admin, q="AUD445") if r["action"] == "SESSION_REGISTERED")
    assert qr["username"] == "QR"
    clear_pending(admin)


def test_audit_covers_administration_and_never_stores_secrets(server, admin):
    admin.call("PUT", "/api/admin/cloud-sync", {"enabled": False, "url": "https://example.invalid/hook", "secret": "S3CR3T-VALUE"})
    admin.call("POST", "/api/admin/users", {"username": "temp9", "display_name": "Temporal", "pin": "9876", "role": "ATTENDANT"})
    uid = next(u["id"] for u in admin.call("GET", "/api/admin/users")[1] if u["username"] == "temp9")
    admin.call("PUT", f"/api/admin/users/{uid}/reset-pin", {"new_pin": "5555"})
    everything = audit_text(audit(admin))
    assert "CLOUD_SYNC_UPDATED" in everything and "USER_CREATED" in everything and "USER_PIN_RESET" in everything
    for secret in ("S3CR3T-VALUE", "9876", "5555"):
        assert secret not in everything


def test_failed_and_successful_logins_are_recorded(server, admin):
    c = server.client()
    c.login("admin", "0000")
    actions = [r["action"] for r in audit(admin)]
    assert "LOGIN_FAILED" in actions and "LOGIN_OK" in actions
    assert "0000" not in audit_text(audit(admin, action="LOGIN_FAILED"))


def test_audit_is_admin_only_and_read_only(server, admin):
    guard = attendant_client(server, admin)
    assert guard.call("GET", "/api/admin/audit")[0] == 403
    assert guard.call("GET", "/api/admin/monthly-events")[0] == 403
    assert guard.call("GET", "/api/admin/export/audit", raw=True)[0] == 403
    # no endpoint exists to change or delete entries
    for method in ("PUT", "DELETE", "POST", "PATCH"):
        assert admin.call(method, "/api/admin/audit/1")[0] in (404, 405)


def test_audit_export_neutralises_formulas(server, admin):
    # The attempted username of a failed login is attacker-controlled text.
    server.client().login('=HYPERLINK("http://evil/")', "0000")
    status, payload, _ = admin.call("GET", "/api/admin/export/audit?action=LOGIN_FAILED", raw=True)
    text = payload.decode("utf-8-sig")
    assert status == 200 and "'=HYPERLINK" in text and ',=HYPERLINK' not in text
