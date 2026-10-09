"""
Central configuration for ParkingManager.

Handles the tricky part of desktop-app packaging: figuring out where code
lives (which changes once PyInstaller freezes everything into a single exe)
versus where DATA should live (which must be a real, writable, persistent
folder on the user's machine -- never inside the temp folder PyInstaller
extracts a onefile build into).
"""
import os
import sys
from pathlib import Path

APP_NAME = "ParkingManager"

# ---------------------------------------------------------------------------
# Code location (read-only once frozen)
# ---------------------------------------------------------------------------
if getattr(sys, "frozen", False):
    # Running as a PyInstaller-built exe. Bundled data files (desktop_ui/,
    # mobile_ui/) are unpacked next to the executable via the .spec file's
    # `datas` list, and are reachable from sys._MEIPASS (onefile) or the
    # exe's own folder (onedir).
    BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
else:
    # Running from source: app/config.py -> project root is one level up.
    BASE_DIR = Path(__file__).resolve().parent.parent

DESKTOP_UI_DIR = BASE_DIR / "desktop_ui"
MOBILE_UI_DIR = BASE_DIR / "mobile_ui"

# ---------------------------------------------------------------------------
# Data location (writable, persists across restarts and reinstalls)
# ---------------------------------------------------------------------------
def _default_data_dir() -> Path:
    if os.name == "nt":
        root = os.environ.get("APPDATA") or str(Path.home())
        return Path(root) / APP_NAME
    # Linux/Mac fallback (used during development in this sandbox)
    return Path.home() / f".{APP_NAME.lower()}"


DATA_DIR = Path(os.environ.get("PARKINGMANAGER_DATA_DIR", _default_data_dir()))
DATA_DIR.mkdir(parents=True, exist_ok=True)

EXPORTS_DIR = DATA_DIR / "exports"
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_PATH = DATA_DIR / "parking.db"
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

# ---------------------------------------------------------------------------
# Time source
# ---------------------------------------------------------------------------
# The whole app uses the local system clock of the machine running the
# desktop application (datetime.now(), naive/local -- not UTC) as its single
# authoritative time source. This matters for the pricing engine: an admin
# configuring a schedule as "Monday-Friday 08:00-18:00" means local business
# hours, so entry/exit timestamps and schedule matching must all use the
# same local clock, or rates would silently shift by the timezone offset.

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------
SERVER_HOST = os.environ.get("PARKINGMANAGER_HOST", "0.0.0.0")
SERVER_PORT = int(os.environ.get("PARKINGMANAGER_PORT", "8000"))

# Hosts allowed to reach admin routes. Requests arriving from any other
# client address are rejected before they reach admin business logic -- this
# is what keeps "administrator functionality" confined to the machine
# running the desktop app, even though the same server also answers phones
# on the local Wi-Fi for the customer-facing QR pages.
LOCAL_ONLY_HOSTS = {"127.0.0.1", "localhost", "::1"}

NUM_PARKING_SPACES = 20

# How long a customer's session token remains resolvable after the session
# is completed (so they can still see their final receipt after exit).
COMPLETED_SESSION_VISIBILITY_MINUTES = 24 * 60

# Anti-spam for the PUBLIC registration endpoint (reachable by every phone on
# the Wi-Fi, and by anyone with the link when remote access is enabled).
# - at most REGISTRATIONS_PER_IP registrations per client per window, and
# - at most MAX_PENDING_REGISTRATIONS people waiting for a space at once
#   (the lot has 20 spaces, so a far longer queue means someone is flooding it).
REGISTRATION_WINDOW_SECONDS = 10 * 60
REGISTRATIONS_PER_IP = 6
MAX_PENDING_REGISTRATIONS = 40
