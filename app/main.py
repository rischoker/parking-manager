import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app import config, cloud_sync
from app.database import init_db, SessionLocal
from app.seed_data import seed_core
from app.routers import admin, customer

CLOUD_SYNC_INTERVAL_SECONDS = 30


def _cloud_sync_loop():
    """Runs for the lifetime of the app, retrying any not-yet-synced
    completed sessions every 30s. Re-reads the enabled/url settings on each
    pass, so turning cloud backup on/off in Settings takes effect without a
    restart. Any error is swallowed by cloud_sync.sync_pending_sessions
    itself (never raises), so this loop can never crash the app."""
    while True:
        time.sleep(CLOUD_SYNC_INTERVAL_SECONDS)
        db = SessionLocal()
        try:
            cloud_sync.sync_pending_sessions(db)
        except Exception:
            pass  # background maintenance task -- never let it take the app down
        finally:
            db.close()

ADMIN_PATH_PREFIXES = ("/api/admin", "/admin")

# Headers Cloudflare (and most reverse proxies/tunnels) add to every request
# they forward. Their PRESENCE is what matters here, not their value: if a
# request carries one of these, it arrived through a proxy/tunnel hop, so
# request.client.host reflects that hop's *local* connection to this
# machine (typically 127.0.0.1) rather than the real internet visitor --
# exactly the situation that would otherwise let a Cloudflare Tunnel
# accidentally bypass the "admin only from this machine" rule below. See
# REMOTE_ACCESS.md for the full explanation and the tunnel-side fix
# (restricting the tunnel's ingress rules to customer-facing paths only)
# that this check backs up as defense-in-depth.
PROXY_HOP_HEADERS = ("cf-connecting-ip", "cf-ray", "x-forwarded-for")


def _host_header_is_local(request: Request) -> bool:
    """The Host header must name this machine ("127.0.0.1:8000",
    "localhost:8000", "[::1]:8000"). A web page on a hostile domain that has
    been re-pointed at 127.0.0.1 ("DNS rebinding") reaches this server from
    the local machine, so the connecting address alone looks trusted -- but
    its requests still carry that hostile domain as Host, which is how they
    are told apart from the real desktop window."""
    host = (request.headers.get("host") or "").strip().lower()
    if host.startswith("["):                       # IPv6 literal, e.g. [::1]:8000
        hostname = host[1:].split("]", 1)[0]
    else:
        hostname = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    return hostname in config.LOCAL_ONLY_HOSTS


def is_local_request(request: Request) -> bool:
    if any(h in request.headers for h in PROXY_HOP_HEADERS):
        return False
    client_host = request.client.host if request.client else None
    return client_host in config.LOCAL_ONLY_HOSTS and _host_header_is_local(request)


class LocalOnlyMiddleware(BaseHTTPMiddleware):
    """Rejects any request to an admin path that did not originate from the
    machine running this server. See app/security.py module docstring for
    the full two-layer explanation, and is_local_request() above for why a
    request that passed through any proxy/tunnel hop -- Cloudflare Tunnel
    included -- is never treated as local, no matter what the immediate
    connecting address looks like."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith(ADMIN_PATH_PREFIXES) and not is_local_request(request):
            return JSONResponse(
                status_code=403,
                content={"detail": "Administrator functionality is only available from the machine "
                                    "running the ParkingManager desktop application."},
            )
        return await call_next(request)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    db = SessionLocal()
    try:
        seed_core(db)
    finally:
        db.close()
    threading.Thread(target=_cloud_sync_loop, daemon=True).start()
    yield


def create_app() -> FastAPI:
    # No interactive API docs: /docs and /openapi.json would publish the
    # complete list of admin endpoints to every phone on the Wi-Fi.
    app = FastAPI(title="ParkingManager", version="1.1.0",
                  docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    app.add_middleware(LocalOnlyMiddleware)
    # Deliberately NO CORS middleware. The customer pages (/mobile/...) are
    # served by this same server, so their API calls are same-origin and need
    # no CORS headers. The previous "allow every origin" setting let any web
    # page open in a browser on the admin PC read this server's responses --
    # including admin login attempts.

    app.include_router(admin.router)
    app.include_router(customer.router)

    if config.MOBILE_UI_DIR.exists():
        app.mount("/mobile/static", StaticFiles(directory=str(config.MOBILE_UI_DIR)), name="mobile-static")
    if config.DESKTOP_UI_DIR.exists():
        app.mount("/admin/static", StaticFiles(directory=str(config.DESKTOP_UI_DIR)), name="admin-static")

    @app.get("/mobile/register")
    def mobile_register_page():
        return FileResponse(str(config.MOBILE_UI_DIR / "register.html"))

    @app.get("/mobile/session")
    def mobile_session_page():
        return FileResponse(str(config.MOBILE_UI_DIR / "session.html"))

    @app.get("/admin")
    def admin_page(request: Request):
        if not is_local_request(request):
            return JSONResponse(
                status_code=403,
                content={"detail": "The admin dashboard can only be opened on the machine running "
                                    "ParkingManager."},
            )
        return FileResponse(str(config.DESKTOP_UI_DIR / "index.html"))

    @app.get("/health")
    def health():
        # "app" lets desktop_app.py tell its own server from some other
        # program that happens to be using the port.
        return {"status": "ok", "app": "ParkingManager"}

    return app


app = create_app()
