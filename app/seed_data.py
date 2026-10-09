"""
Creates the 20 parking spaces, default settings, default pricing rules and
schedules the FIRST time the app runs (i.e. only if the tables are empty).
Safe to call on every startup -- it is a no-op once seeded.

Run standalone with: python -m app.seed_data
Add demo history for testing with: python -m app.seed_data --demo
"""
import json
import sys
from datetime import datetime, timedelta

from app import config, crud
from app.database import SessionLocal, init_db
from app.models import ParkingSpace, PricingRule, Schedule, Setting, Customer, ParkingSession, User, UserRole
from app.security import hash_pin, DEFAULT_ADMIN_PIN


def seed_core(db):
    # --- 20 parking spaces -------------------------------------------------
    if db.query(ParkingSpace).count() == 0:
        for i in range(1, config.NUM_PARKING_SPACES + 1):
            db.add(ParkingSpace(number=f"P{i:02d}", status="AVAILABLE"))
        print(f"Created {config.NUM_PARKING_SPACES} parking spaces (P01..P{config.NUM_PARKING_SPACES:02d}).")

    # --- settings ------------------------------------------------------------
    if db.query(Setting).filter(Setting.key == "business_name").first() is None:
        db.add(Setting(key="business_name", value="City Center Parking"))
        db.add(Setting(key="currency_code", value="COP"))
        db.add(Setting(key="currency_symbol", value="$"))
        print("Created default settings.")

    # NOTE: this Setting is deliberately NOT created for new installs anymore
    # -- admin_pin_hash was the old single-shared-PIN system from before
    # multi-user accounts existed. It's only read now, as a one-time
    # migration source in seed_default_admin_user() below, for upgrading an
    # install that already had it. Creating a fresh one here would make
    # every new install look like an "upgrade" and print a misleading
    # migration message.

    db.commit()
    seed_default_admin_user(db)

    if db.query(Setting).filter(Setting.key == "cloud_sync_enabled").first() is None:
        db.add(Setting(key="cloud_sync_enabled", value="false"))
        db.add(Setting(key="cloud_sync_url", value=""))
        db.add(Setting(key="cloud_sync_secret", value=""))
        print("Created default cloud backup settings (disabled by default -- see CLOUD_BACKUP.md).")

    if db.query(Setting).filter(Setting.key == "public_access_enabled").first() is None:
        db.add(Setting(key="public_access_enabled", value="false"))
        db.add(Setting(key="public_base_url", value=""))
        print("Created default remote access settings (disabled by default -- see REMOTE_ACCESS.md).")

    if db.query(Setting).filter(Setting.key == "status_page_enabled").first() is None:
        db.add(Setting(key="status_page_enabled", value="false"))
        db.add(Setting(key="status_page_base_url", value=""))
        print("Created default status page settings (disabled by default -- see GITHUB_PAGES_STATUS.md).")

    db.commit()

    # --- pricing rules ---------------------------------------------------
    if db.query(PricingRule).count() == 0:
        hourly = PricingRule(
            name="Standard Hourly",
            type="HOURLY",
            configuration=json.dumps({
                "first_hour_price": 5000,
                "additional_hour_price": 3000,
                "rounding_method": "per_started_hour",
            }),
            is_default=True,
            active=True,
        )
        night_flat = PricingRule(
            name="Night Flat Rate",
            type="FLAT",
            configuration=json.dumps({"flat_rate": 25000}),
            is_default=False,
            active=True,
        )
        db.add_all([hourly, night_flat])
        db.commit()
        print("Created default pricing rules: 'Standard Hourly' (default), 'Night Flat Rate'.")

        # --- schedules -----------------------------------------------------
        db.add(Schedule(
            name="Weekday daytime",
            days_of_week="MON,TUE,WED,THU,FRI",
            start_time="08:00",
            end_time="18:00",
            pricing_rule_id=hourly.id,
            priority=10,
            active=True,
        ))
        db.add(Schedule(
            name="Weekday nighttime",
            days_of_week="MON,TUE,WED,THU,FRI",
            start_time="18:00",
            end_time="08:00",
            pricing_rule_id=night_flat.id,
            priority=20,
            active=True,
        ))
        db.add(Schedule(
            name="Weekend, all day",
            days_of_week="SAT,SUN",
            start_time="00:00",
            end_time="00:00",  # 00:00-00:00 == full 24h wraparound window
            pricing_rule_id=night_flat.id,
            priority=30,
            active=True,
        ))
        db.commit()
        print("Created default schedules (weekday 08-18 hourly, weekday 18-08 + weekends flat).")


def seed_default_admin_user(db):
    """Creates the first admin account, the FIRST time the app runs. If this
    install already had the old single-shared-PIN system (from before
    multi-user accounts existed), the new "admin" user account is created
    using that SAME PIN hash directly -- so upgrading never locks anyone
    out or silently resets a PIN someone already chose. Otherwise, a brand
    new install gets a fresh default admin account."""
    if db.query(User).count() > 0:
        return
    legacy_hash = db.query(Setting).filter(Setting.key == "admin_pin_hash").first()
    if legacy_hash and legacy_hash.value:
        db.add(User(username="admin", display_name="Administrator", pin_hash=legacy_hash.value,
                     role=UserRole.ADMIN.value, active=True))
        db.commit()
        print("Migrated existing admin PIN into a new 'admin' user account (same PIN as before).")
    else:
        db.add(User(username="admin", display_name="Administrator", pin_hash=hash_pin(DEFAULT_ADMIN_PIN),
                     role=UserRole.ADMIN.value, active=True))
        db.commit()
        print(f"Created default admin account -- username 'admin', PIN {DEFAULT_ADMIN_PIN}. "
              f"Change this in Settings after first login.")


def seed_demo_history(db, count: int = 12):
    """Adds completed sessions in the past for exercising History/Revenue."""
    import random
    hourly = db.query(PricingRule).filter(PricingRule.name == "Standard Hourly").first()
    names = ["John Smith", "Maria Garcia", "Carlos Ruiz", "Ana Torres", "Luis Gomez",
             "Sofia Ramirez", "Diego Castro", "Laura Diaz"]
    now = datetime.now()
    for i in range(count):
        entry = now - timedelta(days=random.randint(0, 6), hours=random.randint(0, 20))
        duration = random.randint(15, 300)
        exit_time = entry + timedelta(minutes=duration)
        plate = f"DEM{100+i}"
        customer = crud.get_or_create_customer(db, random.choice(names), plate, None)
        from app import pricing_engine
        minutes, amount = pricing_engine.price_session(entry, exit_time, "HOURLY", hourly.configuration)
        db.add(ParkingSession(
            customer_id=customer.id,
            space_id=None,
            entry_timestamp=entry,
            exit_timestamp=exit_time,
            pricing_rule_id=hourly.id,
            pricing_rule_name=hourly.name,
            pricing_type="HOURLY",
            pricing_config_snapshot=hourly.configuration,
            duration_minutes=minutes,
            final_amount=amount,
            status="COMPLETED",
        ))
    db.commit()
    print(f"Added {count} demo completed sessions for testing History/Revenue.")


if __name__ == "__main__":
    init_db()
    db = SessionLocal()
    try:
        seed_core(db)
        if "--demo" in sys.argv:
            seed_demo_history(db)
    finally:
        db.close()
    print(f"Database ready at: {config.DATABASE_PATH}")
