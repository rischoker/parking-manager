"""
Two independent layers protect administrator functionality:

1. Network layer (LocalOnlyMiddleware, in app/main.py): admin routes are
   rejected outright for any request that didn't originate from the machine
   running the desktop app. The server has to bind 0.0.0.0 so phones on the
   Wi-Fi can reach the customer pages, but that only ever exposes the
   customer endpoints -- admin endpoints are invisible to the network.

2. Application layer (this file): even on localhost, admin routes require a
   valid session token issued at login, so the admin UI has a lock screen
   rather than being wide open the instant the app starts.

On top of those two, a THIRD layer -- role-based authorization -- governs
what a *logged-in* user can do: every account is either ADMIN (everything)
or ATTENDANT ("Vigilante" in the UI: day-to-day operations only -- assign
spaces, register exits, cancel sessions, log monthly-fee payments -- with
no access to pricing, schedules, settings, reporting, or account
management). This is enforced by the require_full_admin dependency in
app/routers/admin.py on every route that needs it, checking the ROLE
embedded in the session token issued at login below -- never by hiding
buttons in the UI alone, since a restricted account could otherwise just
call the API directly.

Customer-facing routes need none of this: they are public by design, but
are restricted to reading/writing only the single session identified by
the unguessable token in the URL (see routers/customer.py).
"""
import hashlib
import hmac
import secrets
import threading
import time

DEFAULT_ADMIN_PIN = "1234"
_PBKDF2_ITERATIONS = 200_000
TOKEN_TTL_SECONDS = 12 * 60 * 60  # 12 hours

# In-memory admin session tokens, each mapped to who it belongs to. token ->
# {"user_id": int, "role": str, "expiry": float}. Deliberately not
# persisted: every fresh launch of the desktop app requires logging in
# again, like a device lock.
_active_tokens: dict[str, dict] = {}


def hash_pin(pin: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt), _PBKDF2_ITERATIONS)
    return f"{salt}${digest.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        salt, digest_hex = stored.split("$")
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt), _PBKDF2_ITERATIONS)
    return hmac.compare_digest(check.hex(), digest_hex)


def issue_token(user_id: int, role: str) -> str:
    token = secrets.token_urlsafe(32)
    _active_tokens[token] = {"user_id": user_id, "role": role, "expiry": time.time() + TOKEN_TTL_SECONDS}
    return token


def get_session(token: str | None) -> dict | None:
    """Returns {"user_id": int, "role": str} if the token is valid and
    unexpired, else None. This is the single source of truth both for
    "is this request authenticated at all" and "what is this user allowed
    to do" -- see require_admin / require_full_admin in
    app/routers/admin.py."""
    if not token:
        return None
    entry = _active_tokens.get(token)
    if entry is None:
        return None
    if entry["expiry"] < time.time():
        _active_tokens.pop(token, None)
        return None
    return {"user_id": entry["user_id"], "role": entry["role"]}


def revoke_token(token: str | None) -> None:
    if token:
        _active_tokens.pop(token, None)


def revoke_all_tokens_for_user(user_id: int) -> None:
    """Used when an account is deactivated or has its PIN reset by an
    admin -- immediately invalidates any session that user is currently
    logged into, rather than waiting up to TOKEN_TTL_SECONDS for it to
    expire on its own."""
    stale = [tok for tok, entry in _active_tokens.items() if entry["user_id"] == user_id]
    for tok in stale:
        _active_tokens.pop(tok, None)


# ---------------------------------------------------------------------------
# Login throttling
# ---------------------------------------------------------------------------
# PINs are short (4+ characters) and admin routes accept login attempts from
# the local machine without limit, so a script -- or a hostile web page open in
# a browser on this PC -- could otherwise walk through all 10,000 four-digit
# PINs in minutes. After MAX_FAILURES wrong PINs for one username the account
# is locked for a while, and the wait doubles each time it happens again
# (capped), until a correct PIN resets it. A small global limit also stops
# someone from rotating through usernames instead.
MAX_FAILURES = 5
BASE_LOCK_SECONDS = 30
MAX_LOCK_SECONDS = 15 * 60
GLOBAL_FAILURES_PER_MINUTE = 25

_throttle_lock = threading.Lock()
_login_state: dict[str, dict] = {}   # username -> {"failures": int, "strikes": int, "locked_until": float}
_recent_failures: list[float] = []   # timestamps of failures across all usernames


def seconds_until_login_allowed(username: str) -> int:
    """0 if a login attempt may proceed now, else the seconds to wait."""
    now = time.time()
    with _throttle_lock:
        waits = [0.0]
        state = _login_state.get(username.strip().lower())
        if state:
            waits.append(state["locked_until"] - now)
        recent = [t for t in _recent_failures if now - t < 60]
        _recent_failures[:] = recent
        if len(recent) >= GLOBAL_FAILURES_PER_MINUTE:
            waits.append(60 - (now - recent[0]))
        wait = max(waits)
    return int(wait) + 1 if wait > 0 else 0


def record_login_failure(username: str) -> None:
    now = time.time()
    with _throttle_lock:
        _recent_failures.append(now)
        state = _login_state.setdefault(
            username.strip().lower(), {"failures": 0, "strikes": 0, "locked_until": 0.0}
        )
        state["failures"] += 1
        if state["failures"] >= MAX_FAILURES:
            state["failures"] = 0
            state["strikes"] += 1
            lock = min(MAX_LOCK_SECONDS, BASE_LOCK_SECONDS * 2 ** (state["strikes"] - 1))
            state["locked_until"] = now + lock


def record_login_success(username: str) -> None:
    with _throttle_lock:
        _login_state.pop(username.strip().lower(), None)
