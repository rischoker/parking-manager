"""
Optional, best-effort cloud backup AND live-status mirror for parking
sessions.

Design goals, in order:
  1. NEVER slow down or block a real registration/assignment/exit at the
     booth. Those always succeed locally and instantly regardless of
     whether the internet is up. Cloud sync happens in the background on
     a timer, not something anyone waits on.
  2. Work with a genuinely free destination and nothing else. The default
     integration target is a Google Sheet, reached through a small Google
     Apps Script "Web App" endpoint (see CLOUD_BACKUP.md for the ~5 minute
     setup and cloud_sync/AppsScript.gs for the exact script to paste in).
     This is not Google-specific by contract: ANY URL that accepts a POST
     of JSON and returns HTTP 200 works.
  3. Never lose data if the internet is briefly down. Everything is
     written to the LOCAL database first and is fully usable (Dashboard,
     History, Revenue, exports) whether or not it has been synced yet.
  4. Keep the Sheet's copy of a session CURRENT, not just a one-time
     snapshot at the end. Every push is an upsert keyed by the session's
     token (see cloud_sync/AppsScript.gs: findRowByToken) -- the same row
     gets updated as a session moves PENDING_ASSIGNMENT -> OCCUPIED ->
     COMPLETED, rather than a new row being appended each time. This is
     what makes the optional GitHub Pages "check my status from anywhere"
     page (see github_pages/ and GITHUB_PAGES_STATUS.md) possible: it
     reads a session's CURRENT state directly from the Sheet via the Apps
     Script's doGet, with no connection back to this app at all.

Two independent categories of session get synced each cycle:
  - ACTIVE (PENDING_ASSIGNMENT, OCCUPIED): re-pushed on every cycle. This
    is cheap -- bounded by however many vehicles are currently on site,
    at most a couple dozen -- and keeps the Sheet's view of "what's
    happening right now" fresh for the GitHub Pages status page.
  - FINAL (COMPLETED, CANCELLED): pushed once, then marked
    `synced_to_cloud` so they're never re-sent. This is the durable
    backup-record behavior from the original design.
"""
import json
import urllib.request
import urllib.error
from datetime import datetime

from sqlalchemy.orm import Session as DBSession

from app import crud
from app.models import ParkingSession, SessionStatus

REQUEST_TIMEOUT_SECONDS = 8
ACTIVE_STATUSES = (SessionStatus.PENDING_ASSIGNMENT.value, SessionStatus.OCCUPIED.value)
FINAL_STATUSES = (SessionStatus.COMPLETED.value, SessionStatus.CANCELLED.value)


def _session_payload(db: DBSession, session: ParkingSession) -> dict:
    return {
        "session_token": session.session_token,
        "ticket_id": f"TKT-{session.id:06d}",
        "customer_name": session.customer.name,
        "plate": session.customer.plate,
        "phone": session.customer.phone,
        "space_number": session.space.number if session.space else None,
        "entry_timestamp": session.entry_timestamp.isoformat() if session.entry_timestamp else None,
        "exit_timestamp": session.exit_timestamp.isoformat() if session.exit_timestamp else None,
        "duration_minutes": session.duration_minutes,
        "pricing_rule_name": session.pricing_rule_name,
        # Included so the GitHub Pages status page can compute the SAME
        # live estimate the local app shows, entirely client-side --
        # exactly like mobile_ui/js/mobile.js already does, just reading
        # these two fields from the Sheet instead of the local API.
        "pricing_type": crud.pricing_type_for_session(db, session),
        "pricing_config_json": session.pricing_config_snapshot,
        "status": session.status,
        "final_amount": session.final_amount,
        "currency": crud.get_currency(db),
        "synced_at": datetime.now().isoformat(),
    }


def _is_connectivity_failure(message: str) -> bool:
    """True for failures that say "the endpoint can't be reached right now"
    (no internet, DNS, timeout) as opposed to an answer from the endpoint
    (wrong secret, HTTP error). Used to stop a sync cycle early instead of
    waiting REQUEST_TIMEOUT_SECONDS once per session."""
    return message.startswith(("Connection failed", "Unexpected error"))


def push_one(url: str, secret: str, payload: dict) -> tuple[bool, str]:
    """POSTs one session's data to the configured endpoint. Returns
    (success, message). Never raises -- all failure modes (no internet,
    bad URL, endpoint down, non-200 response) are caught and reported back
    as a plain message so callers can log/display it without a try/except
    of their own.

    NOTE on the response contract: this checks BOTH the HTTP status code
    AND, if the body is JSON, an "ok" field -- because Google Apps Script
    Web Apps (the default/recommended target, see CLOUD_BACKUP.md) always
    return HTTP 200 even for an application-level error such as a wrong
    secret, so the HTTP status alone can't be trusted for that target. Any
    OTHER endpoint (a custom server, a webhook service, Supabase/Firebase
    REST APIs) is still handled correctly: a non-2xx status fails as
    expected, and a 2xx with a non-JSON or "ok"-less body is treated as
    success."""
    body = json.dumps({"secret": secret, "record": payload}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
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


def get_config(db: DBSession) -> dict:
    return {
        "enabled": crud.get_setting(db, "cloud_sync_enabled", "false") == "true",
        "url": crud.get_setting(db, "cloud_sync_url", "") or "",
        "secret": crud.get_setting(db, "cloud_sync_secret", "") or "",
        "last_success": crud.get_setting(db, "cloud_sync_last_success", None),
        "last_error": crud.get_setting(db, "cloud_sync_last_error", None),
    }


def set_config(db: DBSession, enabled: bool | None = None, url: str | None = None, secret: str | None = None):
    if enabled is not None:
        crud.set_setting(db, "cloud_sync_enabled", "true" if enabled else "false")
    if url is not None:
        crud.set_setting(db, "cloud_sync_url", url.strip())
    if secret is not None:
        crud.set_setting(db, "cloud_sync_secret", secret.strip())


def pending_count(db: DBSession) -> int:
    """Backlog of FINAL (completed/cancelled) sessions not yet confirmed
    synced. Active sessions aren't counted here -- they're re-pushed every
    cycle by design, not accumulated as a backlog."""
    return (
        db.query(ParkingSession)
        .filter(ParkingSession.status.in_(FINAL_STATUSES), ParkingSession.synced_to_cloud.is_(False))
        .count()
    )


def sync_pending_sessions(db: DBSession, limit: int = 25) -> dict:
    """Runs one sync cycle: re-pushes every currently active session
    (cheap, bounded by lot size) so the Sheet's live view stays current,
    then pushes up to `limit` not-yet-synced final sessions. Stops the
    FINAL batch at the first failure (most likely cause: internet or the
    endpoint is down right now) rather than retrying every remaining row
    in a row of doomed requests -- the next cycle picks up where this left
    off. An active-session push failing doesn't block anything else; it's
    simply retried again next cycle since active sessions are always
    re-pushed regardless of prior outcome."""
    config = get_config(db)
    if not config["enabled"] or not config["url"]:
        return {"attempted": 0, "succeeded": 0, "message": "Cloud backup is not enabled."}

    attempted = 0
    succeeded = 0
    last_message = "Nothing to sync."

    active_sessions = db.query(ParkingSession).filter(ParkingSession.status.in_(ACTIVE_STATUSES)).all()
    for session in active_sessions:
        attempted += 1
        ok, message = push_one(config["url"], config["secret"], _session_payload(db, session))
        last_message = message
        if ok:
            succeeded += 1
            crud.set_setting(db, "cloud_sync_last_success", datetime.now().isoformat())
        else:
            crud.set_setting(db, "cloud_sync_last_error", f"{datetime.now().isoformat()}: {message}")
            if _is_connectivity_failure(message):
                # No internet / endpoint down: every remaining push would
                # just wait out its own timeout (8 s each -- with a full lot
                # that is minutes, and it freezes the "Sync now" button).
                # Give up on this cycle; the next one retries everything.
                return {"attempted": attempted, "succeeded": succeeded, "message": message}
            # An answer from the endpoint (e.g. a rejected record) is
            # specific to that session, so keep going with the others.

    final_rows = (
        db.query(ParkingSession)
        .filter(ParkingSession.status.in_(FINAL_STATUSES), ParkingSession.synced_to_cloud.is_(False))
        .order_by(ParkingSession.exit_timestamp.asc())
        .limit(limit)
        .all()
    )
    for session in final_rows:
        attempted += 1
        ok, message = push_one(config["url"], config["secret"], _session_payload(db, session))
        last_message = message
        if ok:
            session.synced_to_cloud = True
            db.commit()
            succeeded += 1
            crud.set_setting(db, "cloud_sync_last_success", datetime.now().isoformat())
        else:
            crud.set_setting(db, "cloud_sync_last_error", f"{datetime.now().isoformat()}: {message}")
            break  # stop the FINAL batch; likely a connectivity issue, not a per-row problem

    return {"attempted": attempted, "succeeded": succeeded, "message": last_message}
