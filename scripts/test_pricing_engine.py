"""
Standalone sanity tests for app/pricing_engine.py.
Run with: python scripts/test_pricing_engine.py
No pytest / server / database required.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.pricing_engine import calculate_hourly, calculate_flat, validate_configuration, _time_in_window
from datetime import time

passed = 0
failed = 0


def check(label, actual, expected):
    global passed, failed
    ok = abs(actual - expected) < 0.001
    print(f"[{'PASS' if ok else 'FAIL'}] {label}: got {actual}, expected {expected}")
    if ok:
        passed += 1
    else:
        failed += 1


hourly_started = {
    "first_hour_price": 5000,
    "additional_hour_price": 3000,
    "rounding_method": "per_started_hour",
}
check("per_started_hour, 10 min -> 1 hour", calculate_hourly(hourly_started, 10), 5000)
check("per_started_hour, 60 min -> 1 hour", calculate_hourly(hourly_started, 60), 5000)
check("per_started_hour, 61 min -> 2 hours", calculate_hourly(hourly_started, 61), 8000)
check("per_started_hour, 125 min -> 3 hours", calculate_hourly(hourly_started, 125), 11000)
check("per_started_hour, 0 min -> minimum charge", calculate_hourly(hourly_started, 0), 5000)

hourly_exact = {
    "first_hour_price": 6000,
    "additional_hour_price": 3000,
    "rounding_method": "exact_fraction",
}
check("exact_fraction, 30 min -> half of first hour", calculate_hourly(hourly_exact, 30), 3000)
check("exact_fraction, 60 min -> full first hour", calculate_hourly(hourly_exact, 60), 6000)
check("exact_fraction, 90 min -> first hour + half extra", calculate_hourly(hourly_exact, 90), 7500)

hourly_blocks = {
    "first_hour_price": 4000,
    "additional_hour_price": 2000,
    "rounding_method": "blocks",
    "block_minutes": 30,
}
check("blocks(30), 10 min -> 1 block of first-hour rate", calculate_hourly(hourly_blocks, 10), 2000)
check("blocks(30), 45 min -> 2 blocks -> first block + 1 other", calculate_hourly(hourly_blocks, 45), 3000)
check("blocks(30), 61 min -> 3 blocks", calculate_hourly(hourly_blocks, 61), 4000)

check("flat rate ignores duration (10 min)", calculate_flat({"flat_rate": 25000}, 10), 25000)
check("flat rate ignores duration (500 min)", calculate_flat({"flat_rate": 25000}, 500), 25000)

# validation
assert validate_configuration("HOURLY", {"first_hour_price": 1000, "additional_hour_price": 500}) is None
assert validate_configuration("HOURLY", {"first_hour_price": -1, "additional_hour_price": 500}) is not None
assert validate_configuration("FLAT", {"flat_rate": 1000}) is None
assert validate_configuration("FLAT", {}) is not None
assert validate_configuration("BOGUS", {}) is not None
print("[PASS] validate_configuration edge cases")
passed += 1

# time window matching (schedule resolution building block)
assert _time_in_window(time(10, 0), time(8, 0), time(18, 0)) is True
assert _time_in_window(time(19, 0), time(8, 0), time(18, 0)) is False
assert _time_in_window(time(19, 0), time(18, 0), time(8, 0)) is True   # overnight wrap
assert _time_in_window(time(3, 0), time(18, 0), time(8, 0)) is True    # overnight wrap, past midnight
assert _time_in_window(time(12, 0), time(9, 0), time(9, 0)) is True    # 00:00-like equal window = full day
assert _time_in_window(time(0, 0), time(0, 0), time(0, 0)) is True     # literal 00:00-00:00 = full day
print("[PASS] _time_in_window, including full-day and overnight-wrap cases")
passed += 1

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
