import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Column, Integer, String, DateTime, ForeignKey, Boolean, Text, Float,
)
from sqlalchemy.orm import relationship

from app.database import Base


def _uuid() -> str:
    return uuid.uuid4().hex


class SpaceStatus(str, enum.Enum):
    AVAILABLE = "AVAILABLE"
    OCCUPIED = "OCCUPIED"


class SessionStatus(str, enum.Enum):
    PENDING_ASSIGNMENT = "PENDING_ASSIGNMENT"  # registered, waiting for a space
    OCCUPIED = "OCCUPIED"                       # space assigned, parked
    COMPLETED = "COMPLETED"                     # exit registered, paid
    CANCELLED = "CANCELLED"                     # admin cancelled (e.g. no-show)


class PricingType(str, enum.Enum):
    HOURLY = "HOURLY"
    FLAT = "FLAT"


class UserRole(str, enum.Enum):
    ADMIN = "ADMIN"
    ATTENDANT = "ATTENDANT"  # displayed as "Vigilante" in the Spanish UI


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    CANCELLED = "CANCELLED"


class PersonType(str, enum.Enum):
    """Who is entering. Matters in a residential complex: the access log has
    to say whether a car belongs to a resident, a visitor or a service
    provider (delivery, maintenance...)."""
    VISITOR = "VISITOR"
    RESIDENT = "RESIDENT"
    SERVICE = "SERVICE"


class SessionSource(str, enum.Enum):
    QR = "QR"          # the customer registered themself from the QR page
    MANUAL = "MANUAL"  # the attendant registered the vehicle at the gate


class AccessDirection(str, enum.Enum):
    IN = "IN"
    OUT = "OUT"


class ParkingSpace(Base):
    __tablename__ = "parking_spaces"

    id = Column(Integer, primary_key=True)
    number = Column(String(8), unique=True, nullable=False)   # "P01".."P20"
    status = Column(String(16), nullable=False, default=SpaceStatus.AVAILABLE.value)
    created_at = Column(DateTime, default=datetime.now)

    sessions = relationship("ParkingSession", back_populates="space")


class Customer(Base):
    __tablename__ = "customers"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False)
    plate = Column(String(20), nullable=False, index=True)
    phone = Column(String(30), nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    sessions = relationship("ParkingSession", back_populates="customer")


class PricingRule(Base):
    __tablename__ = "pricing_rules"

    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False)
    type = Column(String(16), nullable=False)          # HOURLY | FLAT
    configuration = Column(Text, nullable=False)         # JSON blob, see pricing_engine.py
    is_default = Column(Boolean, default=False)          # used when no schedule matches
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    schedules = relationship("Schedule", back_populates="pricing_rule")


class Schedule(Base):
    __tablename__ = "schedules"

    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False)
    # Comma-separated weekday codes, e.g. "MON,TUE,WED,THU,FRI" or "SAT,SUN" or "ALL"
    days_of_week = Column(String(40), nullable=False)
    start_time = Column(String(5), nullable=False)   # "HH:MM", 24h
    end_time = Column(String(5), nullable=False)      # "HH:MM"; may wrap past midnight
    pricing_rule_id = Column(Integer, ForeignKey("pricing_rules.id"), nullable=False)
    priority = Column(Integer, default=100)  # lower number = checked first
    active = Column(Boolean, default=True)

    pricing_rule = relationship("PricingRule", back_populates="schedules")


class ParkingSession(Base):
    __tablename__ = "parking_sessions"

    id = Column(Integer, primary_key=True)
    session_token = Column(String(40), unique=True, default=_uuid, index=True)

    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=False)
    space_id = Column(Integer, ForeignKey("parking_spaces.id"), nullable=True)

    entry_timestamp = Column(DateTime, nullable=False, default=datetime.now)
    exit_timestamp = Column(DateTime, nullable=True)

    # Pricing is *snapshotted* at registration time so that later edits to a
    # pricing rule never change the price of a session that already used it.
    pricing_rule_id = Column(Integer, ForeignKey("pricing_rules.id"), nullable=True)
    pricing_rule_name = Column(String(80), nullable=True)
    # The rule's TYPE (HOURLY | FLAT) is snapshotted together with its
    # configuration. Both must travel together: if only the configuration
    # were frozen and the type were looked up live from the rule, editing a
    # rule from HOURLY to FLAT while a car was parked with it would pair a
    # FLAT calculator with an hourly config and crash the dashboard, the
    # exit and the customer page. NULL only on rows created before this
    # column existed; database._run_light_migrations backfills those.
    pricing_type = Column(String(16), nullable=True)
    pricing_config_snapshot = Column(Text, nullable=True)

    duration_minutes = Column(Float, nullable=True)
    final_amount = Column(Float, nullable=True)
    status = Column(String(24), nullable=False, default=SessionStatus.PENDING_ASSIGNMENT.value)

    # Best-effort cloud backup flag (see app/cloud_sync.py). False until a
    # completed session has been successfully pushed to the configured
    # cloud endpoint; a background loop retries anything still False.
    synced_to_cloud = Column(Boolean, default=False)
    # Fingerprint of the last version of this session that the cloud
    # acknowledged. An active session is only re-sent when its data actually
    # changed (see app/cloud_sync.py), instead of every 30 seconds.
    cloud_hash = Column(String(64), nullable=True)

    # --- Access-log details (v1.2). A residential complex needs to know WHO
    # came in, to WHERE and with WHAT vehicle, and which guard recorded it. ---
    person_type = Column(String(16), nullable=False, default=PersonType.VISITOR.value)
    unit = Column(String(40), nullable=True)            # tower / apartment, free text
    visiting = Column(String(120), nullable=True)       # resident being visited
    vehicle_desc = Column(String(80), nullable=True)    # make / colour / type
    source = Column(String(8), nullable=False, default=SessionSource.QR.value)
    checked_in_by = Column(String(40), nullable=True)   # username of the guard (MANUAL only)
    checked_out_by = Column(String(40), nullable=True)  # username who registered the exit

    created_at = Column(DateTime, default=datetime.now)

    customer = relationship("Customer", back_populates="sessions")
    space = relationship("ParkingSpace", back_populates="sessions")


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String(60), primary_key=True)
    value = Column(Text, nullable=True)


class User(Base):
    """Admin console accounts. Two roles: ADMIN (everything) and ATTENDANT
    ("Vigilante" in the UI) -- day-to-day operations only (assign spaces,
    register exits, cancel sessions, log monthly-fee payments) with no
    access to pricing, schedules, settings, revenue/history reporting, or
    account management. Enforced server-side in every route -- see
    require_full_admin in app/routers/admin.py -- not just hidden in the
    UI, since a restricted user could otherwise call the API directly."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    username = Column(String(40), unique=True, nullable=False)
    display_name = Column(String(80), nullable=False)
    pin_hash = Column(String(200), nullable=False)
    role = Column(String(16), nullable=False, default=UserRole.ATTENDANT.value)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)


class MonthlySubscription(Base):
    """A fixed/reserved parking space rented by the same person every
    month ("mensualidad") for a flat fee, instead of the normal
    per-visit hourly/flat pricing. Deliberately NOT modeled as a
    ParkingSession -- a monthly renter doesn't get timed or charged per
    visit, so there's no entry/exit/duration/pricing-rule concept to
    reuse here. What this DOES do: takes its assigned space out of the
    pool offered to walk-in QR customers (see crud.available_spaces),
    regardless of whether the subscriber's car is physically there right
    now -- see `currently_parked` below for that separate, purely
    informational flag."""
    __tablename__ = "monthly_subscriptions"

    id = Column(Integer, primary_key=True)
    customer_name = Column(String(120), nullable=False)
    plate = Column(String(20), nullable=False)
    additional_plates = Column(String(120), nullable=True)  # free text, e.g. a second car they sometimes bring
    phone = Column(String(30), nullable=True)
    space_id = Column(Integer, ForeignKey("parking_spaces.id"), nullable=False)
    monthly_fee = Column(Float, nullable=False)
    status = Column(String(16), nullable=False, default=SubscriptionStatus.ACTIVE.value)
    start_date = Column(DateTime, nullable=False, default=datetime.now)
    next_due_date = Column(DateTime, nullable=False)
    # Purely informational, toggled by the admin OR the attendant at the
    # booth -- does NOT drive any billing. Lets the dashboard show whether
    # a reserved space is currently sitting empty or has the subscriber's
    # car in it, without running it through the timed-session system.
    currently_parked = Column(Boolean, default=False)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.now)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now)

    space = relationship("ParkingSpace")
    payments = relationship("MonthlyPayment", back_populates="subscription", order_by="MonthlyPayment.paid_on.desc()")


class MonthlyPayment(Base):
    """One row per monthly payment collected for a MonthlySubscription --
    a simple ledger so the admin (or attendant, who's usually the one
    physically collecting the cash) can see who's paid for the current
    period and who's overdue."""
    __tablename__ = "monthly_payments"

    id = Column(Integer, primary_key=True)
    subscription_id = Column(Integer, ForeignKey("monthly_subscriptions.id"), nullable=False)
    period_label = Column(String(20), nullable=False)  # e.g. "2026-08"
    amount_paid = Column(Float, nullable=False)
    paid_on = Column(DateTime, nullable=False, default=datetime.now)
    notes = Column(Text, nullable=True)

    subscription = relationship("MonthlySubscription", back_populates="payments")


class AuditLog(Base):
    """Append-only record of who did what, and when. Nothing in the app edits
    or deletes these rows. `uid` is a stable identifier so the cloud copy can
    be written idempotently (a retry after a lost acknowledgement never
    duplicates an entry)."""
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True)
    uid = Column(String(32), unique=True, nullable=False, default=_uuid)
    ts = Column(DateTime, nullable=False, default=datetime.now, index=True)
    username = Column(String(40), nullable=False)   # "QR" for customer self-registration
    role = Column(String(16), nullable=True)
    action = Column(String(40), nullable=False, index=True)
    subject = Column(String(120), nullable=True)    # e.g. plate, username, rule name
    details = Column(Text, nullable=True)
    synced_to_cloud = Column(Boolean, default=False, index=True)


class MonthlyAccessEvent(Base):
    """A real, timestamped entry (IN) or exit (OUT) of a monthly subscriber's
    vehicle. Before v1.2 `currently_parked` was a bare on/off switch with no
    history; for the access log every movement now leaves a row. Name, plate
    and space are copied onto the row so history stays correct even if the
    subscription is later edited or cancelled."""
    __tablename__ = "monthly_access_events"

    id = Column(Integer, primary_key=True)
    uid = Column(String(32), unique=True, nullable=False, default=_uuid)
    subscription_id = Column(Integer, ForeignKey("monthly_subscriptions.id"), nullable=False, index=True)
    direction = Column(String(3), nullable=False)    # IN | OUT
    ts = Column(DateTime, nullable=False, default=datetime.now, index=True)
    recorded_by = Column(String(40), nullable=True)
    customer_name = Column(String(120), nullable=False)
    plate = Column(String(20), nullable=False)
    space_number = Column(String(8), nullable=True)
    synced_to_cloud = Column(Boolean, default=False, index=True)
