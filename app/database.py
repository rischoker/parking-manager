from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base

from app import config

# check_same_thread=False: uvicorn serves requests from a threadpool; SQLite
# connections are otherwise pinned to one thread. We still avoid concurrency
# bugs by keeping one connection per request via the get_db dependency below,
# and SQLite's own file-level locking protects the data on disk.
engine = create_engine(
    config.DATABASE_URL,
    connect_args={"check_same_thread": False},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, _record):
    cursor = dbapi_connection.cursor()
    # WAL mode lets the admin desktop reads and a customer's phone request
    # happen concurrently without locking errors.
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401  (ensure models are registered)
    Base.metadata.create_all(bind=engine)
    _run_light_migrations()


def _run_light_migrations():
    """create_all() only creates tables that don't exist yet -- it never
    adds columns to a table that's already there. For a single-file desktop
    app with no formal migration framework, a tiny ad-hoc check like this
    is enough to let people upgrade an existing installation (an existing
    parking.db from before a given feature was added) without losing data.
    Safe to call on every startup: each check is a no-op once the column
    exists."""
    import json

    with engine.connect() as conn:
        existing_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(parking_sessions)")}
        if "synced_to_cloud" not in existing_cols:
            conn.exec_driver_sql(
                "ALTER TABLE parking_sessions ADD COLUMN synced_to_cloud BOOLEAN DEFAULT 0"
            )
            conn.commit()

        if "pricing_type" not in existing_cols:
            conn.exec_driver_sql("ALTER TABLE parking_sessions ADD COLUMN pricing_type VARCHAR(16)")
            conn.commit()

        # v1.2: access-log columns. Existing rows become VISITOR / QR, which
        # is exactly how they were created before these fields existed.
        for column, ddl in (
            ("cloud_hash", "VARCHAR(64)"),
            ("person_type", "VARCHAR(16) NOT NULL DEFAULT 'VISITOR'"),
            ("unit", "VARCHAR(40)"),
            ("visiting", "VARCHAR(120)"),
            ("vehicle_desc", "VARCHAR(80)"),
            ("source", "VARCHAR(8) NOT NULL DEFAULT 'QR'"),
            ("checked_in_by", "VARCHAR(40)"),
            ("checked_out_by", "VARCHAR(40)"),
        ):
            if column not in existing_cols:
                conn.exec_driver_sql(f"ALTER TABLE parking_sessions ADD COLUMN {column} {ddl}")
                conn.commit()

        # Backfill: derive the type from the shape of each session's own
        # frozen configuration (the snapshot is the ground truth for what was
        # in force; the live rule may have been edited since).
        rows = conn.exec_driver_sql(
            "SELECT id, pricing_config_snapshot FROM parking_sessions WHERE pricing_type IS NULL"
        ).fetchall()
        for session_id, snapshot in rows:
            try:
                config = json.loads(snapshot or "{}")
            except (TypeError, ValueError):
                config = {}
            ptype = "FLAT" if "flat_rate" in config else "HOURLY"
            conn.exec_driver_sql(
                "UPDATE parking_sessions SET pricing_type = ? WHERE id = ?", (ptype, session_id)
            )
        if rows:
            conn.commit()
