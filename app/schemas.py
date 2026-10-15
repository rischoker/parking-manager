import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Customer-facing
# ---------------------------------------------------------------------------
PERSON_TYPES = ("VISITOR", "RESIDENT", "SERVICE")


def _free_text(v: Optional[str], max_len: int) -> Optional[str]:
    """Trim, collapse whitespace, drop control characters, cap the length;
    empty becomes None. (Spreadsheet formula characters are neutralised on
    export, not here, so the original text is preserved.)"""
    if v is None:
        return None
    text = "".join(ch for ch in str(v) if ch.isprintable())
    text = " ".join(text.split())
    return text[:max_len] or None


class VehicleEntryBase(BaseModel):
    """Fields shared by a customer's QR self-registration and the attendant's
    manual check-in at the gate."""
    name: str = Field(min_length=2, max_length=120)
    plate: str = Field(min_length=2, max_length=20)
    phone: Optional[str] = Field(default=None, max_length=30)
    person_type: str = "VISITOR"                       # VISITOR | RESIDENT | SERVICE
    unit: Optional[str] = Field(default=None, max_length=60)       # tower / apartment
    visiting: Optional[str] = Field(default=None, max_length=160)  # resident being visited
    vehicle: Optional[str] = Field(default=None, max_length=120)   # make / colour / type

    @field_validator("person_type")
    @classmethod
    def check_person_type(cls, v: str) -> str:
        v = (v or "VISITOR").strip().upper()
        if v not in PERSON_TYPES:
            raise ValueError("Person type must be VISITOR, RESIDENT or SERVICE.")
        return v

    @field_validator("unit")
    @classmethod
    def clean_unit(cls, v: Optional[str]) -> Optional[str]:
        return _free_text(v, 40)

    @field_validator("visiting")
    @classmethod
    def clean_visiting(cls, v: Optional[str]) -> Optional[str]:
        return _free_text(v, 120)

    @field_validator("vehicle")
    @classmethod
    def clean_vehicle(cls, v: Optional[str]) -> Optional[str]:
        return _free_text(v, 80)

    @field_validator("plate")
    @classmethod
    def normalize_plate(cls, v: str) -> str:
        plate = v.strip().upper().replace(" ", "")
        # Letters, digits and hyphens only (covers car, motorcycle and foreign
        # plates). Anything else is a typo or someone probing the form.
        if not re.fullmatch(r"[A-Z0-9-]{2,12}", plate):
            raise ValueError("Plate may only contain letters, numbers and hyphens (2 to 12 characters).")
        return plate

    @field_validator("name")
    @classmethod
    def normalize_name(cls, v: str) -> str:
        name = " ".join(v.split())          # trim + collapse inner whitespace
        if len(name) < 2:
            raise ValueError("Name must have at least 2 characters.")
        return name

    @field_validator("phone")
    @classmethod
    def normalize_phone(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        phone = v.strip()
        if not phone:
            return None
        if not re.fullmatch(r"\+?\(?[0-9][0-9 ()-]{5,28}", phone):
            raise ValueError("Phone may only contain digits, spaces, +, - and parentheses.")
        return phone


class CustomerRegisterRequest(VehicleEntryBase):
    """The public QR page."""


class CheckInRequest(VehicleEntryBase):
    """The attendant registering a vehicle at the gate (any logged-in role).
    `space_id` is optional: with it the car is parked immediately, without it
    the entry waits in the pending queue like a QR registration."""
    space_id: Optional[int] = None


class CustomerRegisterResponse(BaseModel):
    session_token: str
    session_url: str


class CustomerSessionView(BaseModel):
    name: str
    plate: str
    phone: Optional[str]
    space_number: Optional[str]
    status: str
    entry_timestamp: datetime
    exit_timestamp: Optional[datetime]
    server_time: datetime
    elapsed_minutes: float
    estimated_amount: float
    final_amount: Optional[float]
    is_final: bool
    currency: str
    message: Optional[str] = None
    status_page_url: Optional[str] = None


# ---------------------------------------------------------------------------
# Admin: dashboard / spaces
# ---------------------------------------------------------------------------
class OccupiedInfo(BaseModel):
    session_id: int
    customer_name: str
    plate: str
    phone: Optional[str]
    entry_timestamp: datetime
    elapsed_minutes: float
    current_amount: float
    pricing_rule_name: str
    person_type: str = "VISITOR"
    unit: Optional[str] = None
    visiting: Optional[str] = None
    vehicle: Optional[str] = None


class MonthlyReservationInfo(BaseModel):
    subscription_id: int
    customer_name: str
    plate: str
    currently_parked: bool
    is_overdue: bool


class SpaceView(BaseModel):
    id: int
    number: str
    status: str
    occupied: Optional[OccupiedInfo] = None
    monthly: Optional[MonthlyReservationInfo] = None


class PendingRegistration(BaseModel):
    session_id: int
    customer_name: str
    plate: str
    phone: Optional[str]
    entry_timestamp: datetime
    waiting_minutes: float
    person_type: str = "VISITOR"
    unit: Optional[str] = None
    visiting: Optional[str] = None
    vehicle: Optional[str] = None


class DashboardResponse(BaseModel):
    spaces: list[SpaceView]
    available_count: int
    occupied_count: int
    monthly_count: int
    pending: list[PendingRegistration]
    server_time: datetime
    currency: str


class AssignSpaceRequest(BaseModel):
    space_id: int


class SessionDetail(BaseModel):
    id: int
    customer_name: str
    plate: str
    phone: Optional[str]
    space_number: Optional[str]
    entry_timestamp: datetime
    exit_timestamp: Optional[datetime]
    duration_minutes: Optional[float]
    pricing_rule_name: Optional[str]
    status: str
    final_amount: Optional[float]
    estimated_amount: Optional[float]
    currency: str
    person_type: str = "VISITOR"
    unit: Optional[str] = None
    visiting: Optional[str] = None
    vehicle: Optional[str] = None
    source: str = "QR"
    checked_in_by: Optional[str] = None
    checked_out_by: Optional[str] = None


# ---------------------------------------------------------------------------
# Admin: pricing & schedules
# ---------------------------------------------------------------------------
class PricingRuleIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    type: str  # HOURLY | FLAT
    configuration: dict
    is_default: bool = False
    active: bool = True


class PricingRuleOut(BaseModel):
    id: int
    name: str
    type: str
    configuration: dict
    is_default: bool
    active: bool


class ScheduleIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    days_of_week: str  # "MON,TUE,..." or "ALL"
    start_time: str    # "HH:MM"
    end_time: str       # "HH:MM"
    pricing_rule_id: int
    priority: int = 100
    active: bool = True

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_hhmm(cls, v: str) -> str:
        parts = v.split(":")
        if len(parts) != 2 or not (0 <= int(parts[0]) <= 23) or not (0 <= int(parts[1]) <= 59):
            raise ValueError("Time must be in HH:MM 24h format")
        return f"{int(parts[0]):02d}:{int(parts[1]):02d}"


class ScheduleOut(BaseModel):
    id: int
    name: str
    days_of_week: str
    start_time: str
    end_time: str
    pricing_rule_id: int
    pricing_rule_name: str
    priority: int
    active: bool


# ---------------------------------------------------------------------------
# Admin: settings / auth
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    pin: str


class LoginResponse(BaseModel):
    token: str
    role: str
    display_name: str
    username: str


class SettingsUpdate(BaseModel):
    business_name: Optional[str] = None
    currency_code: Optional[str] = None
    currency_symbol: Optional[str] = None


# ---------------------------------------------------------------------------
# Admin: revenue
# ---------------------------------------------------------------------------
class RevenueSummary(BaseModel):
    range_label: str
    start: datetime
    end: datetime
    vehicles_served: int
    hourly_revenue: float
    flat_revenue: float
    total_revenue: float
    average_ticket: float
    currency: str


class RevenueSeriesPoint(BaseModel):
    label: str
    total: float


class RevenueDashboard(BaseModel):
    today: RevenueSummary
    this_week: RevenueSummary
    this_month: RevenueSummary
    daily_series: list[RevenueSeriesPoint]
    monthly_fees_today: float
    monthly_fees_this_week: float
    monthly_fees_this_month: float


# ---------------------------------------------------------------------------
# Admin: users (roles) -- ADMIN sees/manages everything here; an ATTENDANT
# ("Vigilante") account can only change its OWN pin (see ChangeOwnPinRequest).
# ---------------------------------------------------------------------------
class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    display_name: str = Field(min_length=1, max_length=80)
    pin: str = Field(min_length=4, max_length=20)
    role: str  # ADMIN | ATTENDANT


class UserUpdateIn(BaseModel):
    display_name: Optional[str] = None
    role: Optional[str] = None
    active: Optional[bool] = None


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: str
    active: bool


class ResetPinRequest(BaseModel):
    new_pin: str = Field(min_length=4, max_length=20)


class ChangeOwnPinRequest(BaseModel):
    current_pin: str
    new_pin: str = Field(min_length=4, max_length=20)


# ---------------------------------------------------------------------------
# Admin: monthly subscriptions ("mensualidades")
# ---------------------------------------------------------------------------
class SubscriptionIn(BaseModel):
    customer_name: str = Field(min_length=2, max_length=120)
    plate: str = Field(min_length=2, max_length=20)
    space_id: int
    monthly_fee: float = Field(ge=0)
    phone: Optional[str] = None
    additional_plates: Optional[str] = None
    notes: Optional[str] = None


class SubscriptionUpdateIn(BaseModel):
    customer_name: Optional[str] = None
    plate: Optional[str] = None
    phone: Optional[str] = None
    additional_plates: Optional[str] = None
    monthly_fee: Optional[float] = Field(default=None, ge=0)
    notes: Optional[str] = None


class SubscriptionOut(BaseModel):
    id: int
    customer_name: str
    plate: str
    additional_plates: Optional[str]
    phone: Optional[str]
    space_id: int
    space_number: str
    monthly_fee: float
    status: str
    start_date: datetime
    next_due_date: datetime
    currently_parked: bool
    is_overdue: bool
    notes: Optional[str]
    currency: str


class LogPaymentRequest(BaseModel):
    amount_paid: float = Field(ge=0)
    notes: Optional[str] = None


class TogglePartedRequest(BaseModel):
    parked: bool


# ---------------------------------------------------------------------------
# Audit trail and monthly-subscriber movements
# ---------------------------------------------------------------------------
class AuditOut(BaseModel):
    id: int
    ts: datetime
    username: str
    role: Optional[str]
    action: str
    subject: Optional[str]
    details: Optional[str]


class MonthlyEventOut(BaseModel):
    id: int
    subscription_id: int
    direction: str
    ts: datetime
    recorded_by: Optional[str]
    customer_name: str
    plate: str
    space_number: Optional[str]
