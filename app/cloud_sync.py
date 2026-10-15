"""
Optional, best-effort cloud mirror of the parking records.

Design goals, in order:
  1. NEVER slow down or block a real registration/assignment/exit at the
     booth. Those always succeed locally and instantly regardless of whether
     the internet is up. Cloud sync happens in the background on a timer;
     nobody waits on it.
  2. Work with a genuinely free destination and nothing else. Any URL that
     accepts a POST of JSON and answers HTTP 200 works. Two targets are
     provided with the project:
       - cloud_worker/  a small Cloudflare Worker + D1 database: customer
         "check my fare" page that works from anywhere, a read-only panel for
         the owner / complex administration, and the full access log.
       - cloud_sync/AppsScript.gs  a Google Sheet (sessions only; it ignores
         the other record kinds below).
  3. Never lose data if the internet is briefly down. Everything is written to
     the LOCAL database first and is fully usable whether or not it has been
     synced yet; unsent records are simply retried on the next cycle.
  4. Be cheap. The free cloud plans have daily write limits, so a record is
     sent only when it is new or has actually CHANGED -- not every 30 s.

What is sent (protocol v2). Every request is one JSON object:

    {"secret": "...", "kind": "session" | "audit" | "monthly_event" | "ping",
     "record": {...}}

and also carries the secret as `Authorization: Bearer <secret>` (Apps Script
cannot read headers, which is why it is in the body too).
  - session        one parking session's current state, upserted by its token.
                   Re-sent only when its content hash (`cloud_hash`) changes:
                   registered -> space assigned -> exited is 3 sends, not
                   thousands.
  - audit          one append-only audit-trail row, keyed by its stable `uid`
                   so a retry after a lost acknowledgement never duplicates it.
  - monthly_event  one entry/exit of a monthly subscriber's vehicle, by `uid`.
  - ping           connectivity + secret check ("Test connection" button).

Changing the destination URL queues the whole history again (see
`reset_sync_state`), so a new cloud database is filled from the beginning.
"""
import hashlib
import json
import urllib.request
import urllib.error
from datetime import datetime

from sqlalchemy.orm import Session as DBSession

from app import crud
from app.models import AuditLog, MonthlyAccessEvent, ParkingSession, SessionStatus

REQUEST_TIMEOUT_SECONDS = 8
ACTIVE_STATUSES = (SessionStatus.PENDING_ASSIGNMENT.value, SessionStatus.OCCUPIED.value)
FINAL_STATUSES = (SessionStatus.COMPLETED.value, SessionStatus.CANCELLED.value)
PROTOCOL_VERSION = 2


# ---------------------------------------------------------------- payloads --
def _iso(moment: datetime | None) -> str | None:
    """The database keeps the PC's local wall-clock time without a zone.
    Sent to the cloud it gets the PC's UTC offset attached (2026-10-15T14:35:12-05:00),
    so every reader can tell exactly when it was, wherever they are."""
    return moment.astimezone().isoformat(timespec="seconds") if moment else None


def _session_payload(db: DBSession, session: ParkingSession) -> dict:
    return {
        "session_token": session.session_token,
        "ticket_id": f"TKT-{session.id:06d}",
        "customer_name": session.customer.name,
        "plate": session.customer.plate,
        "phone": session.customer.phone,
        "person_type": session.person_type or "VISITOR",
        "unit": session.unit,
        "visiting": session.visiting,
        "vehicle": session.vehicle_desc,
        "source": session.source or "QR",
        "checked_in_by": session.checked_in_by,
        "checked_out_by": session.checked_out_by,
        "space_number": session.space.number if session.space else None,
        "entry_timestamp": _iso(session.entry_timestamp),
        "exit_timestamp": _iso(session.exit_timestamp),
        "duration_minutes": session.duration_minutes,
        "pricing_rule_name": session.pricing_rule_name,
        # Included so a status page can compute the SAME live estimate the
        # local app shows, entirely in the customer's browser: the cloud copy
        # never has to be refreshed while the car is parked.
        "pricing_type": crud.pricing_type_for_session(db, session),
        "pricing_config_json": session.pricing_config_snapshot,
        "status": session.status,
        "final_amount": session.final_amount,
        "currency": crud.get_currency(db),
        "synced_at": _iso(datetime.now()),
    }


def payload_hash(payload: dict) -> str:
    """Content fingerprint of a session payload. `synced_at` changes on every
    call by construction, so it must not take part."""
    stable = {k: v for k, v in payload.items() if k != "synced_at"}
    blob = json.dumps(stable, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _audit_payload(row: AuditLog) -> dict:
    return {"uid": row.uid, "ts": _iso(row.ts), "username": row.username, "role": row.role,
            "action": row.action, "subject": row.subject, "details": row.details}


def _event_payload(row: MonthlyAccessEvent) -> dict:
    return {"uid": row.uid, "ts": _iso(row.ts), "direction": row.direction,
            "subscription_id": row.subscription_id, "customer_name": row.customer_name,
            "plate": row.plate, "space_number": row.space_number, "recorded_by": row.recorded_by}


# --------------------------------------------------------------- transport --
def _is_connectivity_failure(message: str) -> bool:
    """True for failures that say "the endpoint can't be reached right now"
    (no internet, DNS, timeout) as opposed to an answer from the endpoint
    (wrong secret, HTTP error). Used to stop a sync cycle early instead of
    waiting REQUEST_TIMEOUT_SECONDS once per record."""
    return message.startswith(("Connection failed", "Unexpected error"))


def _stops_cycle(message: str) -> bool:
    """Failures that would repeat for every remaining record (no internet,
    wrong secret, the service itself failing): give up until the next cycle
    instead of hammering the endpoint. A rejection of one particular record
    (HTTP 400/422...) does not stop the others."""
    return (_is_connectivity_failure(message)
            or message.startswith(("HTTP 401", "HTTP 403", "HTTP 429", "HTTP 5"))
            or "secret" in message.lower())


def push_one(url: str, secret: str, payload: dict, kind: str = "session") -> tuple[bool, str]:
    """POSTs one record to the configured endpoint. Returns (success, message).
    Never raises -- all failure modes (no internet, bad URL, endpoint down,
    non-200 response) are caught and reported back as a plain message so
    callers can log/display it without a try/except of their own.

    NOTE on the response contract: this checks BOTH the HTTP status code AND,
    if the body is JSON, an "ok" field -- because Google Apps Script Web Apps
    always return HTTP 200 even for an application-level error such as a
    wrong secret. Any OTHER endpoint is still handled correctly: a non-2xx
    status fails, and a 2xx with a non-JSON or "ok"-less body is success."""
    body = json.dumps({"secret": secret, "kind": kind, "record": payload}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}",
                 "User-Agent": f"ParkingManager-cloud-sync/{PROTOCOL_VERSION}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            status = resp.getcode()
            resp_text = resp.read().decode("utf-8", errors="replace")
            if not (200 <= status < 300):
                return False, f"HTTP {status}: {resp_text[:200]}"
            try:
                parsed = json.loads(resp_text)
            except (json.JSONDecodeError, ValueError):
                return True, "ok"  # 2xx, non-JSON body -- treat as success
            if isinstance(parsed, dict) and "ok" in parsed:
                if parsed["ok"]:
                    return True, "ok"
                return False, str(parsed.get("error", "Endpoint reported failure"))[:200]
            return True, "ok"  # 2xx JSON body with no explicit "ok" field
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')[:200]}"
    except urllib.error.URLError as e:
        return False, f"Connection failed: {e.reason}"
    except Exception as e:  # noqa: BLE001 -- deliberately broad: this must never crash the app
        return False, f"Unexpected error: {e}"


# ------------------------------------------------------------------ config --
def get_config(db: DBSession) -> dict:
    return {
        "enabled": crud.get_setting(db, "cloud_sync_enabled", "false") == "true",
        "url": crud.get_setting(db, "cloud_sync_url", "") or "",
        "secret": crud.get_setting(db, "cloud_sync_secret", "") or "",
        "last_success": crud.get_setting(db, "cloud_sync_last_success", None),
        "last_error": crud.get_setting(db, "cloud_sync_last_error", None),
    }


def reset_sync_state(db: DBSession) -> None:
    """Marks every record as "not yet sent". Used when the destination
    changes, so a brand-new cloud database receives the full history."""
    db.query(ParkingSession).update({ParkingSession.synced_to_cloud: False, ParkingSession.cloud_hash: None})
    db.query(AuditLog).update({AuditLog.synced_to_cloud: False})
    db.query(MonthlyAccessEvent).update({MonthlyAccessEvent.synced_to_cloud: False})
    db.commit()


def set_config(db: DBSession, enabled: bool | None = None, url: str | None = None, secret: str | None = None):
    if enabled is not None:
        crud.set_setting(db, "cloud_sync_enabled", "true" if enabled else "false")
    if url is not None:
        new_url = url.strip()
        old_url = crud.get_setting(db, "cloud_sync_url", "") or ""
        crud.set_setting(db, "cloud_sync_url", new_url)
        if new_url and new_url != old_url:
            reset_sync_state(db)
    if secret is not None:
        crud.set_setting(db, "cloud_sync_secret", secret.strip())


def check_connection(db: DBSession) -> tuple[bool, str]:
    """Checks the URL and the secret with a record-less 'ping'."""
    config = get_config(db)
    if not config["url"]:
        return False, "No cloud URL has been configured."
    return push_one(config["url"], config["secret"], {"protocol": PROTOCOL_VERSION}, kind="ping")


# ----------------------------------------------------------------- backlog --
def _unsynced_final_sessions(db: DBSession):
    return (db.query(ParkingSession)
            .filter(ParkingSession.status.in_(FINAL_STATUSES), ParkingSession.synced_to_cloud.is_(False)))


def _active_sessions_to_send(db: DBSession) -> list[tuple[ParkingSession, dict, str]]:
    """Active sessions whose content differs from what the cloud already has."""
    out = []
    for s in db.query(ParkingSession).filter(ParkingSession.status.in_(ACTIVE_STATUSES)).all():
        payload = _session_payload(db, s)
        digest = payload_hash(payload)
        if s.cloud_hash != digest:
            out.append((s, payload, digest))
    return out


def pending_count(db: DBSession) -> int:
    """How many records still have to reach the cloud: finished sessions,
    active sessions that changed, audit rows and monthly movements."""
    return (
        _unsynced_final_sessions(db).count()
        + len(_active_sessions_to_send(db))
        + db.query(AuditLog).filter(AuditLog.synced_to_cloud.is_(False)).count()
        + db.query(MonthlyAccessEvent).filter(MonthlyAccessEvent.synced_to_cloud.is_(False)).count()
    )


def sync_pending_sessions(db: DBSession, limit: int = 50) -> dict:
    """Runs one sync cycle and returns {attempted, succeeded, message}.

    Order: active sessions that changed (the customer-facing "my fare" page
    depends on them), then finished sessions, then the audit trail, then
    monthly movements -- each category limited to `limit` records per cycle
    so a large first upload spreads over several cycles. The cycle stops at
    the first failure that would repeat for every other record (no internet,
    wrong secret, service down); the next cycle resumes where this one left
    off. A rejection of a single record is recorded and skipped."""
    config = get_config(db)
    if not config["enabled"] or not config["url"]:
        return {"attempted": 0, "succeeded": 0, "message": "Cloud backup is not enabled."}

    state = {"attempted": 0, "succeeded": 0, "message": "Nothing to sync.", "stop": False}

    def send(kind: str, payload: dict) -> bool:
        state["attempted"] += 1
        ok, message = push_one(config["url"], config["secret"], payload, kind)
        state["message"] = message
        if ok:
            state["succeeded"] += 1
            return True
        crud.set_setting(db, "cloud_sync_last_error", f"{datetime.now().isoformat()}: {message}")
        if _stops_cycle(message):
            # Every remaining push would just wait out its own timeout (8 s
            # each) or be refused the same way. Give up on this cycle.
            state["stop"] = True
        return False

    # 1. Active sessions that are new or changed.
    for session, payload, digest in _active_sessions_to_send(db)[:limit]:
        if send("session", payload):
            session.cloud_hash = digest
            db.commit()
        if state["stop"]:
            break

    # 2. Finished sessions (sent once, then flagged).
    if not state["stop"]:
        for session in _unsynced_final_sessions(db).order_by(ParkingSession.exit_timestamp.asc()).limit(limit).all():
            payload = _session_payload(db, session)
            if send("session", payload):
                session.synced_to_cloud = True
                session.cloud_hash = payload_hash(payload)
                db.commit()
            if state["stop"]:
                break

    # 3. Audit trail, oldest first.
    if not state["stop"]:
        rows = (db.query(AuditLog).filter(AuditLog.synced_to_cloud.is_(False))
                .order_by(AuditLog.id.asc()).limit(limit).all())
        for row in rows:
            if send("audit", _audit_payload(row)):
                row.synced_to_cloud = True
                db.commit()
            if state["stop"]:
                break

    # 4. Monthly subscribers' entries and exits, oldest first.
    if not state["stop"]:
        rows = (db.query(MonthlyAccessEvent).filter(MonthlyAccessEvent.synced_to_cloud.is_(False))
                .order_by(MonthlyAccessEvent.id.asc()).limit(limit).all())
        for row in rows:
            if send("monthly_event", _event_payload(row)):
                row.synced_to_cloud = True
                db.commit()
            if state["stop"]:
                break

    if state["succeeded"]:
        crud.set_setting(db, "cloud_sync_last_success", datetime.now().isoformat())
    return {"attempted": state["attempted"], "succeeded": state["succeeded"], "message": state["message"]}
