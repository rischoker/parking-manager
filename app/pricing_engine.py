"""
Authoritative pricing engine.

This module is the ONLY place parking charges are computed. Both the
customer-facing "current estimate" endpoint and the administrator's
"register exit" endpoint call the exact same functions here, so the
estimate a customer sees on their phone and the final charge the admin
sees on exit are always produced by identical logic (only the timestamp
used -- "now" vs. the real exit time -- differs).

--------------------------------------------------------------------------
Rule resolution
--------------------------------------------------------------------------
Which PricingRule applies to a session is decided by the day-of-week and
time-of-day of the vehicle's ENTRY (see resolve_pricing_rule). This mirrors
how the pricing rule is snapshotted onto the session at registration time
(see crud.create_session): the rate that was in effect when the customer
arrived is the rate that governs their whole stay, even if their stay
crosses into a different scheduled window before they leave. This is a
deliberate, documented simplification -- the alternative (splitting a
single stay's duration across multiple schedule windows and charging each
segment separately) is a legitimate future enhancement and the schema
already supports it (each Schedule row is independent and modular), but it
is not implemented in this version.

--------------------------------------------------------------------------
Pricing rule configuration shapes (JSON stored in PricingRule.configuration)
--------------------------------------------------------------------------
HOURLY:
{
  "first_hour_price": 5000,
  "additional_hour_price": 3000,
  "rounding_method": "per_started_hour" | "exact_fraction" | "blocks",
  "block_minutes": 30            # only read when rounding_method == "blocks"
}

FLAT:
{
  "flat_rate": 25000
}

--------------------------------------------------------------------------
Extending the engine
--------------------------------------------------------------------------
To add a new pricing TYPE (e.g. "DAILY_CAP", "EARLY_BIRD"), write a
`calculate_<name>(config, minutes)` function below and register it in
PRICING_STRATEGIES. Nothing else needs to change: the rest of the app
(session creation, exit registration, the customer estimate endpoint,
history/reports) is written against PricingType generically.
"""
import json
import math
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session as DBSession

from app.models import PricingRule, Schedule

WEEKDAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]


class PricingError(Exception):
    pass


# ---------------------------------------------------------------------------
# Rule resolution (which rule applies right now?)
# ---------------------------------------------------------------------------
def _time_in_window(check: "datetime.time", start: "datetime.time", end: "datetime.time") -> bool:
    """True if `check` falls in [start, end). Handles windows that wrap past
    midnight, e.g. start=18:00, end=08:00 covers 18:00..23:59 and 00:00..07:59.
    A window where start == end (e.g. "00:00" to "00:00") is the convention
    for "all 24 hours" rather than a zero-length window."""
    if start == end:
        return True
    if start < end:
        return start <= check < end
    return check >= start or check < end


def _parse_hhmm(value: str):
    h, m = value.split(":")
    return datetime.min.time().replace(hour=int(h), minute=int(m))


def resolve_pricing_rule(db: DBSession, at: datetime) -> PricingRule:
    """Pick the PricingRule that applies at the given datetime, by matching
    active Schedule rows (lowest `priority` number wins among matches),
    falling back to the PricingRule flagged is_default, falling back to the
    first active rule so the system never fails to price a session."""
    weekday_code = WEEKDAY_CODES[at.weekday()]
    check_time = at.time()

    schedules = (
        db.query(Schedule)
        .filter(Schedule.active.is_(True))
        .order_by(Schedule.priority.asc())
        .all()
    )
    for sched in schedules:
        days = [d.strip().upper() for d in sched.days_of_week.split(",")]
        if "ALL" not in days and weekday_code not in days:
            continue
        start = _parse_hhmm(sched.start_time)
        end = _parse_hhmm(sched.end_time)
        if _time_in_window(check_time, start, end):
            rule = db.query(PricingRule).filter(
                PricingRule.id == sched.pricing_rule_id, PricingRule.active.is_(True)
            ).first()
            if rule:
                return rule

    default_rule = (
        db.query(PricingRule)
        .filter(PricingRule.is_default.is_(True), PricingRule.active.is_(True))
        .first()
    )
    if default_rule:
        return default_rule

    fallback = db.query(PricingRule).filter(PricingRule.active.is_(True)).first()
    if fallback:
        return fallback

    raise PricingError(
        "No active pricing rule is configured. Go to Administration -> Pricing "
        "and create at least one rule."
    )


# ---------------------------------------------------------------------------
# Charge calculation strategies
# ---------------------------------------------------------------------------
def calculate_hourly(config: dict, minutes: float) -> float:
    first_hour = float(config["first_hour_price"])
    additional_hour = float(config.get("additional_hour_price", first_hour))
    method = config.get("rounding_method", "per_started_hour")
    minutes = max(minutes, 0.0)

    if minutes == 0:
        # A session that hasn't accrued any time yet (e.g. estimate requested
        # the instant a space is assigned) is shown as the minimum charge.
        return round(first_hour, 2)

    if method == "exact_fraction":
        if minutes <= 60:
            return round(first_hour * (minutes / 60.0), 2)
        return round(first_hour + additional_hour * ((minutes - 60) / 60.0), 2)

    if method == "blocks":
        block_minutes = int(config.get("block_minutes", 30))
        if block_minutes <= 0:
            block_minutes = 30
        total_blocks = max(1, math.ceil(minutes / block_minutes))
        first_block_price = first_hour * (block_minutes / 60.0)
        other_block_price = additional_hour * (block_minutes / 60.0)
        return round(first_block_price + max(0, total_blocks - 1) * other_block_price, 2)

    # default: "per_started_hour" -- every started hour is billed in full
    hours = max(1, math.ceil(minutes / 60.0))
    return round(first_hour + max(0, hours - 1) * additional_hour, 2)


def calculate_flat(config: dict, minutes: float) -> float:
    return round(float(config["flat_rate"]), 2)


PRICING_STRATEGIES = {
    "HOURLY": calculate_hourly,
    "FLAT": calculate_flat,
}


def calculate_charge_from_snapshot(pricing_type: str, config_json: str, minutes: float) -> float:
    strategy = PRICING_STRATEGIES.get(pricing_type)
    if not strategy:
        raise PricingError(f"Unknown pricing type '{pricing_type}'")
    config = json.loads(config_json)
    return strategy(config, minutes)


def compute_duration_minutes(entry: datetime, exit_or_now: datetime) -> float:
    delta = exit_or_now - entry
    return max(delta.total_seconds() / 60.0, 0.0)


def price_session(entry: datetime, reference_end: datetime, pricing_type: str, config_json: str):
    """Returns (duration_minutes, amount) for a session using its *snapshotted*
    pricing rule. `reference_end` is either the real exit timestamp (final
    charge) or datetime.now() (live customer estimate) -- same function,
    same math, no duplicated logic between the two call sites."""
    minutes = compute_duration_minutes(entry, reference_end)
    amount = calculate_charge_from_snapshot(pricing_type, config_json, minutes)
    return minutes, amount


def validate_configuration(pricing_type: str, config: dict) -> Optional[str]:
    """Returns an error message string if invalid, else None."""
    if pricing_type == "HOURLY":
        for field in ("first_hour_price", "additional_hour_price"):
            if field not in config:
                return f"Missing '{field}' for an HOURLY rule."
            try:
                if float(config[field]) < 0:
                    return f"'{field}' cannot be negative."
            except (TypeError, ValueError):
                return f"'{field}' must be a number."
        method = config.get("rounding_method", "per_started_hour")
        if method not in ("per_started_hour", "exact_fraction", "blocks"):
            return "rounding_method must be one of: per_started_hour, exact_fraction, blocks."
        if method == "blocks":
            try:
                if int(config.get("block_minutes", 30)) <= 0:
                    return "block_minutes must be a positive integer."
            except (TypeError, ValueError):
                return "block_minutes must be a positive integer."
    elif pricing_type == "FLAT":
        if "flat_rate" not in config:
            return "Missing 'flat_rate' for a FLAT rule."
        try:
            if float(config["flat_rate"]) < 0:
                return "'flat_rate' cannot be negative."
        except (TypeError, ValueError):
            return "'flat_rate' must be a number."
    else:
        return f"Unknown pricing type '{pricing_type}'. Must be HOURLY or FLAT."
    return None
