import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session as DBSession

from app import crud, config
from app.database import get_db
from app.models import SessionStatus
from app.schemas import CustomerRegisterRequest, CustomerRegisterResponse, CustomerSessionView

router = APIRouter(prefix="/api/customer", tags=["customer"])

_registration_lock = threading.Lock()
_registrations_by_client: dict[str, deque] = defaultdict(deque)


def _client_key(request: Request) -> str:
    """Best-effort identity of the phone doing the registering. Behind a
    Cloudflare Tunnel every request arrives from 127.0.0.1, so the real
    address comes from CF-Connecting-IP. This is an anti-spam measure, not
    a security boundary, so trusting that header is acceptable."""
    forwarded = request.headers.get("cf-connecting-ip")
    if forwarded:
        return forwarded.strip()
    return request.client.host if request.client else "unknown"


def _check_registration_rate(key: str) -> None:
    now = time.time()
    with _registration_lock:
        window = _registrations_by_client[key]
        while window and now - window[0] > config.REGISTRATION_WINDOW_SECONDS:
            window.popleft()
        if len(window) >= config.REGISTRATIONS_PER_IP:
            raise HTTPException(
                status_code=429,
                detail="Too many registrations from this device. Please wait a few minutes "
                       "or ask the attendant for help.",
            )
        window.append(now)


@router.post("/register", response_model=CustomerRegisterResponse)
def register(payload: CustomerRegisterRequest, request: Request, db: DBSession = Depends(get_db)):
    """Public endpoint reached by scanning the lot's QR code. The customer
    supplies only name / plate / optional phone -- entry time is stamped by
    the server, and no field here lets them set a space, a rate, or a
    charge (see app/schemas.py: CustomerRegisterRequest has no such fields)."""
    _check_registration_rate(_client_key(request))
    if len(crud.pending_registrations(db)) >= config.MAX_PENDING_REGISTRATIONS:
        raise HTTPException(
            status_code=429,
            detail="The registration queue is full right now. Please ask the attendant for help.",
        )
    try:
        session = crud.create_session(db, payload.name, payload.plate, payload.phone)
    except crud.BusinessError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return CustomerRegisterResponse(
        session_token=session.session_token,
        session_url=f"/mobile/session?token={session.session_token}",
    )


@router.get("/session/{token}", response_model=CustomerSessionView)
def view_session(token: str, db: DBSession = Depends(get_db)):
    """Public, but scoped: the unguessable token in the URL is the only key.
    There is no way to list or browse other customers' sessions from here."""
    session = crud.get_session_by_token(db, token)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found. Check the link or scan the QR again.")

    if session.status == SessionStatus.CANCELLED.value:
        raise HTTPException(status_code=410, detail="This parking session was cancelled by the attendant.")

    now = datetime.now()
    if session.status == SessionStatus.COMPLETED.value:
        if session.exit_timestamp and now - session.exit_timestamp > timedelta(
            minutes=config.COMPLETED_SESSION_VISIBILITY_MINUTES
        ):
            raise HTTPException(status_code=410, detail="This parking session has expired.")
        elapsed = session.duration_minutes or 0.0
        estimated = session.final_amount or 0.0
        message = "This session is complete. Thank you for parking with us."
    elif session.status == SessionStatus.OCCUPIED.value:
        elapsed, estimated = crud.live_estimate(db, session)
        message = None
    else:  # PENDING_ASSIGNMENT
        elapsed, estimated = crud.live_estimate(db, session)
        message = "Waiting for the attendant to assign a parking space."

    return CustomerSessionView(
        name=session.customer.name,
        plate=session.customer.plate,
        phone=session.customer.phone,
        space_number=session.space.number if session.space else None,
        status=session.status,
        entry_timestamp=session.entry_timestamp,
        exit_timestamp=session.exit_timestamp,
        server_time=now,
        elapsed_minutes=round(elapsed, 1),
        estimated_amount=estimated,
        final_amount=session.final_amount,
        is_final=session.status == SessionStatus.COMPLETED.value,
        currency=crud.get_currency(db),
        message=message,
        status_page_url=crud.status_page_url(db, session.session_token),
    )
