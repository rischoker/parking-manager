"""QR code generation for the customer entry point, and LAN IP discovery so
the QR points somewhere a phone on the same Wi-Fi can actually reach.

Architecture note (see README section "QR / mobile architecture" for the
full explanation): the desktop app runs the same FastAPI server that serves
both the admin dashboard and the customer pages. It binds 0.0.0.0 so it is
reachable at the machine's LAN IP. By default the printed/displayed QR
encodes `http://<lan-ip>:<port>/mobile/register` -- no internet connection,
cloud service, or public hosting is required for the local-network case,
which keeps that path free and keeps customer data on the premises.

If a public URL is configured (Settings -> Remote Access -- see
REMOTE_ACCESS.md), registration_url() uses that instead, so the QR/link
works from anywhere, not just the booth's Wi-Fi. See app/main.py's
is_local_request() / PROXY_HOP_HEADERS for the corresponding server-side
protection that keeps the admin dashboard from being exposed by that same
tunnel -- exposing the customer pages publicly must never expose the admin
ones, and that's enforced independently of whatever this function returns.
"""
import io
import socket

import qrcode
from sqlalchemy.orm import Session as DBSession

from app import config, crud


def get_local_ip() -> str:
    """Best-effort discovery of this machine's LAN IP address. Opens a UDP
    'connection' to a public address without sending any packets -- this is
    just a trick to ask the OS which local interface/IP would be used."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def local_registration_url(port: int | None = None) -> str:
    port = port or config.SERVER_PORT
    return f"http://{get_local_ip()}:{port}/mobile/register"


def registration_url(db: DBSession | None = None, port: int | None = None) -> str:
    """Returns the URL the QR code should encode: the configured public URL
    if remote access is enabled and one is set, otherwise the local-network
    URL (unchanged default behavior)."""
    if db is not None:
        enabled = crud.get_setting(db, "public_access_enabled", "false") == "true"
        base = (crud.get_setting(db, "public_base_url", "") or "").strip().rstrip("/")
        if enabled and base:
            return f"{base}/mobile/register"
    return local_registration_url(port)


def generate_qr_png(url: str) -> bytes:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=3,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0f172a", back_color="#ffffff")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
