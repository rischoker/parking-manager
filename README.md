# ParkingManager

A complete, working parking-lot management system for a 20-space lot:
local SQLite database, QR-based customer self-registration, live billing,
a configurable pricing engine (nothing hard-coded), full history/search,
a revenue dashboard, CSV/Excel export, and Windows desktop packaging.

This was built and tested end-to-end (real HTTP requests against a running
server -- registration, assignment, exit, pricing across different
schedules, history, revenue, exports, PIN auth, restart-survival after a
simulated crash) before being handed to you. The one thing that could
**not** be done in the build environment is producing the actual Windows
`.exe` -- that step needs a real Windows machine and takes about five
minutes. See **BUILD_WINDOWS.md** for that.

**Since the initial build:** fixed a timestamp display bug (entry/exit
times now correctly match the system clock -- see the Testing checklist
below for how this was caught and verified), added an optional free cloud
backup to Google Sheets (section I, CLOUD_BACKUP.md), made the entire
interface bilingual -- Spanish and English, Spanish by default, with a
one-click toggle (section J) -- added optional remote access so the
QR/customer pages can work from outside the local Wi-Fi (section K,
REMOTE_ACCESS.md), with a security fix to make sure that never exposes
the admin dashboard, added a free, no-domain-needed alternative for
just checking status remotely, built on GitHub Pages + the same Google
Sheet (section L, GITHUB_PAGES_STATUS.md), and added multi-user accounts
with an Admin/Vigilante role system plus a full monthly-fees
("mensualidades") feature for fixed reserved spaces (sections M and N).

**v1.1 (project review):** a full code review with every finding
reproduced against a running server before being fixed -- see
**CHANGELOG.md** for the list (most importantly: the packaged `.exe` could
not have started, editing a rate's type while a car was parked broke the
dashboard, and customer names could become spreadsheet formulas in the
exports). The fixes are covered by an automated test suite (`python -m
pytest`, section "Automated tests"). A Google Form + Google Sheet for
customer registration is described in **FORMULARIO_GOOGLE.md**, and putting
the project on GitHub (including building the `.exe` there) in **GITHUB.md**.

**v1.2 (access log + cloud panel):** the gate now keeps a complete record of
who comes in -- the attendant can register a vehicle by hand (resident /
visitor / service, tower and apartment, whom they visit, vehicle), monthly
subscribers' real entries and exits are logged, and an append-only audit log
records who did what. All of it can be mirrored to a free Cloudflare service
(`cloud_worker/`, guide in **cloud_worker/DEPLOY.md**) that gives the owner and the
complex administration a read-only panel with one access key per person, and
gives customers a "check my fare" page that works away from your Wi-Fi.
See section O and **CHANGELOG.md**.

---

## A. Architecture

```
                    +------------------------------------------------+
                    |         Desktop machine (the parking booth)     |
                    |                                                  |
                    |  ParkingManager.exe                              |
                    |   |-- background thread: Uvicorn/FastAPI server  |
                    |   |     bound to 0.0.0.0:8000                    |
                    |   |-- native window (pywebview + WebView2)       |
                    |         showing http://127.0.0.1:8000/admin      |
                    |                                                  |
                    |  SQLite DB at %APPDATA%\ParkingManager\          |
                    +------------------------------------------------+
                                  |
                                  |  same Wi-Fi network
                                  |
                    +--------------------------+
                    |   Customer's phone        |
                    |  scans QR -> opens         |
                    |  http://<lan-ip>:8000/     |
                    |     mobile/register        |
                    +--------------------------+
```

One process, one server, two audiences. The **same** FastAPI app serves
both the admin dashboard (only reachable from the desktop machine itself)
and the customer pages (reachable from any phone on the local Wi-Fi). See
section F for exactly how that separation is enforced.

## B. Technology choice

- **FastAPI + Uvicorn** -- the HTTP server and API layer. Async, fast,
  automatic request validation via Pydantic, and it's the same server
  that answers both the admin UI and the customer pages, so there is
  exactly one pricing engine, one database, one source of truth (no
  separate "backend for admin" vs "backend for customers" to keep in
  sync).
- **SQLite via SQLAlchemy** -- zero setup, single file, ACID, WAL mode
  enabled so the admin dashboard and a customer's phone request don't
  block each other. More than enough for a 20-space lot; the ORM layer
  means swapping to Postgres later (multi-location deployment) is a
  connection-string change, not a rewrite.
- **Vanilla HTML/CSS/JS, no framework, no CDN** -- the admin dashboard and
  mobile pages are plain JS with `fetch()`. No build step, no bundler, no
  internet dependency at runtime (important: the booth may not have
  internet, and shouldn't need it for something as basic as rendering a
  dashboard). Keeps the packaged app small and fast to start.
- **pywebview** -- wraps the local web UI in a native window using the
  OS's own browser engine (WebView2 on Windows). This is *why* the
  "desktop app" is really a local website shown in a window: it gets you
  a real, professional-looking Windows app without an Electron-sized
  (100MB+) download, and without writing the whole UI twice in a native
  toolkit.
- **PyInstaller** -- packages Python + the app into a self-contained
  Windows folder so the end user never installs Python.

## C. Folder structure

(v1.2 adds `cloud_worker/` -- the Cloudflare service, see section O -- and
`tests/ui/` -- jsdom smoke tests of the screens.)

```
parking-manager/
├── app/                      # backend
│   ├── main.py                # FastAPI app, middleware, static mounts
│   ├── config.py               # paths, ports, local-time policy
│   ├── database.py             # SQLAlchemy engine/session
│   ├── models.py                # ORM models (see section D)
│   ├── schemas.py                # Pydantic request/response shapes
│   ├── pricing_engine.py          # the ONE authoritative pricing engine
│   ├── crud.py                     # business logic / DB operations
│   ├── security.py                  # PIN auth + local-only admin gate
│   ├── qr_utils.py                   # QR generation, LAN IP discovery
│   ├── cloud_sync.py                  # optional free cloud backup (see CLOUD_BACKUP.md)
│   ├── seed_data.py                   # first-run defaults + demo data
│   └── routers/
│       ├── admin.py                    # desktop-only API
│       └── customer.py                  # public, QR-facing API
├── desktop_ui/                # admin dashboard (served to the pywebview window)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── i18n.js             # Spanish/English dictionary + language toggle
│       └── app.js
├── mobile_ui/                 # customer-facing pages (served to phones)
│   ├── register.html
│   ├── session.html
│   ├── css/mobile.css
│   └── js/
│       ├── i18n.js             # Spanish/English dictionary + language toggle
│       └── mobile.js
├── cloud_sync/
│   ├── AppsScript.gs            # paste into Google Sheets -- see CLOUD_BACKUP.md
│   └── CreateGoogleForm.gs      # creates the Google Form + answers Sheet -- see FORMULARIO_GOOGLE.md
├── github_pages/               # optional: free "check status anywhere" page
│   ├── index.html                # see GITHUB_PAGES_STATUS.md
│   ├── css/style.css
│   └── js/
│       ├── i18n.js                # Spanish/English, same pattern as mobile_ui
│       ├── pricing_engine.js       # exact JS port of app/pricing_engine.py
│       └── status.js                # reads Google Sheets directly, no backend
├── scripts/
│   ├── test_pricing_engine.py  # standalone pricing-math tests (no server needed)
│   └── make_qr.py               # turn any URL (e.g. the Google Form link) into a printable QR PNG
├── tests/                       # automated tests: python -m pytest (see "Automated tests")
├── .github/workflows/           # GitHub Actions: run tests, build ParkingManager.exe (see GITHUB.md)
├── desktop_app.py              # the PyInstaller entry point
├── ParkingManager.spec          # PyInstaller build config
├── requirements.txt
├── requirements-dev.txt          # + pytest, for the test suite
├── setup_windows.bat             # first-time setup
├── run_dev.bat                    # run from source, no build needed
├── build_windows.bat                # produces ParkingManager.exe
├── BUILD_WINDOWS.md                  # detailed packaging guide
├── CLOUD_BACKUP.md                    # optional free cloud backup setup
├── REMOTE_ACCESS.md                    # optional: QR works outside local Wi-Fi
├── GITHUB_PAGES_STATUS.md               # optional: free anywhere-checking page
├── FORMULARIO_GOOGLE.md                  # optional: Google Form + Sheet for registration (Spanish)
├── GITHUB.md                              # putting the project on GitHub / CI builds (Spanish)
├── CHANGELOG.md                            # what changed in v1.1 and why
└── README.md                          # this file
```

## D. Database schema

SQLite, via SQLAlchemy models in `app/models.py`:

| Table              | Purpose                                                                 |
|---------------------|--------------------------------------------------------------------------|
| `parking_spaces`    | The 20 fixed spaces, P01..P20, each AVAILABLE or OCCUPIED.               |
| `customers`         | Reused across visits, keyed loosely by plate.                             |
| `parking_sessions`  | One row per visit: entry/exit timestamps, assigned space, status, and a **snapshot** of the pricing rule that applied (see below). |
| `pricing_rules`     | Named rules: HOURLY (with a rounding method) or FLAT. Never hard-coded.    |
| `schedules`         | Maps days-of-week + time windows to a pricing rule.                        |
| `settings`          | Business name, currency, admin PIN hash -- simple key/value.               |

**Why sessions store a pricing *snapshot*, not just a foreign key:** if the
attendant edits "Standard Hourly" from $5,000 to $6,000 next month, every
*already-completed* session must keep showing the price the customer
actually paid. So `parking_sessions.pricing_config_snapshot` is a frozen
copy of the rule's configuration, taken the moment the vehicle registered.
History and revenue reports are therefore always historically accurate,
even after pricing changes.

## E. Pricing-engine design

Everything lives in `app/pricing_engine.py`, and it is the **only** place
a charge is computed -- both the customer's live estimate and the admin's
final exit charge call the exact same function
(`price_session(entry, reference_end, pricing_type, config)`), just with a
different `reference_end` (`datetime.now()` for a live estimate, the real
exit timestamp for the final charge). There is no second copy of the math
in the frontend.

**Rule resolution:** `resolve_pricing_rule(db, at)` checks each active
`Schedule` (lowest `priority` number first) for one whose days-of-week and
time window contain `at`, and uses that schedule's pricing rule. If
nothing matches, it falls back to whichever rule is flagged
`is_default`. The rule that applies is decided by the vehicle's **entry**
time and stays fixed for that whole visit (see the docstring in
`pricing_engine.py` for the reasoning and the documented alternative of
splitting a stay across multiple rate windows, which the schema supports
but this version doesn't implement).

**HOURLY rounding methods** (configurable per rule):
- `per_started_hour` -- every started hour billed in full (classic "any
  minute into the 2nd hour, you pay for 2 hours").
- `exact_fraction` -- prorated continuously by the minute.
- `blocks` -- billed in fixed blocks (e.g. every 15 or 30 minutes),
  configurable block size.

**FLAT** -- a fixed rate regardless of duration (e.g. an overnight or
full-day rate).

**Extending it:** to add a new pricing type later (a daily cap, an
early-bird special, whatever), write one function and register it in the
`PRICING_STRATEGIES` dict at the top of the module. Nothing else in the
app needs to change -- session creation, exit registration, the customer
estimate endpoint, and reports are all written against the type generically.

## F. QR / mobile architecture

The QR code (Administration -> QR in the dashboard) encodes
`http://<this-machine's-LAN-IP>:8000/mobile/register` -- discovered
automatically at runtime (`app/qr_utils.py`), so it keeps working if the
booth PC's IP changes (just hit Refresh on the QR page).

**No cloud, no internet, no hosting cost.** The desktop app's own local
server answers both the admin dashboard and the customer pages; a phone on
the same Wi-Fi reaches it directly over the LAN. If the booth PC and phones
are on the same network, this works with zero additional infrastructure.
(The only external dependency in the whole app is the one-time `pip
install` on the build machine -- nothing at runtime.)

**How admin/customer separation is enforced** (see `app/security.py` and
`LocalOnlyMiddleware` in `app/main.py`): the server has to bind `0.0.0.0`
so phones can reach it, which would normally also expose admin routes to
the network. Instead, every request to an `/api/admin/*` or `/admin` path
is checked against the actual TCP client address; anything not originating
from the machine itself gets a 403, regardless of what URL it hits. Admin
routes additionally require a PIN-derived session token on top of that.
Customer routes are public by design but scoped to a single unguessable
session token per visit (see `app/routers/customer.py`) -- there is no way
to list, browse, or reach another customer's session from there.

## G. Entry / exit workflow

1. Customer scans the QR -> fills in name, plate, optional phone -> submits.
   The **server** stamps the entry time; the form has no field for it (see
   `CustomerRegisterRequest` in `app/schemas.py` -- entry time, space,
   pricing and charge simply aren't inputs a customer can send).
2. The session is created with status `PENDING_ASSIGNMENT`, and the
   pricing rule in effect *right now* is resolved and snapshotted onto it.
3. The customer is redirected to their own live session page, which polls
   every 15 seconds and shows their estimated running charge.
4. The attendant sees the new registration under "Awaiting space
   assignment" on the dashboard and assigns an available space -- status
   becomes `OCCUPIED`.
5. When the vehicle leaves, the attendant clicks **Register exit** on that
   space's card. The server stamps the exit time, computes the final
   charge via the same pricing engine, marks the session `COMPLETED`, and
   frees the space. The customer's page (and the admin history) both show
   the same final number, computed once, in one place.

## H. Windows packaging strategy

See **BUILD_WINDOWS.md** for the full walkthrough. Short version:
`desktop_app.py` starts the server in a background thread and opens the
admin dashboard in a native window via `pywebview`; PyInstaller (driven by
`ParkingManager.spec`) bundles the Python runtime, dependencies, and the
`desktop_ui/` / `mobile_ui/` static files into a `dist/ParkingManager/`
folder containing `ParkingManager.exe`. It's a "onedir" build (not a
single self-extracting file) because that starts faster and is far less
likely to trigger antivirus false positives.

## I. Cloud backup (optional, free)

Off by default. When enabled (Settings -> Cloud Backup), every completed
session is pushed in the background to a URL you configure -- by default,
a free Google Sheet reached through a small Google Apps Script endpoint.
This is purely a backup/off-site copy: the app works fully offline either
way, exits always register instantly regardless of internet, and nothing
is ever lost if the connection is briefly down -- a background loop
retries anything not yet confirmed synced every 30 seconds. Full setup
(about 5 minutes, no coding) is in **CLOUD_BACKUP.md**, including why
Google Sheets was chosen over a couple of other free options that were
compared first, and how to point it at a different destination instead if
you'd rather use something else later.

## J. Language support

The whole interface -- admin dashboard and the customer-facing mobile
pages -- is bilingual, Spanish and English, with Spanish as the default
and a one-click toggle (top of the login screen and sidebar in the admin
console; top of the page on mobile) that switches instantly, no reload.
The choice is remembered per device/browser. This covers all UI chrome:
navigation, labels, buttons, table headers, status text, toasts, and the
most common error messages coming back from the server (duplicate plate,
space unavailable, session not found, and similar). See `desktop_ui/js/i18n.js`
and `mobile_ui/js/i18n.js` for the dictionaries -- adding a third language
later means adding one more object to each, not restructuring anything.

## K. Remote access (optional, free)

Off by default -- the QR/customer pages work over local Wi-Fi out of the
box, no setup needed. Turn this on (Settings -> Remote Access) only if
customers need to check their status from outside the lot's Wi-Fi, or if
your router's "client isolation" setting is blocking local phone-to-PC
traffic (a common gotcha on guest/business networks). It's built on
**Cloudflare Tunnel** (free), which exposes only the customer-facing
pages -- never the admin dashboard, enforced by two independent
mechanisms (see `is_local_request()` in `app/main.py` and the tunnel's
own ingress rules) so a misconfiguration in one doesn't expose anything.
Full setup, the honest cost picture (the tunnel is free; a permanently
stable URL needs a small yearly domain fee), and a free-but-more-fragile
alternative are all in **REMOTE_ACCESS.md**.

## L. GitHub Pages status page (optional, free, no domain)

A lighter-weight alternative to section K for one specific need: letting
a customer who already registered on-site keep checking their fare after
they've left your Wi-Fi range, at zero cost and with **no exposure of
your local server to the internet at all** (unlike Remote Access, which
does expose the customer-facing routes). It piggybacks on Cloud Backup:
ParkingManager pushes each session's live state to the same Google Sheet
as it progresses, keyed by session token so the same row updates rather
than a new one being appended each time; a small static page (no backend
of its own) hosted for free on GitHub Pages reads that row and computes
the fare in the customer's own browser -- verified to produce byte-for-byte
identical numbers to the real backend (`github_pages/js/pricing_engine.js`
is a direct port of `app/pricing_engine.py`, tested against the same
cases). It does **not** cover remote registration -- only checking status
after the fact. Full setup in **GITHUB_PAGES_STATUS.md**.

## M. Roles: Admin and Vigilante (Attendant)

Every login now belongs to a named account with a role, not one shared
PIN. **ADMIN** accounts can do everything. **ATTENDANT** accounts
("Vigilante" in the Spanish UI) are scoped to day-to-day operations:
assigning spaces, registering exits, cancelling sessions, viewing the
dashboard/active-parking list and QR code, logging a monthly-fee payment,
and marking a monthly space as parked/not-parked. They're blocked from
pricing, schedules, business/cloud/remote-access settings, revenue
reports, history/exports, creating or editing monthly subscriptions, and
managing other accounts.

This is enforced with two dependencies in `app/routers/admin.py`:
`require_admin` (any logged-in user) and `require_full_admin` (ADMIN
role only), applied route-by-route -- checked server-side on every
request, not just hidden in the UI, since a restricted account could
otherwise call the API directly. Verified directly: logged in as an
attendant account and confirmed each of the ~10 admin-only endpoints
returns 403, while every operational endpoint (assign, exit, cancel,
dashboard, QR, monthly-fee payment logging) works normally.

Manage accounts under **Users** (admin-only) -- create an attendant
account, reset a forgotten PIN (immediately invalidates their current
session), or deactivate one. Anyone can change their own PIN under
Settings -> My Account regardless of role. The system refuses to demote
or deactivate the last remaining admin account, so you can't accidentally
lock yourself out. Existing installations upgrade seamlessly: if you
already had a PIN set under the old single-shared-PIN system, it's
carried over automatically into a new "admin" account with that same PIN
-- nobody has to reset anything or gets locked out.

## N. Monthly fees ("Mensualidades")

For spaces rented by the same person every month at a flat fee instead of
the normal per-visit hourly/flat pricing. Deliberately **not** built on
top of the timed session system -- a monthly renter doesn't get an
entry/exit/duration/pricing-rule calculated for them at all, since none
of that applies to a flat recurring fee. What it does instead:

- Reserving a space for a subscription immediately removes that space
  from the walk-in/QR assignment pool -- enforced in
  `crud.available_spaces()` **and independently again** in
  `crud.assign_space()`, the latter added specifically because a
  reserved space's underlying `AVAILABLE`/`OCCUPIED` status is unchanged
  by the reservation (only the subscription record tracks it), so the
  normal assignment path needed its own explicit check too. Caught this
  gap with a real test (tried assigning a walk-in straight to a reserved
  space) before it shipped.
- A simple payment ledger (`monthly_payments`) tracks who's paid for the
  current period and who's overdue, with the next-due date advanced by
  exactly one calendar month (day-of-month-overflow-aware, e.g. Jan 31 ->
  Feb 28) each time a payment is logged.
- `currently_parked` is a purely informational toggle -- shown on the
  dashboard so you can see at a glance whether a reserved space's car is
  actually there right now, but it never affects billing.
- Folded into the Revenue dashboard as its own line alongside hourly/flat
  walk-in revenue, so the total reflects the whole business, not just
  pay-per-visit traffic.
- An ADMIN creates, edits, or cancels a subscription (same bucket as
  pricing -- it's a business/financial decision); an ATTENDANT can log a
  payment or toggle parked/not-parked, since that's what happens at the
  booth when a monthly renter shows up to pay or park.

---

## O. Access log, audit trail and cloud panel (v1.2)

**On the PC (always works, no internet needed)**

- *Registrar ingreso* (dashboard button, any role): the attendant registers a
  vehicle at the gate -- name, plate, type (visitor / resident / service),
  tower-apartment, whom they visit, vehicle, optional space. The QR form
  collects the same optional fields. Everything is stored on the session and
  filterable / exportable in History.
- *Mensualidades -> Movimientos:* marking a subscriber IN or OUT now leaves a
  timestamped row with the attendant's username (a double click creates no
  extra row; a cancelled subscription cannot "enter").
- *Bitacora* (admin only): append-only `audit_log` of staff actions (check-ins,
  space assignments, exits, cancellations, payments, rates, schedules, users,
  settings, sign-ins and failed sign-ins). The action and its audit row are
  saved in the same transaction; PINs and secrets are never written to it.

**In the cloud (optional, free)** -- `cloud_worker/` is a Cloudflare Worker + D1
database. The PC pushes records in the background (`app/cloud_sync.py`,
protocol v2: `session`, `audit`, `monthly_event`, `ping`): a record is sent
only when it is new or changed, retries are idempotent (stable `uid` /
token), and a new destination URL re-sends the whole history. The Worker
serves (1) the customer's fare page (reusing `github_pages/`), and (2) the
read-only owner / administration panel at `/monitor/` (access keys stored
only as hashes, hardened cookie, throttled sign-in, CSV export). The Google
Sheet backup keeps working and simply ignores the new record kinds.

Setup: **cloud_worker/DEPLOY.md** (about 30 minutes, once).

## Setup instructions

### On Windows (the real target)

```
setup_windows.bat      REM one-time: creates venv, installs deps, inits DB
run_dev.bat             REM try it immediately, no build needed
build_windows.bat        REM produces dist\ParkingManager\ParkingManager.exe
```

Full detail, troubleshooting, and what to expect on first launch (firewall
prompt, SmartScreen warning, where data is stored) are in
**BUILD_WINDOWS.md**.

### On macOS/Linux (for development/testing only -- not the deployment target)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.seed_data --demo      # --demo adds sample history for testing
python desktop_app.py                # needs a system webview backend (see below)
```

`pywebview` needs a native webview backend to open an actual window: on
Linux that's WebKitGTK (`sudo apt install gir1.2-webkit2-4.1` on
Debian/Ubuntu, package name varies by distro), on macOS it uses the
built-in Cocoa WebView with no extra install. If you just want to test the
API/UI in an ordinary browser without a native window, skip
`desktop_app.py` and instead run the server directly, then open
`http://127.0.0.1:8000/admin` yourself:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

(Note: use `--host 127.0.0.1` for that kind of manual local testing. The
real app binds `0.0.0.0` -- see `app/config.py` -- specifically so phones
on the Wi-Fi can reach the customer pages; that's what `desktop_app.py`
does automatically.)

## Database initialization & test data

`python -m app.seed_data` runs automatically on every app startup
(`app/main.py`'s startup hook) and is idempotent -- it only creates the 20
spaces / default settings / default pricing / default schedules the first
time, and does nothing on subsequent launches.

Add sample completed sessions for testing History and Revenue:

```
python -m app.seed_data --demo
```

Default pricing seeded out of the box:

| Rule              | Type   | Applies                          | Rate                                    |
|--------------------|--------|-----------------------------------|-------------------------------------------|
| Standard Hourly (default) | HOURLY | Mon-Fri, 08:00-18:00       | $5,000 first hour, $3,000/hr after, billed per started hour |
| Night Flat Rate    | FLAT   | Mon-Fri 18:00-08:00, and all weekend | $25,000 flat                          |

Change every one of these (or add more) under **Administration -> Pricing**
and **-> Schedules** in the dashboard -- nothing requires touching code.

## How the administrator uses the system

1. Launch `ParkingManager.exe` (or `run_dev.bat` in development). Log in
   with username **admin** and PIN **1234** by default -- change the PIN
   under Settings -> My Account immediately, and create a named account
   for each attendant under **Users** (Settings -> My Account is the only
   part of Settings an attendant account can see; everything else there
   is admin-only). Spanish is the default language; switch to English any
   time with the toggle in the top corner of the login screen or the
   sidebar.
2. Open the **QR** tab, print or display the code at the entrance.
3. As customers register on their phones, they appear under **"Awaiting
   space assignment"** on the Dashboard. Click **Assign space** and pick a
   spot -- the vehicle's card turns into a live occupied card showing
   plate, elapsed time, and running charge. An attendant account can do
   this whole day-to-day loop (assign, exit, cancel) without needing an
   admin login.
4. When a vehicle leaves, click its space card -> **Register exit**. The
   final charge is shown immediately and the space frees up.
5. **Monthly Fees** to set up a fixed reserved space for a regular
   customer (admin-only to create/edit/cancel; anyone can log a payment
   or mark it parked/not-parked from the same screen), **History** for
   search/export, **Revenue** for the cash dashboard, **Pricing** /
   **Schedules** to change rates without touching any code, **Users** to
   manage admin/attendant accounts, **Settings** for business
   name/currency and optional cloud backup
   (see CLOUD_BACKUP.md).

## How the customer uses the QR

1. Scan the QR code posted at the entrance with their phone's camera.
2. Fill in name, license plate, optional phone number -- tap **Register
   vehicle**. No app install, just their phone's browser.
3. They land on a live page showing their plate, assigned space (once the
   attendant assigns one), elapsed time, and current estimated charge,
   auto-refreshing every 15 seconds (with a manual Refresh button too).
4. After the attendant registers the exit, the same page shows the final
   amount.

## Testing checklist

Everything below was verified during development by actually running the
server and making real requests (not just reading the code):

- [x] Register a customer via the API -> appears under "awaiting
      assignment" -> assign a space -> dashboard shows it occupied with a
      live running charge.
- [x] Register exit -> final charge computed, space returns to available,
      customer's page shows the final receipt.
- [x] Duplicate plate while a session is active is rejected with a clear
      error.
- [x] Duplicate phone number while a session is active is rejected.
- [x] All 20 spaces filled -> a 21st registration still succeeds (queues
      as pending) rather than erroring; assigning to a non-available space
      is rejected; freeing one space via exit lets the queued customer be
      assigned.
- [x] Pricing engine: all three hourly rounding methods and the flat rate,
      verified against hand-calculated expected values (see
      `scripts/test_pricing_engine.py` -- run it any time with
      `python scripts/test_pricing_engine.py`).
- [x] Schedule resolution across weekday daytime, weekday evening
      (overnight wraparound window), and weekend (full-day window) --
      this caught and fixed two real bugs during development: a UTC- vs.
      local-time mismatch, and a full-day (`00:00`-`00:00`) window that
      wasn't matching anything. Both are covered by regression tests now.
- [x] Admin routes reject requests without a valid PIN-derived token
      (401) and are architecturally confined to localhost via
      `LocalOnlyMiddleware` regardless of network binding.
- [x] Invalid/unknown customer session token returns 404 with a clear
      message instead of leaking any other session's data.
- [x] Pricing rule / schedule create, edit, delete; deleting a rule that's
      still referenced by a schedule is blocked with a clear error.
- [x] Admin PIN change -- old PIN stops working, new PIN works.
- [x] QR image endpoint returns a valid PNG encoding the machine's LAN
      registration URL.
- [x] CSV and Excel export produce correctly-structured files with the
      expected columns and data.
- [x] **Active sessions survive an unexpected shutdown** -- verified by
      filling all 20 spaces, force-killing the server process (`kill -9`,
      simulating a crash/power loss), restarting it, and confirming all 20
      occupied sessions (plates, entry times, running charges) were intact.
- [x] **Displayed timestamps match the system clock.** Entry/exit times
      shown in both the admin dashboard and the customer's mobile page
      match the actual local time on the machine -- reproduced the
      original bug (a UTC-offset-sized discrepancy, e.g. 6:25pm showing as
      1:25pm) with the old code and confirmed the fix with the exact same
      test case, in both the admin and mobile JS.
- [x] **Cloud backup**, tested against a mock endpoint that replicates
      Google Apps Script's exact quirks (always returns HTTP 200, success
      is only knowable from the JSON body): correct secret succeeds,
      wrong secret is correctly detected as a failure despite the 200,
      an unreachable endpoint fails gracefully without crashing anything,
      the automatic background loop picks up new completed sessions
      without any manual action, and recovers automatically after a
      simulated outage (killed the mock receiver, confirmed the failure
      was recorded, brought it back, confirmed the next cycle self-healed).
- [x] **Bilingual UI (Spanish/English)**, tested with a real headless
      browser environment (jsdom) driving the actual shipped `index.html`
      / `app.js` / `register.html` / `session.html` / `mobile.js` against
      the real running server -- not just reading the code. Verified:
      default language is Spanish; every view (Dashboard, Pricing,
      Schedules, Revenue, History) renders correctly in both languages,
      including dynamically-generated content like pricing rule
      descriptions and translated weekday abbreviations (LUN/MAR/MIÉ...);
      the toggle re-renders the *currently open* view live, with no page
      reload; the customer mobile pages translate correctly end-to-end
      including a full register -> assign -> exit -> final receipt cycle;
      and common server-side error messages (duplicate plate, phone
      already active, PIN errors) are matched and translated on both the
      admin and mobile side, with graceful fallback to the original
      English text for anything not in the mapping (see "Known
      simplifications" below).
- [x] **Remote access security.** This is the one most worth stating
      explicitly: a request carrying `CF-Connecting-IP`, `CF-Ray`, or
      `X-Forwarded-For` -- the signature of having passed through a proxy
      or tunnel -- is rejected from every admin route with a 403, *even
      when the underlying TCP connection genuinely originates from
      127.0.0.1* (reproduced deliberately with curl to prove the header
      check, not just the IP check, is what's enforcing this). Confirmed
      customer routes are completely unaffected by the same headers, and
      that the QR/registration link correctly switches between the local
      network URL and a configured public URL as Remote Access is toggled
      on and off in Settings.
- [x] **GitHub Pages status page**, tested as a full chain: a mock server
      replicating the real Apps Script's exact upsert-by-token and
      always-200 behavior; confirmed the same Sheet row updates (not a
      new row each time) as a real session moves through registration,
      space assignment, and exit; confirmed the actual shipped
      `github_pages/` files -- not a simplified stand-in -- correctly
      render each of those states when driven by a headless browser with
      no connection to ParkingManager's own server at all, only to the
      mock Sheet endpoint; confirmed the JS pricing port
      (`github_pages/js/pricing_engine.js`) produces byte-for-byte
      identical results to the Python original across the same test
      cases used for the backend's own pricing engine tests; and
      confirmed the local mobile session page correctly shows (or hides)
      the "check from anywhere" link as the feature is toggled on and off.

- [x] **Role-based access control (Admin vs. Vigilante/Attendant)**,
      tested by actually logging in as each role and calling every
      admin-only endpoint (pricing, schedules, settings, revenue,
      history, exports, cloud/remote/status-page config, subscription
      create/edit/cancel, user management -- about a dozen routes) as an
      Attendant account and confirming a 403 on every one, while
      confirming the same account succeeds at every operational action
      (dashboard, assign space, register exit, cancel session, QR,
      logging a monthly payment, toggling parked status). Also tested
      through the actual rendered UI with a headless browser, not just
      the API directly: an Attendant's sidebar shows only 5 of the 10 nav
      items, the Settings page shows only their own PIN change (the
      Business/Cloud Backup/Remote Access/Status Page panels are hidden),
      and -- critically -- forcibly triggering a hidden admin-only view
      (bypassing the UI's own hiding) still renders nothing, because the
      server itself refuses the request rather than the restriction being
      UI-only.
- [x] **Account safety nets**: confirmed the system refuses to demote or
      deactivate the last remaining admin account (and confirmed it DOES
      allow that once a second admin exists); confirmed self-service PIN
      change rejects the wrong current PIN and accepts the right one;
      confirmed an admin resetting another user's forgotten PIN
      immediately invalidates that user's existing logged-in session
      rather than waiting for it to expire; confirmed upgrading a
      database that still had the old single-shared-PIN system
      preserves that exact PIN under the new "admin" account rather than
      resetting it or locking anyone out.
- [x] **Monthly fees ("mensualidades")**: reserving a space for a
      subscription correctly removes it from the walk-in assignment pool
      -- this caught a real bug during development (the space's own
      AVAILABLE/OCCUPIED status doesn't change when reserved, so the
      normal assign-space endpoint didn't know to reject it until a
      second, explicit check was added there too, found by directly
      testing "assign a walk-in straight to a reserved space" rather than
      assuming the first check was sufficient). Also verified: logging a
      payment advances the next-due date by exactly one calendar month;
      an overdue subscription is flagged as such on both the dashboard
      space card and the Monthly Fees list; cancelling a subscription
      immediately frees the space back to the walk-in pool; and, through
      the actual UI, creating a new subscription's space picker correctly
      excludes a space that's already reserved by another one.

**Still to verify once you have a Windows machine + a second device
(phone) on the same Wi-Fi**, since the build sandbox used for development
has no Windows target and a locked-down network:
- [ ] `build_windows.bat` actually produces a working `.exe` (the *code*
      that gets bundled is fully tested; the PyInstaller packaging step
      itself needs a real Windows machine to execute).
- [ ] Scanning the printed QR from an actual phone reaches the
      registration page over Wi-Fi (LAN discovery and the admin/customer
      network split are implemented per the design in section F, but a
      locked-down build sandbox couldn't exercise real multi-device LAN
      traffic).
- [ ] Windows Firewall prompt behavior on first launch (see
      BUILD_WINDOWS.md).
- [ ] The real Google Apps Script deployment end-to-end (the sync
      *client* logic is fully tested against a mock that replicates its
      behavior exactly -- see above -- but the actual script hasn't been
      deployed against a live Google account from this environment).
- [ ] The real GitHub Pages deployment (the *page itself* is fully tested
      against a mock Apps Script endpoint with the exact same contract --
      see above -- but hasn't been pushed to an actual GitHub repo and
      served from a real `github.io` URL from this environment).

## Automated tests

```
pip install -r requirements-dev.txt
python -m pytest -q            # API, security, migration, packaging, access log, cloud sync (~40 s)
python scripts/test_pricing_engine.py   # pricing math, no server needed
```

The screens (jsdom) and the end-to-end test against the cloud service need
Node.js; they are skipped when it is missing:

```
cd cloud_worker && npm ci && cd ..      # installs wrangler + jsdom
set NODE_PATH=cloud_worker\node_modules  # (PowerShell: $env:NODE_PATH="cloud_worker\node_modules")
python -m pytest -q                      # now also drives the admin console, the QR page and a real app -> local Worker run
npm test --prefix cloud_worker           # the cloud service on its own: ingest, keys, panel, throttling (46 checks)
```

`tests/` starts a real server on a free port with a throw-away data folder,
so the network-level protections (admin only from this machine, Host-header
check, no CORS) are exercised over real sockets. Each regression test names
the failure it guards against. `python desktop_app.py --headless` starts only
the server (no window) -- handy for smoke-testing a build.

## Known simplifications / good next steps

Documented honestly rather than hidden:

- **The exact line between Admin and Vigilante/Attendant permissions was
  my interpretation of "just being able to assign parking spaces,"** not
  a spec you dictated field-by-field. I included exit/cancel (the role
  couldn't function without them) and QR viewing, and blocked History and
  Revenue along with pricing/schedules/settings, reasoning that "day-to-day
  operations only" meant the reporting/financial side stays admin-only
  too. If you'd rather an attendant could look up History (e.g. to
  resolve a "did this car register?" dispute) without seeing Revenue,
  that's a one-line change per route in `app/routers/admin.py` (swap
  `require_full_admin` for `require_admin` on that specific endpoint) --
  say the word and I'll adjust it.
- **A monthly subscriber's vehicle isn't tracked with real check-in/out
  timestamps** -- `currently_parked` is a manual toggle, not derived from
  anything automatic, by design (there's no billing reason to time a flat
  monthly fee). If you wanted arrival/departure history for reserved
  spaces too, that would mean giving monthly sessions their own light
  version of the ParkingSession lifecycle -- a real feature, not a small
  tweak, and one I'd want to scope with you rather than guess at.
- **One monthly subscription per space, one primary plate per
  subscription** (with a free-text field for an occasional second car) --
  covers the common case without a many-to-many vehicles-to-spaces model
  that this scale of lot is unlikely to need.
- **Rate resolution uses entry time for the whole stay** rather than
  splitting a single visit across multiple schedule windows if it crosses
  one (e.g. entering at 17:00 under a daytime rate, leaving at 19:00 after
  the evening rate kicks in). This is a common real-world simplification;
  the schema already supports adding segment-splitting later without a
  redesign.
- **PDF export** was left out (the spec marked it optional/"if
  practical"); CSV and Excel are implemented. Adding PDF would mean
  picking a PDF library and writing one more export function alongside
  the existing CSV/Excel ones in `app/routers/admin.py`.
- **There is no audit log.** Accounts are named (Admin / Vigilante) and
  PINs are throttled after repeated failures, but the app does not yet
  record *who* assigned, exited or cancelled each session. For a
  multi-attendant, multi-shift lot that is the natural next feature.
- **Default PIN.** A fresh install starts with `admin` / `1234`. Change it
  first (Users -> Reset PIN). Forcing that change at first login is a good
  next step.
- **No automatic database backup.** `parking.db` lives in
  `%APPDATA%\ParkingManager`; copy it periodically, or enable Cloud Backup
  (section I) for a mirror in Google Sheets. A scheduled local copy would be
  a small, useful addition.
- **Flat rates and hourly rates have no daily cap or grace period.** A FLAT
  rate is charged once however long the car stays (a 3-day stay pays one
  "full day"), and an hourly stay of 60 min + 1 s is billed as two hours.
  Both are business decisions, so they were left as they are and listed in
  CHANGELOG.md as options.
- **No code signing** on the built `.exe`, so Windows SmartScreen will
  warn on first run (see BUILD_WINDOWS.md). Fine for internal/single-lot
  use; a commercial rollout would want a code-signing certificate.
- **Translation of server error messages is pattern-matched on the
  frontend, not a real backend i18n system.** The UI chrome (every label,
  button, header, and status you see) is fully and directly translated.
  The dozen or so error messages the *backend* can send back (duplicate
  plate, space unavailable, etc.) are still written in English in
  `app/crud.py`; the frontend recognizes the common ones and translates
  them for display (see `translateServerMessage()` in both `i18n.js`
  files), falling back to showing the original English text for anything
  it doesn't recognize -- so nothing is ever silently hidden, but coverage
  isn't 100%. A more thorough approach would have the backend itself pick
  a language (e.g. from an `Accept-Language` header) and return
  pre-translated messages; that's a reasonable follow-up if it matters,
  but was out of scope for this pass given how few distinct messages there
  are and how well the pattern-matching approach already covers them.
- **Cloud backup is a one-way, best-effort mirror**, not a two-way sync or
  a real-time replica -- see CLOUD_BACKUP.md for what it does and doesn't
  cover, and why Google Sheets was picked over a couple of other free
  options that were compared first.
- **The GitHub Pages status page is read-only and has sync lag** (up to
  ~30 seconds, tied to Cloud Backup's sync cycle) -- it's a "check from
  anywhere after the fact" companion, not a replacement for the local
  page or a way to register remotely. See GITHUB_PAGES_STATUS.md for the
  full trade-off list, including why the Apps Script's row lookup (a
  linear scan by token) is fine at this scale but wouldn't be the right
  design for a much larger deployment.
