"""Local sign-up / sign-in routes.

Everything here reads and writes ``~/.openjarvis/users.db`` on this
machine. No account data is sent anywhere else.

The session token travels in an ``X-OJ-Session`` header rather than
``Authorization``, so it cannot be confused with the server's optional
shared API key (see ``auth_middleware.AuthMiddleware``), which validates
``Authorization: Bearer`` against a single configured value.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from openjarvis.server.auth_store import AuthError, get_auth_store

logger = logging.getLogger(__name__)

auth_router = APIRouter(prefix="/v1/auth", tags=["auth"])

SESSION_HEADER = "X-OJ-Session"


class SignUpRequest(BaseModel):
    email: str
    password: str
    display_name: str = ""


class SignInRequest(BaseModel):
    email: str
    password: str


def _token(request: Request) -> str:
    return request.headers.get(SESSION_HEADER, "")


@auth_router.get("/status")
async def auth_status(request: Request):
    """Whether an account exists yet, and who (if anyone) is signed in.

    The UI uses ``has_account`` to decide between showing "Create your
    account" and "Sign in" on first load.
    """
    store = get_auth_store()
    user = store.user_for_token(_token(request))
    return {
        "has_account": store.user_count() > 0,
        "signed_in": user is not None,
        "user": user,
    }


@auth_router.post("/signup")
async def sign_up(body: SignUpRequest):
    store = get_auth_store()
    try:
        user = store.create_user(body.email, body.password, body.display_name)
    except AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = store.create_session(int(user["id"]))
    return {"token": token, "user": user}


@auth_router.post("/signin")
async def sign_in(body: SignInRequest):
    store = get_auth_store()
    user = store.verify_credentials(body.email, body.password)
    if user is None:
        # One message for both "no such email" and "wrong password" so the
        # response cannot be used to enumerate registered addresses.
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    token = store.create_session(int(user["id"]))
    return {"token": token, "user": user}


@auth_router.post("/signout")
async def sign_out(request: Request):
    get_auth_store().delete_session(_token(request))
    return {"status": "ok"}


@auth_router.get("/me")
async def me(request: Request):
    user: Optional[dict] = get_auth_store().user_for_token(_token(request))
    if user is None:
        raise HTTPException(status_code=401, detail="Not signed in.")
    return {"user": user}


__all__ = ["auth_router", "SESSION_HEADER"]
