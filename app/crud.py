import json
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session as DBSession

from app import pricing_engine, security
from app.models import (
    Customer, ParkingSpace, ParkingSession, Setting,
    SpaceStatus, SessionStatus, User, UserRole, MonthlySubscription,
    MonthlyPayment, SubscriptionStatus, AuditLog, MonthlyAccessEvent,
    PersonType, SessionSource, AccessDirection,
)


class BusinessError(Exception):
    """Raised for expected, user-facing error conditions (duplicate plate,
    no available spaces, etc). Routers translate this into an HTTP 400."""


# ---------------------------------------------------------------------------
# Audit trail ("bitacora") -- who did what, when. Append-only.
# ---------------------------------------------------------------------------
QR_ACTOR = {"username": "QR", "role": None}


def _actor_name(actor: dict | None) -> str | None:
    return (actor or {}).get("username") or None


def clean_text(value, max_len: int) -> str | None:
    """Trims, collapses inner whitespace, drops control characters and caps the
    length. Empty becomes None. Used for the free-text access-log fields."""
    if value is None:
        return None
    text = "".join(ch for ch in str(value) if ch.isprintable() or ch in " \t")
    text = " ".join(text.split())
    return text[:max_len] or None


def add_audit(db: DBSession, actor: dict | None, action: str,
              subject: str | None = None, details: str | None = None) -> None:
    """Queues one audit row on the caller's transaction (NO commit), so the
    action and its audit entry are saved together or not at all."""
    db.add(AuditLog(
        username=_actor_name(actor) or "system",
        role=(actor or {}).get("role"),
        action=action,
        subject=clean_text(subject, 120),
        details=clean_text(details, 500),
    ))


def log_audit(db: DBSession, actor: dict | None, action: str,
              subject: str | None = None, details: str | None = None) -> None:
    add_audit(db, actor, action, subject, details)
    db.commit()


def search_audit(db: DBSession, action: str | None = None, username: str | None = None,
                 q: str | None = None, date_from: datetime | None = None,
                 date_to: datetime | None = None, limit: int = 100, offset: int = 0):
    query = db.query(AuditLog)
    if action:
        query = query.filter(AuditLog.action == action)
    if username:
        query = query.filter(AuditLog.username == username)
    if q:
        like = f"%{q}%"
        query = query.filter(AuditLog.subject.ilike(like) | AuditLog.details.ilike(like))
    if date_from:
        query = query.filter(AuditLog.ts >= date_from)
    if date_to:
        query = query.filter(AuditLog.ts < date_to)
    total = query.count()
    rows = query.order_by(AuditLog.ts.desc(), AuditLog.id.desc()).offset(offset).limit(limit).all()
    return rows, total


def search_monthly_events(db: DBSession, subscription_id: int | None = None, q: str | None = None,
                          date_from: datetime | None = None, date_to: datetime | None = None,
                          limit: int = 100, offset: int = 0):
    query = db.query(MonthlyAccessEvent)
    if subscription_id:
        query = query.filter(MonthlyAccessEvent.subscription_id == subscription_id)
    if q:
        like = f"%{q}%"
        query = query.filter(MonthlyAccessEvent.plate.ilike(like) | MonthlyAccessEvent.customer_name.ilike(like))
    if date_from:
        query = query.filter(MonthlyAccessEvent.ts >= date_from)
    if date_to:
        query = query.filter(MonthlyAccessEvent.ts < date_to)
    total = query.count()
    rows = query.order_by(MonthlyAccessEvent.ts.desc(), MonthlyAccessEvent.id.desc()).offset(offset).limit(limit).all()
    return rows, total


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
DEFAULT_SETTINGS = {
    "business_name": "City Center Parking",
    "currency_code": "COP",
    "currency_symbol": "$",
    "admin_pin_hash": None,  # set during seeding
}


def get_setting(db: DBSession, key: str, default=None):
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else default


def set_setting(db: DBSession, key: str, value: str):
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    db.commit()


def get_currency(db: DBSession) -> str:
    return get_setting(db, "currency_code", "COP")


def status_page_url(db: DBSession, session_token: str) -> str | None:
    """Returns the optional 'check my status from anywhere' link (GitHub
    Pages + Google Sheets, see GITHUB_PAGES_STATUS.md) if configured, else
    None. This is purely a companion link shown alongside the local
    session page -- it never replaces it."""
    enabled = get_setting(db, "status_page_enabled", "false") == "true"
    base = (get_setting(db, "status_page_base_url", "") or "").strip().rstrip("/")
    if enabled and base:
        return f"{base}/?token={session_token}"
    return None


# ---------------------------------------------------------------------------
# Parking spaces
# ---------------------------------------------------------------------------
def list_spaces(db: DBSession) -> list[ParkingSpace]:
    return db.query(ParkingSpace).order_by(ParkingSpace.number.asc()).all()


def get_space(db: DBSession, space_id: int) -> ParkingSpace | None:
    return db.query(ParkingSpace).filter(ParkingSpace.id == space_id).first()


def reserved_space_ids(db: DBSession) -> set[int]:
    """Space IDs currently reserved by an ACTIVE monthly subscription --
    these are excluded from the walk-in/QR assignment pool regardless of
    whether the space's own AVAILABLE/OCCUPIED status would otherwise
    allow it, and regardless of whether the subscriber's car happens to
    be physically parked there right now (see MonthlySubscription's
    currently_parked field, which is informational only)."""
    rows = (
        db.query(MonthlySubscription.space_id)
        .filter(MonthlySubscription.status == SubscriptionStatus.ACTIVE.value)
        .all()
    )
    return {r[0] for r in rows}


def available_spaces(db: DBSession) -> list[ParkingSpace]:
    reserved = reserved_space_ids(db)
    q = db.query(ParkingSpace).filter(ParkingSpace.status == SpaceStatus.AVAILABLE.value)
    spaces = q.order_by(ParkingSpace.number.asc()).all()
    return [s for s in spaces if s.id not in reserved]


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------
def get_or_create_customer(db: DBSession, name: str, plate: str, phone: str | None) -> Customer:
    """Reuses the Customer row for this plate ONLY when the name matches
    too. Every ParkingSession points at its Customer row, so renaming a
    shared row (what the old code did when a different person registered the
    same plate -- a sold car, a borrowed one, a typo) silently rewrote the
    name shown on all of that plate's earlier sessions in History and the
    exports. A different name now gets its own row and the past stays as it
    was recorded."""
    customer = (
        db.query(Customer)
        .filter(Customer.plate == plate, func.lower(Customer.name) == name.strip().lower())
        .order_by(Customer.id.desc())
        .first()
    )
    if customer:
        if phone:
            customer.phone = phone
        customer.updated_at = datetime.now()
    else:
        customer = Customer(name=name, plate=plate, phone=phone)
        db.add(customer)
    db.flush()
    return customer


def has_active_session_for_plate(db: DBSession, plate: str) -> bool:
    active_statuses = [SessionStatus.PENDING_ASSIGNMENT.value, SessionStatus.OCCUPIED.value]
    return (
        db.query(ParkingSession)
        .join(Customer)
        .filter(Customer.plate == plate, ParkingSession.status.in_(active_statuses))
        .first()
        is not None
    )


def has_active_session_for_phone(db: DBSession, phone: str) -> bool:
    active_statuses = [SessionStatus.PENDING_ASSIGNMENT.value, SessionStatus.OCCUPIED.value]
    return (
        db.query(ParkingSession)
        .join(Customer)
        .filter(Customer.phone == phone, ParkingSession.status.in_(active_statuses))
        .first()
        is not None
    )


# ---------------------------------------------------------------------------
# Sessions: registration (QR flow) -> assignment -> exit
# ---------------------------------------------------------------------------
def _check_space_assignable(db: DBSession, space_id: int) -> ParkingSpace:
    space = get_space(db, space_id)
    if not space:
        raise BusinessError("Parking space not found.")
    if space.status != SpaceStatus.AVAILABLE.value:
        raise BusinessError(f"Space {space.number} is not available.")
    if space.id in reserved_space_ids(db):
        raise BusinessError(f"Space {space.number} is reserved for a monthly subscriber "
                             "and is not available for walk-in assignment.")
    return space


def _describe(session: ParkingSession, name: str) -> str:
    """Audit details are written as language-neutral key=value pairs so the
    log reads the same whether the console is shown in Spanish or English."""
    parts = [f"name={name}", f"type={session.person_type}"]
    if session.unit:
        parts.append(f"unit={session.unit}")
    if session.visiting:
        parts.append(f"visiting={session.visiting}")
    if session.vehicle_desc:
        parts.append(f"vehicle={session.vehicle_desc}")
    return "; ".join(parts)


def create_session(db: DBSession, name: str, plate: str, phone: str | None, *,
                   person_type: str = PersonType.VISITOR.value, unit: str | None = None,
                   visiting: str | None = None, vehicle_desc: str | None = None,
                   source: str = SessionSource.QR.value, actor: dict | None = None,
                   space_id: int | None = None) -> ParkingSession:
    """Registers an entry. Two ways in: a customer scanning the QR (source QR,
    waits for the attendant to assign a space) or the attendant registering
    the vehicle at the gate (source MANUAL, optionally with the space right
    away). Both leave an audit row."""
    if person_type not in {p.value for p in PersonType}:
        raise BusinessError("Person type must be VISITOR, RESIDENT or SERVICE.")
    if source not in {x.value for x in SessionSource}:
        raise BusinessError("Invalid source.")
    if has_active_session_for_plate(db, plate):
        raise BusinessError(
            f"Plate {plate} already has an active parking session. "
            "If this is a mistake, ask the attendant to check the dashboard."
        )
    # A phone can only hold one self-registered session at a time (stops one
    # person flooding the queue), but a guard may legitimately register two
    # cars that share a contact number.
    if source == SessionSource.QR.value and phone and has_active_session_for_phone(db, phone):
        raise BusinessError(
            "This phone number already has an active parking session registered."
        )
    space = _check_space_assignable(db, space_id) if space_id else None

    customer = get_or_create_customer(db, name, plate, phone)

    now = datetime.now()
    try:
        rule = pricing_engine.resolve_pricing_rule(db, now)
    except pricing_engine.PricingError as exc:
        raise BusinessError(str(exc)) from exc

    session = ParkingSession(
        customer_id=customer.id,
        space_id=None,
        entry_timestamp=now,
        pricing_rule_id=rule.id,
        pricing_rule_name=rule.name,
        pricing_type=rule.type,
        pricing_config_snapshot=rule.configuration,
        status=SessionStatus.PENDING_ASSIGNMENT.value,
        person_type=person_type,
        unit=clean_text(unit, 40),
        visiting=clean_text(visiting, 120),
        vehicle_desc=clean_text(vehicle_desc, 80),
        source=source,
        checked_in_by=_actor_name(actor) if source == SessionSource.MANUAL.value else None,
    )
    db.add(session)
    if space:
        space.status = SpaceStatus.OCCUPIED.value
        session.space = space
        session.status = SessionStatus.OCCUPIED.value
    detail = _describe(session, name)
    if space:
        detail += f"; space={space.number}"
    if source == SessionSource.MANUAL.value:
        add_audit(db, actor, "SESSION_CHECKIN", plate, detail)
    else:
        add_audit(db, QR_ACTOR, "SESSION_REGISTERED", plate, detail)
    db.commit()
    db.refresh(session)
    return session


def assign_space(db: DBSession, session_id: int, space_id: int, actor: dict | None = None) -> ParkingSession:
    session = db.query(ParkingSession).filter(ParkingSession.id == session_id).first()
    if not session:
        raise BusinessError("Session not found.")
    if session.status != SessionStatus.PENDING_ASSIGNMENT.value:
        raise BusinessError(f"Session is not awaiting assignment (status: {session.status}).")

    space = _check_space_assignable(db, space_id)

    space.status = SpaceStatus.OCCUPIED.value
    session.space_id = space.id
    session.status = SessionStatus.OCCUPIED.value
    add_audit(db, actor, "SPACE_ASSIGNED", session.customer.plate, f"space={space.number}")
    db.commit()
    db.refresh(session)
    return session


def register_exit(db: DBSession, session_id: int, actor: dict | None = None) -> ParkingSession:
    session = db.query(ParkingSession).filter(ParkingSession.id == session_id).first()
    if not session:
        raise BusinessError("Session not found.")
    if session.status != SessionStatus.OCCUPIED.value:
        raise BusinessError(f"Session is not currently occupied (status: {session.status}).")

    now = datetime.now()
    pricing_type = pricing_type_for_session(db, session)
    minutes, amount = pricing_engine.price_session(
        session.entry_timestamp, now, pricing_type, session.pricing_config_snapshot
    )

    session.exit_timestamp = now
    session.duration_minutes = minutes
    session.final_amount = amount
    session.status = SessionStatus.COMPLETED.value
    session.checked_out_by = _actor_name(actor)

    space_number = None
    if session.space_id:
        space = get_space(db, session.space_id)
        if space:
            space.status = SpaceStatus.AVAILABLE.value
            space_number = space.number

    add_audit(db, actor, "SESSION_EXIT", session.customer.plate,
              f"space={space_number}; minutes={round(minutes)}; amount={amount}")
    db.commit()
    db.refresh(session)
    return session


def cancel_session(db: DBSession, session_id: int, actor: dict | None = None) -> ParkingSession:
    session = db.query(ParkingSession).filter(ParkingSession.id == session_id).first()
    if not session:
        raise BusinessError("Session not found.")
    if session.status not in (SessionStatus.PENDING_ASSIGNMENT.value, SessionStatus.OCCUPIED.value):
        raise BusinessError("Only pending or occupied sessions can be cancelled.")

    if session.space_id:
        space = get_space(db, session.space_id)
        if space:
            space.status = SpaceStatus.AVAILABLE.value

    session.status = SessionStatus.CANCELLED.value
    session.exit_timestamp = datetime.now()
    session.checked_out_by = _actor_name(actor)
    add_audit(db, actor, "SESSION_CANCELLED", session.customer.plate, f"type={session.person_type}")
    db.commit()
    db.refresh(session)
    return session


def pricing_type_for_session(db: DBSession, session: ParkingSession) -> str:
    """The pricing type (HOURLY/FLAT) that governs this session. It is
    snapshotted on the session together with its configuration (see
    ParkingSession.pricing_type), so editing -- or even deleting -- the
    original PricingRule can never change how an existing session is priced.
    `db` is kept in the signature for the existing call sites; the fallback
    below (shape of the snapshot) only matters for a row the migration has
    not backfilled yet."""
    if session.pricing_type:
        return session.pricing_type
    try:
        config = json.loads(session.pricing_config_snapshot or "{}")
    except (TypeError, ValueError):
        config = {}
    return "FLAT" if "flat_rate" in config else "HOURLY"


def live_estimate(db: DBSession, session: ParkingSession) -> tuple[float, float]:
    pricing_type = pricing_type_for_session(db, session)
    return pricing_engine.price_session(
        session.entry_timestamp, datetime.now(), pricing_type, session.pricing_config_snapshot
    )


def get_session(db: DBSession, session_id: int) -> ParkingSession | None:
    return db.query(ParkingSession).filter(ParkingSession.id == session_id).first()


def get_session_by_token(db: DBSession, token: str) -> ParkingSession | None:
    return db.query(ParkingSession).filter(ParkingSession.session_token == token).first()


def pending_registrations(db: DBSession) -> list[ParkingSession]:
    return (
        db.query(ParkingSession)
        .filter(ParkingSession.status == SessionStatus.PENDING_ASSIGNMENT.value)
        .order_by(ParkingSession.entry_timestamp.asc())
        .all()
    )


def occupied_sessions(db: DBSession) -> list[ParkingSession]:
    return (
        db.query(ParkingSession)
        .filter(ParkingSession.status == SessionStatus.OCCUPIED.value)
        .all()
    )


# ---------------------------------------------------------------------------
# History / search
# ---------------------------------------------------------------------------
def search_history(
    db: DBSession,
    plate: str | None = None,
    customer: str | None = None,
    space_number: str | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = 200,
    offset: int = 0,
    person_type: str | None = None,
    unit: str | None = None,
):
    q = db.query(ParkingSession).join(Customer)
    if person_type:
        q = q.filter(ParkingSession.person_type == person_type)
    if unit:
        q = q.filter(ParkingSession.unit.ilike(f"%{unit}%"))
    if plate:
        q = q.filter(Customer.plate.ilike(f"%{plate.upper()}%"))
    if customer:
        q = q.filter(Customer.name.ilike(f"%{customer}%"))
    if status:
        q = q.filter(ParkingSession.status == status)
    if space_number:
        q = q.join(ParkingSpace, ParkingSession.space_id == ParkingSpace.id).filter(
            ParkingSpace.number == space_number
        )
    if date_from:
        q = q.filter(ParkingSession.entry_timestamp >= date_from)
    if date_to:
        # Exclusive upper bound: callers pass "the first instant AFTER the
        # range" (e.g. the next midnight for a whole-day end date).
        q = q.filter(ParkingSession.entry_timestamp < date_to)

    total = q.count()
    rows = (
        q.order_by(ParkingSession.entry_timestamp.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return rows, total


# ---------------------------------------------------------------------------
# Revenue
# ---------------------------------------------------------------------------
def revenue_between(db: DBSession, start: datetime, end: datetime) -> dict:
    completed = (
        db.query(ParkingSession)
        .filter(
            ParkingSession.status == SessionStatus.COMPLETED.value,
            ParkingSession.exit_timestamp >= start,
            ParkingSession.exit_timestamp < end,
        )
        .all()
    )
    hourly_total = 0.0
    flat_total = 0.0
    for s in completed:
        ptype = pricing_type_for_session(db, s)
        if ptype == "FLAT":
            flat_total += s.final_amount or 0.0
        else:
            hourly_total += s.final_amount or 0.0

    total = hourly_total + flat_total
    count = len(completed)
    return {
        "vehicles_served": count,
        "hourly_revenue": round(hourly_total, 2),
        "flat_revenue": round(flat_total, 2),
        "total_revenue": round(total, 2),
        "average_ticket": round(total / count, 2) if count else 0.0,
    }


def daily_revenue_series(db: DBSession, days: int = 14) -> list[dict]:
    end = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start = end - timedelta(days=days)
    completed = (
        db.query(ParkingSession)
        .filter(
            ParkingSession.status == SessionStatus.COMPLETED.value,
            ParkingSession.exit_timestamp >= start,
            ParkingSession.exit_timestamp < end,
        )
        .all()
    )
    buckets = {}
    for i in range(days):
        day = (start + timedelta(days=i)).date()
        buckets[day.isoformat()] = 0.0
    for s in completed:
        day = s.exit_timestamp.date().isoformat()
        if day in buckets:
            buckets[day] += s.final_amount or 0.0
    return [{"label": k, "total": round(v, 2)} for k, v in buckets.items()]


# ---------------------------------------------------------------------------
# Users (admin console accounts -- see app/security.py for the session/role
# model this backs)
# ---------------------------------------------------------------------------
def get_user_by_username(db: DBSession, username: str) -> User | None:
    return db.query(User).filter(User.username == username.strip().lower()).first()


def get_user(db: DBSession, user_id: int) -> User | None:
    return db.query(User).filter(User.id == user_id).first()


def list_users(db: DBSession) -> list[User]:
    return db.query(User).order_by(User.username.asc()).all()


def create_user(db: DBSession, username: str, display_name: str, pin: str, role: str) -> User:
    username = username.strip().lower()
    if not username or len(username) < 2:
        raise BusinessError("Username must be at least 2 characters.")
    if get_user_by_username(db, username):
        raise BusinessError(f"Username '{username}' is already taken.")
    if not pin or len(pin) < 4:
        raise BusinessError("PIN must be at least 4 characters.")
    if role not in (UserRole.ADMIN.value, UserRole.ATTENDANT.value):
        raise BusinessError("Role must be ADMIN or ATTENDANT.")
    user = User(username=username, display_name=display_name.strip() or username,
                pin_hash=security.hash_pin(pin), role=role, active=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user(db: DBSession, user_id: int, display_name: str | None = None,
                 role: str | None = None, active: bool | None = None) -> User:
    user = get_user(db, user_id)
    if not user:
        raise BusinessError("User not found.")
    if role is not None and role not in (UserRole.ADMIN.value, UserRole.ATTENDANT.value):
        raise BusinessError("Role must be ADMIN or ATTENDANT.")
    if user.role == UserRole.ADMIN.value and (role == UserRole.ATTENDANT.value or active is False):
        admin_count = db.query(User).filter(User.role == UserRole.ADMIN.value, User.active.is_(True)).count()
        if admin_count <= 1:
            raise BusinessError("Can't demote or deactivate the last remaining admin account.")
    if display_name is not None:
        user.display_name = display_name.strip() or user.username
    if role is not None:
        if role != user.role:
            # The role is baked into the login token when it is issued, so
            # without this a demoted admin would keep full admin rights (and
            # a promoted attendant would stay restricted) until the token
            # expired up to 12 hours later. Force a fresh login instead.
            security.revoke_all_tokens_for_user(user.id)
        user.role = role
    if active is not None:
        user.active = active
        if active is False:
            security.revoke_all_tokens_for_user(user.id)
    db.commit()
    db.refresh(user)
    return user


def reset_user_pin(db: DBSession, user_id: int, new_pin: str) -> None:
    """Admin action: sets a user's PIN without needing their current one
    (for when someone forgets it). Immediately invalidates any session
    they're currently logged into."""
    user = get_user(db, user_id)
    if not user:
        raise BusinessError("User not found.")
    if not new_pin or len(new_pin) < 4:
        raise BusinessError("PIN must be at least 4 characters.")
    user.pin_hash = security.hash_pin(new_pin)
    db.commit()
    security.revoke_all_tokens_for_user(user.id)


def change_own_pin(db: DBSession, user_id: int, current_pin: str, new_pin: str) -> None:
    """Self-service: any logged-in user (any role) can change their OWN
    PIN, but must prove they know the current one first."""
    user = get_user(db, user_id)
    if not user:
        raise BusinessError("User not found.")
    if not security.verify_pin(current_pin, user.pin_hash):
        raise BusinessError("Current PIN is incorrect.")
    if not new_pin or len(new_pin) < 4:
        raise BusinessError("New PIN must be at least 4 characters.")
    user.pin_hash = security.hash_pin(new_pin)
    db.commit()


def verify_login(db: DBSession, username: str, pin: str) -> User | None:
    user = get_user_by_username(db, username)
    if not user or not user.active:
        return None
    if not security.verify_pin(pin, user.pin_hash):
        return None
    return user


# ---------------------------------------------------------------------------
# Monthly subscriptions ("mensualidades") -- fixed spaces reserved by the
# same person every month for a flat fee, tracked entirely separately from
# the timed/pay-per-visit ParkingSession system. See MonthlySubscription's
# docstring in app/models.py for the full reasoning.
# ---------------------------------------------------------------------------
def _add_one_month(dt: datetime, anchor_day: int | None = None) -> datetime:
    """Calendar-aware +1 month. When the target month is shorter, the day is
    clamped (Jan 31 -> Feb 28), but `anchor_day` -- the day of the month the
    subscription started on -- is used for every following step so it
    recovers (Feb 28 -> Mar 31) instead of drifting for good to the 28th.
    Avoids pulling in dateutil for one small piece of math."""
    import calendar
    year = dt.year + (1 if dt.month == 12 else 0)
    month = 1 if dt.month == 12 else dt.month + 1
    day = min(anchor_day or dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def current_period_label(at: datetime | None = None) -> str:
    at = at or datetime.now()
    return f"{at.year:04d}-{at.month:02d}"


def list_subscriptions(db: DBSession, status: str | None = None) -> list[MonthlySubscription]:
    q = db.query(MonthlySubscription)
    if status:
        q = q.filter(MonthlySubscription.status == status)
    return q.order_by(MonthlySubscription.status.asc(), MonthlySubscription.customer_name.asc()).all()


def get_subscription(db: DBSession, subscription_id: int) -> MonthlySubscription | None:
    return db.query(MonthlySubscription).filter(MonthlySubscription.id == subscription_id).first()


def create_subscription(db: DBSession, customer_name: str, plate: str, space_id: int, monthly_fee: float,
                         phone: str | None = None, additional_plates: str | None = None,
                         notes: str | None = None) -> MonthlySubscription:
    space = get_space(db, space_id)
    if not space:
        raise BusinessError("Parking space not found.")
    if space.id in reserved_space_ids(db):
        raise BusinessError(f"Space {space.number} is already reserved by another monthly subscription.")
    if space.status == SpaceStatus.OCCUPIED.value:
        raise BusinessError(f"Space {space.number} currently has an active walk-in session -- "
                             "register that exit first, or choose a different space.")
    if monthly_fee < 0:
        raise BusinessError("Monthly fee cannot be negative.")
    now = datetime.now()
    sub = MonthlySubscription(
        customer_name=customer_name.strip(), plate=plate.strip().upper().replace(" ", ""),
        additional_plates=additional_plates, phone=phone, space_id=space_id,
        monthly_fee=monthly_fee, status=SubscriptionStatus.ACTIVE.value,
        start_date=now, next_due_date=now, notes=notes,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def update_subscription(db: DBSession, subscription_id: int, customer_name: str | None = None,
                         plate: str | None = None, phone: str | None = None,
                         additional_plates: str | None = None, monthly_fee: float | None = None,
                         notes: str | None = None) -> MonthlySubscription:
    sub = get_subscription(db, subscription_id)
    if not sub:
        raise BusinessError("Subscription not found.")
    if sub.status != SubscriptionStatus.ACTIVE.value:
        raise BusinessError("Cannot edit a cancelled subscription.")
    if customer_name is not None:
        sub.customer_name = customer_name.strip()
    if plate is not None:
        sub.plate = plate.strip().upper().replace(" ", "")
    if phone is not None:
        sub.phone = phone
    if additional_plates is not None:
        sub.additional_plates = additional_plates
    if monthly_fee is not None:
        if monthly_fee < 0:
            raise BusinessError("Monthly fee cannot be negative.")
        sub.monthly_fee = monthly_fee
    if notes is not None:
        sub.notes = notes
    db.commit()
    db.refresh(sub)
    return sub


def cancel_subscription(db: DBSession, subscription_id: int) -> MonthlySubscription:
    sub = get_subscription(db, subscription_id)
    if not sub:
        raise BusinessError("Subscription not found.")
    sub.status = SubscriptionStatus.CANCELLED.value
    sub.currently_parked = False
    db.commit()
    db.refresh(sub)
    return sub


def log_monthly_payment(db: DBSession, subscription_id: int, amount_paid: float,
                         notes: str | None = None) -> MonthlyPayment:
    sub = get_subscription(db, subscription_id)
    if not sub:
        raise BusinessError("Subscription not found.")
    if sub.status != SubscriptionStatus.ACTIVE.value:
        raise BusinessError("Cannot log a payment for a cancelled subscription.")
    if amount_paid < 0:
        raise BusinessError("Amount cannot be negative.")
    payment = MonthlyPayment(
        subscription_id=subscription_id,
        period_label=current_period_label(sub.next_due_date),
        amount_paid=amount_paid,
        paid_on=datetime.now(),
        notes=notes,
    )
    db.add(payment)
    sub.next_due_date = _add_one_month(sub.next_due_date, anchor_day=sub.start_date.day)
    db.commit()
    db.refresh(payment)
    return payment


def toggle_currently_parked(db: DBSession, subscription_id: int, parked: bool,
                            actor: dict | None = None) -> MonthlySubscription:
    """Marks a monthly subscriber's vehicle as inside / outside. Every real
    change leaves a timestamped IN/OUT row (MonthlyAccessEvent); repeating the
    state it already has is a no-op, so a double click can't invent a
    movement."""
    sub = get_subscription(db, subscription_id)
    if not sub:
        raise BusinessError("Subscription not found.")
    if parked and sub.status != SubscriptionStatus.ACTIVE.value:
        raise BusinessError("Cannot register an entry for a cancelled subscription.")
    if bool(sub.currently_parked) != parked:
        sub.currently_parked = parked
        db.add(MonthlyAccessEvent(
            subscription_id=sub.id,
            direction=AccessDirection.IN.value if parked else AccessDirection.OUT.value,
            recorded_by=_actor_name(actor),
            customer_name=sub.customer_name,
            plate=sub.plate,
            space_number=sub.space.number if sub.space else None,
        ))
        db.commit()
    db.refresh(sub)
    return sub


def is_subscription_overdue(sub: MonthlySubscription, at: datetime | None = None) -> bool:
    at = at or datetime.now()
    return sub.status == SubscriptionStatus.ACTIVE.value and sub.next_due_date < at


def monthly_revenue_between(db: DBSession, start: datetime, end: datetime) -> float:
    total = (
        db.query(func.sum(MonthlyPayment.amount_paid))
        .filter(MonthlyPayment.paid_on >= start, MonthlyPayment.paid_on < end)
        .scalar()
    )
    return round(total or 0.0, 2)
