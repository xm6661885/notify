"""Password and cookie session helpers."""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import timedelta

import bcrypt
from fastapi import Depends, HTTPException, Request

from . import db

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
COOKIE_NAME = "nt_session"
COOKIE_AGE = int(timedelta(days=365).total_seconds())


def validate_username(username: str) -> str:
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(422, "Invalid username")
    return username


def validate_password(password: str) -> str:
    if not 4 <= len(password) <= 128:
        raise HTTPException(422, "Password must be 4-128 characters")
    return password


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def set_session(request: Request, response, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    db.create_session(request.app.state.db_path, token_hash(token), user_id, request.headers.get("user-agent"))
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax", path="/", max_age=COOKIE_AGE, secure=secure)


def current_user(request: Request) -> dict:
    token = request.cookies.get(COOKIE_NAME)
    user = db.session_user(request.app.state.db_path, token_hash(token)) if token else None
    if not user or user["disabled"]:
        raise HTTPException(401, "Authentication required")
    return user


def require_admin(user: dict = Depends(current_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(403, "Admin only")
    return user
