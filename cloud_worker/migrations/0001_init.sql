-- ParkingManager cloud service: schema v1.
-- Times are stored exactly as the parking PC sends them: ISO-8601 text with the
-- lot's UTC offset (e.g. 2026-10-15T14:35:12-05:00), so the date part is always
-- the lot's own calendar day and text order is chronological order.

CREATE TABLE sessions (
  token               TEXT PRIMARY KEY,      -- unguessable; only the customer's own link knows it
  ticket_id           TEXT,
  customer_name       TEXT,
  plate               TEXT,
  phone               TEXT,
  person_type         TEXT NOT NULL DEFAULT 'VISITOR',   -- VISITOR | RESIDENT | SERVICE
  unit                TEXT,                  -- tower / apartment
  visiting            TEXT,                  -- resident being visited
  vehicle             TEXT,
  source              TEXT,                  -- QR | MANUAL
  checked_in_by       TEXT,
  checked_out_by      TEXT,
  space_number        TEXT,
  entry_ts            TEXT,
  exit_ts             TEXT,
  duration_minutes    INTEGER,
  pricing_rule_name   TEXT,
  pricing_type        TEXT,
  pricing_config_json TEXT,
  status              TEXT NOT NULL,         -- PENDING_ASSIGNMENT | OCCUPIED | COMPLETED | CANCELLED
  final_amount        REAL,
  currency            TEXT,
  client_ts           TEXT NOT NULL DEFAULT '',  -- the PC's send time: older updates never overwrite newer ones
  received_at         INTEGER NOT NULL           -- server time (ms)
);
CREATE INDEX idx_sessions_entry  ON sessions(entry_ts);
CREATE INDEX idx_sessions_plate  ON sessions(plate);
CREATE INDEX idx_sessions_status ON sessions(status);

-- Append-only: the PC's audit trail. `uid` makes a retried upload idempotent.
CREATE TABLE audit (
  uid      TEXT PRIMARY KEY,
  ts       TEXT NOT NULL,
  username TEXT NOT NULL,
  role     TEXT,
  action   TEXT NOT NULL,
  subject  TEXT,
  details  TEXT
);
CREATE INDEX idx_audit_ts     ON audit(ts);
CREATE INDEX idx_audit_action ON audit(action);

-- Real entries / exits of monthly subscribers.
CREATE TABLE monthly_events (
  uid             TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  direction       TEXT NOT NULL,              -- IN | OUT
  subscription_id INTEGER,
  customer_name   TEXT,
  plate           TEXT,
  space_number    TEXT,
  recorded_by     TEXT
);
CREATE INDEX idx_monthly_ts ON monthly_events(ts);
CREATE INDEX idx_monthly_subscription ON monthly_events(subscription_id, ts);

-- People who may open the read-only panel. Only a SHA-256 of each access key is
-- stored, never the key itself (it is shown once, when created).
CREATE TABLE viewers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('OWNER', 'VIEWER')),
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

-- Browser sign-ins (cookie holds a random id; only its hash is stored here).
CREATE TABLE web_sessions (
  id_hash    TEXT PRIMARY KEY,
  viewer_id  INTEGER NOT NULL REFERENCES viewers(id),
  expires_at INTEGER NOT NULL                 -- ms
);
CREATE INDEX idx_web_sessions_viewer ON web_sessions(viewer_id);

-- Who opened the panel and when (shown to the owner).
CREATE TABLE viewer_logins (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_id INTEGER NOT NULL REFERENCES viewers(id),
  ts        TEXT NOT NULL,
  ip        TEXT
);

-- Failed-attempt counter per client address, for panel sign-in and first-time setup.
CREATE TABLE login_throttle (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  first_ts     INTEGER NOT NULL,              -- ms
  locked_until INTEGER NOT NULL DEFAULT 0     -- ms
);
