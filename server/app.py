"""Notify HTTP API and frontend serving."""
from __future__ import annotations

import json
import mimetypes
import re
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import db
from .auth import (COOKIE_NAME, check_password, current_user, hash_password,
                   require_admin, set_session, token_hash, validate_password,
                   validate_username)
from .config import load_config
from .paths import DIST_DIR, atomic_write, data_dir as resolve_data_dir, files_dir
from .push import PushWorker, ensure_vapid, push_service
from .routing import UserRouting, compute_recipients, extract_topics
from .webhooks import WebhookWorker, notification_context, render, PUBLIC_URL_ERROR, public_url, test_context


class LoginIn(BaseModel):
    username: str
    password: str


class RegisterIn(LoginIn):
    invite_code: str | None = None


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


class ActionIn(BaseModel):
    name: str
    url: str


BLOCKED_SCHEMES = ("javascript:", "data:", "vbscript:", "file:")


class SettingsIn(BaseModel):
    topics_mode: str | None = None
    topics: list[str] | None = None
    blacklist: list[str] | None = None
    admin_blacklist: list[str] | None = None
    feed_topics: list[str] | None = None
    actions: list[ActionIn] | None = None


class StateIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)
    read: bool | None = None
    archived: bool | None = None


class ReadAllIn(BaseModel):
    view: str = "inbox"
    topic: str | None = None


class SubscribeIn(BaseModel):
    endpoint: str
    keys: dict[str, str]


class EndpointIn(BaseModel):
    endpoint: str


class TestPushIn(BaseModel):
    endpoint: str | None = None


class AdminCreateIn(LoginIn):
    is_admin: bool = False


class AdminPatchIn(BaseModel):
    is_admin: bool | None = None
    disabled: bool | None = None
    password: str | None = None
    settings: SettingsIn | None = None


class RouteIn(BaseModel):
    topic: str
    user_ids: list[int]


class AdminSettingsIn(BaseModel):
    registration_open: bool | None = None
    invite_only: bool | None = None
    invite_code: str | None = Field(default=None, max_length=64)
    push_interval_sec: float | None = Field(default=None, ge=0, le=600)
    proxy_url: str | None = Field(default=None, max_length=200)
    push_proxy: dict[str, bool] | None = None


class WebhookIn(BaseModel):
    name: str
    url: str
    method: str = "POST"
    headers: dict[str, str] = Field(default_factory=dict)
    body_kind: str = "json"
    body: str = ""
    enabled: bool = True
    use_proxy: bool = False
    topics: list[str] = Field(default_factory=list)


class WebhookPatch(BaseModel):
    name: str | None = None
    url: str | None = None
    method: str | None = None
    headers: dict[str, str] | None = None
    body_kind: str | None = None
    body: str | None = None
    enabled: bool | None = None
    use_proxy: bool | None = None
    topics: list[str] | None = None


class DeliveryRetryIn(BaseModel):
    kind: Literal["push", "webhook"]
    id: int


class DeliveryKindIn(BaseModel):
    kind: Literal["push", "webhook", "all"]


def _webhook_fields(data: dict, is_admin: bool) -> dict:
    data = dict(data)
    if "name" in data:
        data["name"] = data["name"].strip()
        if not 1 <= len(data["name"]) <= 64:
            raise HTTPException(422, "Webhook name must be 1–64 characters")
    if "url" in data:
        data["url"] = data["url"].strip()
        try:
            parts = urlsplit(data["url"])
            valid = parts.scheme in ("http", "https") and bool(parts.hostname) and len(data["url"]) <= 2000
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(422, "Invalid webhook URL")
        if not is_admin and not public_url(data["url"]):
            raise HTTPException(422, PUBLIC_URL_ERROR)
    if "method" in data:
        data["method"] = data["method"].upper()
        if data["method"] not in ("GET", "POST", "PUT", "PATCH"):
            raise HTTPException(422, "Invalid webhook method")
    if "headers" in data:
        headers = data["headers"]
        if len(headers) > 30 or any(not 1 <= len(key) <= 100 or not re.fullmatch(r"[A-Za-z0-9-]+", key) or len(value) > 2000 or "\r" in value or "\n" in value for key, value in headers.items()):
            raise HTTPException(422, "Invalid webhook headers")
        data["headers"] = json.dumps(headers, ensure_ascii=False)
    if "body_kind" in data and data["body_kind"] not in ("json", "text"):
        raise HTTPException(422, "Invalid body_kind")
    if "body" in data and len(data["body"]) > 20000:
        raise HTTPException(422, "Webhook body is too long")
    if "topics" in data:
        data["topics"] = json.dumps(_clean_list(data["topics"], 50, 64, True), ensure_ascii=False)
    for key in ("enabled", "use_proxy"):
        if key in data:
            data[key] = int(data[key])
    return data


def _clean_list(items: list[str], maximum: int, length: int, strip_hash: bool = False) -> list[str]:
    result = []
    seen = set()
    for item in items:
        value = item.strip()
        if strip_hash:
            value = value.lstrip("#").strip()
        if not value:
            continue
        if len(value) > length:
            raise HTTPException(422, f"Item must be at most {length} characters")
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    if len(result) > maximum:
        raise HTTPException(422, f"Too many items (maximum {maximum})")
    return result


def _settings_patch(body: SettingsIn, admin: bool = False) -> dict:
    patch = {}
    if body.topics_mode is not None:
        if body.topics_mode not in ("all", "only"):
            raise HTTPException(422, "Invalid topics_mode")
        patch["topics_mode"] = body.topics_mode
    if body.topics is not None:
        patch["topics"] = _clean_list(body.topics, 100, 64, True)
    if body.blacklist is not None:
        patch["blacklist"] = _clean_list(body.blacklist, 200, 100)
    if body.feed_topics is not None:
        patch["feed_topics"] = _clean_list(body.feed_topics, 100, 64, True)
    if body.actions is not None:
        if len(body.actions) > 20:
            raise HTTPException(422, "Too many actions (maximum 20)")
        actions = []
        for action in body.actions:
            name, url = action.name.strip(), action.url.strip()
            if not name or len(name) > 40:
                raise HTTPException(422, "Action name must be 1 to 40 characters")
            if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", url) or len(url) > 2000:
                raise HTTPException(422, "Action link must be a URL with a scheme, e.g. https:// or shortcuts://")
            if url.lower().startswith(BLOCKED_SCHEMES):
                raise HTTPException(422, "This link scheme is not allowed")
            actions.append({"name": name, "url": url})
        patch["actions"] = actions
    if admin and body.admin_blacklist is not None:
        patch["admin_blacklist"] = _clean_list(body.admin_blacklist, 200, 100)
    return patch


def _me(app: FastAPI, user: dict) -> dict:
    path = app.state.db_path
    return {"user": {"id": user["id"], "username": user["username"], "is_admin": bool(user["is_admin"])},
            "settings": db.user_settings(path, user["id"]), "unread": db.unread_count(path, user["id"])}


def _admin_user(app: FastAPI, user_id: int) -> dict:
    row = next((row for row in db.admin_users(app.state.db_path) if row["id"] == user_id), None)
    if not row:
        raise HTTPException(404, "Not found")
    return {"id": row["id"], "username": row["username"], "is_admin": bool(row["is_admin"]),
            "disabled": bool(row["disabled"]), "created_at": row["created_at"],
            "settings": db.user_settings(app.state.db_path, user_id),
            "subscriptions": row["subscriptions"], "webhooks": row["webhooks"],
            "delivered": row["delivered"], "unread": row["unread"]}


def _notification_out(row: dict, topics: list[str], list_item: bool = False) -> dict:
    text = row["text"]
    truncated = bool(list_item and text is not None and len(text) > 600)
    if truncated:
        text = text[:600] + "…"
    file = None
    if row["file_path"]:
        url = f"/api/notifications/{row['id']}/file"
        file = {"name": row["file_name"], "size": row["file_size"], "mime": row["mime"],
                "is_image": (row["mime"] or "").startswith("image/"), "url": url,
                "download_url": url + "?download=1"}
    return {"id": row["id"], "created_at": row["created_at"], "type": row["type"],
            "text": text, "markdown": bool(row["markdown"]), "topics": topics,
            "file": file, "read": row["read_at"] is not None,
            "archived": row["archived_at"] is not None, "read_at": row["read_at"],
            "archived_at": row["archived_at"], "truncated": truncated}


def _view(value: str) -> str:
    if value not in ("inbox", "archived", "history"):
        raise HTTPException(422, "Invalid view")
    return value


def _safe_name(filename: str | None) -> str:
    value = (filename or "").replace("\\", "/").split("/")[-1]
    value = "".join(char for char in value if ord(char) >= 32 and ord(char) != 127)
    return value[:200] or "file"


def _cli_auth(request: Request) -> None:
    if request.headers.get("x-real-ip") is not None or request.headers.get("x-forwarded-for") is not None:
        raise HTTPException(403, "CLI endpoint is local only")
    if not request.client or request.client.host not in ("127.0.0.1", "::1", "testclient"):
        raise HTTPException(403, "CLI endpoint is local only")
    expected = request.app.state.cli_token
    authorization = request.headers.get("authorization", "")
    supplied = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(403, "Invalid CLI token")


def create_app(data_dir: Path | None = None, start_worker: bool = True) -> FastAPI:
    directory = resolve_data_dir(data_dir)
    file_directory = files_dir(directory)
    config = load_config(directory)
    db_path = directory / "notify.db"
    db.initialize(db_path, lambda: hash_password("changeme"))
    db.housekeeping(db_path)
    token_path = directory / "cli_token"
    if not token_path.exists():
        atomic_write(token_path, secrets.token_urlsafe(32).encode())
    token_path.chmod(0o600)
    cli_token = token_path.read_text(encoding="utf-8").strip()
    vapid_path = directory / "vapid_private.pem"
    public_key = ensure_vapid(vapid_path)
    worker = PushWorker(db_path, vapid_path, config.vapid_subject)
    webhook_worker = WebhookWorker(db_path, config.public_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if start_worker:
            worker.start()
            webhook_worker.start()
        try:
            yield
        finally:
            await worker.stop()
            await webhook_worker.stop()

    app = FastAPI(lifespan=lifespan)
    app.state.db_path = db_path
    app.state.data_dir = directory
    app.state.files_dir = file_directory
    app.state.cli_token = cli_token
    app.state.worker = worker
    app.state.webhook_worker = webhook_worker
    app.state.vapid_public_key = public_key
    app.state.config = config
    app.state.login_failures = {}

    @app.middleware("http")
    async def csrf(request: Request, call_next):
        if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/cli/") and request.method != "GET":
            origin = request.headers.get("origin")
            if origin:
                try:
                    origin_host = urlsplit(origin).netloc.lower()
                except ValueError:
                    origin_host = ""
                if origin_host != request.headers.get("host", "").lower():
                    return JSONResponse({"detail": "Bad origin"}, status_code=403)
        return await call_next(request)

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/public/config")
    def public_config():
        settings = db.get_settings(db_path)
        return {"registration_open": settings["registration_open"], "invite_only": settings["invite_only"]}

    @app.post("/api/login")
    def login(body: LoginIn, request: Request, response: Response):
        ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "")
        import time
        failures = [stamp for stamp in app.state.login_failures.get(ip, []) if time.monotonic() - stamp < 600]
        app.state.login_failures[ip] = failures
        if len(failures) >= 9:
            raise HTTPException(429, "Too many login attempts")
        user = db.get_user(db_path, username=body.username)
        if not user or not check_password(body.password, user["pw_hash"]):
            failures.append(time.monotonic())
            if len(failures) > 8:
                raise HTTPException(429, "Too many login attempts")
            raise HTTPException(401, "Invalid username or password")
        if user["disabled"]:
            raise HTTPException(403, "Account disabled")
        app.state.login_failures.pop(ip, None)
        set_session(request, response, user["id"])
        return _me(app, user)

    @app.post("/api/logout")
    def logout(request: Request, response: Response):
        token = request.cookies.get(COOKIE_NAME)
        if token:
            db.delete_session(db_path, token_hash(token))
        response.delete_cookie(COOKIE_NAME, path="/")
        return {"ok": True}

    @app.post("/api/register")
    def register(body: RegisterIn, request: Request, response: Response):
        settings = db.get_settings(db_path)
        if not settings["registration_open"]:
            raise HTTPException(403, "Registration is closed")
        if settings["invite_only"] and (not settings["invite_code"] or body.invite_code != settings["invite_code"]):
            raise HTTPException(403, "Invalid invite code")
        validate_username(body.username)
        validate_password(body.password)
        try:
            user_id = db.create_user(db_path, body.username, hash_password(body.password))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Username already exists") from None
        set_session(request, response, user_id)
        return _me(app, db.get_user(db_path, user_id=user_id))

    @app.get("/api/me")
    def me(user: dict = Depends(current_user)):
        return _me(app, user)

    @app.post("/api/me/password")
    def change_password(body: PasswordIn, request: Request, user: dict = Depends(current_user)):
        if not check_password(body.current_password, user["pw_hash"]):
            raise HTTPException(400, "Current password is incorrect")
        validate_password(body.new_password)
        db.patch_user(db_path, user["id"], {"pw_hash": hash_password(body.new_password), "pw_changed_at": db.now_iso()},
                      keep_token_hash=token_hash(request.cookies[COOKIE_NAME]))
        return {"ok": True}

    @app.put("/api/me/settings")
    def change_settings(body: SettingsIn, user: dict = Depends(current_user)):
        db.patch_user(db_path, user["id"], {}, _settings_patch(body))
        return _me(app, user)

    @app.get("/api/notifications")
    def feed(view: str = "inbox", q: str = "", topic: str = "", unread: int = 0,
             before: int | None = None, limit: int = 20, page: int | None = None,
             user: dict = Depends(current_user)):
        _view(view)
        if not 1 <= limit <= 100 or unread not in (0, 1) or (page is not None and page < 1):
            raise HTTPException(422, "Invalid pagination or unread filter")
        # `page` (1-based) gives numbered pages with a total; `before` stays for cursor paging.
        offset = (page - 1) * limit if page is not None else 0
        rows = db.list_notifications(db_path, user["id"], view, q, topic, bool(unread), None if page else before, limit, offset)
        total = db.count_notifications(db_path, user["id"], view, q, topic, bool(unread)) if page is not None else None
        topics = db.notification_topics(db_path, [row["id"] for row in rows])
        return {"items": [_notification_out(row, topics[row["id"]], True) for row in rows],
                "next_before": rows[-1]["id"] if len(rows) == limit else None,
                "total": total,
                "unread": db.unread_count(db_path, user["id"])}

    @app.get("/api/notifications/{notification_id}")
    def detail(notification_id: int, user: dict = Depends(current_user)):
        row = db.notification_for_user(db_path, user["id"], notification_id)
        if not row:
            raise HTTPException(404, "Not found")
        topics = db.notification_topics(db_path, [notification_id])[notification_id]
        out = _notification_out(row, topics)
        context = notification_context(row, user["username"], config.public_url, topics)
        out["actions"] = [{"name": action["name"], "url": render(action["url"], context, True)}
                          for action in db.user_settings(db_path, user["id"])["actions"]]
        return out

    @app.post("/api/notifications/state")
    def state(body: StateIn, user: dict = Depends(current_user)):
        if body.read is None and body.archived is None:
            raise HTTPException(400, "read or archived is required")
        count = db.set_delivery_state(db_path, user["id"], body.ids, body.read, body.archived)
        return {"updated": count, "unread": db.unread_count(db_path, user["id"])}

    @app.post("/api/notifications/read-all")
    def mark_all(body: ReadAllIn | None = None, user: dict = Depends(current_user)):
        body = body or ReadAllIn()
        count = db.read_all(db_path, user["id"], _view(body.view), body.topic)
        return {"updated": count, "unread": db.unread_count(db_path, user["id"])}

    @app.get("/api/topics")
    def topics(view: str = "inbox", user: dict = Depends(current_user)):
        return {"topics": db.topic_counts(db_path, user["id"], _view(view))}

    @app.get("/api/notifications/{notification_id}/file")
    def download_file(notification_id: int, download: int = 0, user: dict = Depends(current_user)):
        row = db.notification_for_user(db_path, user["id"], notification_id)
        if not row or not row["file_path"]:
            raise HTTPException(404, "Not found")
        base = file_directory.resolve()
        target = (base / row["file_path"]).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise HTTPException(404, "Not found")
        mime = row["mime"] or "application/octet-stream"
        safe_inline = (mime.startswith("image/") and mime != "image/svg+xml") or mime == "application/pdf" or (mime.startswith("text/") and mime != "text/html")
        disposition = "attachment" if download or not safe_inline else "inline"
        response = FileResponse(target, media_type=mime, filename=row["file_name"], content_disposition_type=disposition)
        response.headers["Cache-Control"] = "private, max-age=86400"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/push/public-key")
    def push_key(user: dict = Depends(current_user)):
        return {"public_key": public_key}

    @app.post("/api/push/subscriptions")
    def subscribe(body: SubscribeIn, request: Request, user: dict = Depends(current_user)):
        try:
            endpoint_url = urlsplit(body.endpoint)
        except ValueError:
            raise HTTPException(422, "Invalid push endpoint") from None
        if endpoint_url.scheme != "https" or not endpoint_url.hostname or len(body.endpoint) > 1000:
            raise HTTPException(422, "Invalid push endpoint")
        if not body.keys.get("p256dh") or not body.keys.get("auth"):
            raise HTTPException(422, "Missing subscription keys")
        sid = db.upsert_subscription(db_path, user["id"], body.endpoint, body.keys["p256dh"], body.keys["auth"], request.headers.get("user-agent"))
        return {"ok": True, "id": sid}

    @app.delete("/api/push/subscriptions")
    def unsubscribe(body: EndpointIn, user: dict = Depends(current_user)):
        db.delete_subscription(db_path, user["id"], body.endpoint)
        return {"ok": True}

    @app.get("/api/push/subscriptions")
    def list_subscriptions(user: dict = Depends(current_user)):
        return {"items": [{key: row[key] for key in ("id", "user_agent", "created_at", "last_ok_at", "last_error", "fail_count")}
                          | {"endpoint_host": urlsplit(row["endpoint"]).hostname,
                             "service": push_service(row["endpoint"])}
                          for row in db.subscriptions(db_path, user["id"])]}

    def webhook_owner(user_id: int, caller: dict) -> dict:
        owner = db.get_user(db_path, user_id=user_id)
        if not owner:
            raise HTTPException(404, "Not found")
        if user_id != caller["id"] and not caller["is_admin"]:
            raise HTTPException(403, "Forbidden")
        return owner

    def checked_webhook(user_id: int, webhook_id: int, caller: dict) -> tuple[dict, dict]:
        owner = webhook_owner(user_id, caller)
        webhook = db.get_webhook(db_path, user_id, webhook_id)
        if not webhook:
            raise HTTPException(404, "Not found")
        return owner, webhook

    def check_webhook_json(kind: str, body: str) -> None:
        if kind == "json" and body:
            try:
                json.loads(body)
            except ValueError:
                raise HTTPException(422, "Body is not valid JSON") from None

    @app.get("/api/users/{user_id}/webhooks")
    def webhooks_list(user_id: int, caller: dict = Depends(current_user)):
        webhook_owner(user_id, caller)
        return {"items": db.list_webhooks(db_path, user_id)}

    @app.post("/api/users/{user_id}/webhooks")
    def webhooks_create(user_id: int, body: WebhookIn, caller: dict = Depends(current_user)):
        owner = webhook_owner(user_id, caller)
        check_webhook_json(body.body_kind, body.body)
        fields = _webhook_fields(body.model_dump(), bool(owner["is_admin"]))
        result = db.create_webhook(db_path, user_id, fields)
        if not result:
            raise HTTPException(422, "Too many webhooks (maximum 20)")
        return result

    @app.patch("/api/users/{user_id}/webhooks/{webhook_id}")
    def webhooks_patch(user_id: int, webhook_id: int, body: WebhookPatch, caller: dict = Depends(current_user)):
        owner, old = checked_webhook(user_id, webhook_id, caller)
        changes = body.model_dump(exclude_none=True)
        effective = {**old, **changes}
        check_webhook_json(effective["body_kind"], effective["body"])
        fields = _webhook_fields(changes, bool(owner["is_admin"]))
        return db.patch_webhook(db_path, user_id, webhook_id, fields)

    @app.delete("/api/users/{user_id}/webhooks/{webhook_id}")
    def webhooks_delete(user_id: int, webhook_id: int, caller: dict = Depends(current_user)):
        checked_webhook(user_id, webhook_id, caller)
        db.delete_webhook(db_path, user_id, webhook_id)
        return {"ok": True}

    @app.post("/api/users/{user_id}/webhooks/{webhook_id}/test")
    def webhooks_test(user_id: int, webhook_id: int, caller: dict = Depends(current_user)):
        owner, webhook = checked_webhook(user_id, webhook_id, caller)
        try:
            ok, status, error = webhook_worker.deliver({**webhook, "is_admin": owner["is_admin"]},
                                                        test_context(owner["username"], config.public_url))
        except Exception as exc:
            ok, status, error = False, None, str(exc)
        db.webhook_test_result(db_path, webhook_id, ok, error)
        return {"ok": ok, "status": status, "error": error}

    @app.post("/api/push/test")
    def test_push(body: TestPushIn | None = None, user: dict = Depends(current_user)):
        body = body or TestPushIn()
        subs = db.subscriptions(db_path, user["id"])
        ids = [row["id"] for row in subs if body.endpoint is None or row["endpoint"] == body.endpoint]
        if not ids:
            raise HTTPException(400, "No push subscription on this account")
        count, ahead = worker.enqueue_test(ids)
        return {"queued": count, "position": ahead}

    @app.get("/api/admin/users")
    def admin_users(admin: dict = Depends(require_admin)):
        return {"items": [_admin_user(app, row["id"]) for row in db.admin_users(db_path)]}

    @app.post("/api/admin/users")
    def admin_create(body: AdminCreateIn, admin: dict = Depends(require_admin)):
        validate_username(body.username)
        validate_password(body.password)
        try:
            user_id = db.create_user(db_path, body.username, hash_password(body.password), body.is_admin)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Username already exists") from None
        return _admin_user(app, user_id)

    @app.patch("/api/admin/users/{user_id}")
    def admin_patch(user_id: int, body: AdminPatchIn, request: Request, admin: dict = Depends(require_admin)):
        old = db.get_user(db_path, user_id=user_id)
        if not old:
            raise HTTPException(404, "Not found")
        fields = {}
        if body.is_admin is not None:
            fields["is_admin"] = int(body.is_admin)
        if body.disabled is not None:
            fields["disabled"] = int(body.disabled)
        if old["is_admin"] and not old["disabled"] and (fields.get("is_admin", 1) == 0 or fields.get("disabled", 0) == 1) and db.enabled_admin_count(db_path, excluding_id=user_id) == 0:
            raise HTTPException(400, "At least one active admin is required")
        if body.password is not None:
            validate_password(body.password)
            fields.update(pw_hash=hash_password(body.password), pw_changed_at=db.now_iso())
        settings = _settings_patch(body.settings, True) if body.settings else None
        keep = token_hash(request.cookies[COOKIE_NAME]) if body.password is not None and user_id == admin["id"] and not fields.get("disabled") else None
        db.patch_user(db_path, user_id, fields, settings, keep)
        return _admin_user(app, user_id)

    @app.delete("/api/admin/users/{user_id}")
    def admin_delete(user_id: int, admin: dict = Depends(require_admin)):
        if user_id == admin["id"]:
            raise HTTPException(400, "You cannot delete your own account")
        old = db.get_user(db_path, user_id=user_id)
        if not old:
            raise HTTPException(404, "Not found")
        if old["is_admin"] and not old["disabled"] and db.enabled_admin_count(db_path, excluding_id=user_id) == 0:
            raise HTTPException(400, "At least one active admin is required")
        db.delete_user(db_path, user_id)
        return {"ok": True}

    @app.get("/api/admin/routes")
    def admin_routes(admin: dict = Depends(require_admin)):
        return {"items": db.get_routes(db_path)}

    @app.put("/api/admin/routes")
    def admin_put_route(body: RouteIn, admin: dict = Depends(require_admin)):
        display = body.topic.strip().lstrip("#").strip()
        if not display or not body.user_ids or len(set(body.user_ids)) != len(body.user_ids):
            raise HTTPException(400, "Invalid route")
        known_ids = {user["id"] for user in db.all_users(db_path)}
        if any(user_id not in known_ids for user_id in body.user_ids):
            raise HTTPException(400, "Invalid route")
        db.put_route(db_path, display.casefold(), display, body.user_ids)
        return next(row for row in db.get_routes(db_path) if row["key"] == display.casefold())

    @app.delete("/api/admin/routes/{key}")
    def admin_delete_route(key: str, admin: dict = Depends(require_admin)):
        db.delete_route(db_path, key)
        return {"ok": True}

    def admin_settings_out() -> dict:
        settings = db.get_settings(db_path)
        return {key: settings[key] for key in ("registration_open", "invite_only", "invite_code", "push_interval_sec", "proxy_url", "push_proxy")} | {"push": worker.status(), "webhook": webhook_worker.status(), "vapid_public_key": public_key}

    @app.get("/api/admin/settings")
    def admin_settings(admin: dict = Depends(require_admin)):
        return admin_settings_out()

    @app.patch("/api/admin/settings")
    def admin_patch_settings(body: AdminSettingsIn, admin: dict = Depends(require_admin)):
        changes = body.model_dump(exclude_none=True)
        if "proxy_url" in changes and changes["proxy_url"]:
            try:
                parts = urlsplit(changes["proxy_url"])
                valid = parts.scheme in ("http", "https", "socks5", "socks5h") and bool(parts.hostname)
            except ValueError:
                valid = False
            if not valid:
                raise HTTPException(422, "Invalid proxy URL")
        if "push_proxy" in changes:
            unknown = set(changes["push_proxy"]) - {"google", "apple", "mozilla", "microsoft", "other"}
            if unknown:
                raise HTTPException(422, "Invalid push_proxy service")
            changes["push_proxy"] = db.get_settings(db_path)["push_proxy"] | changes["push_proxy"]
        db.set_settings(db_path, changes)
        return admin_settings_out()

    @app.get("/api/admin/delivery")
    def admin_delivery(status: str = "failed", kind: str = "all", limit: int = 50,
                       before: str | None = None, admin: dict = Depends(require_admin)):
        if status not in ("failed", "pending", "sent", "all") or kind not in ("push", "webhook", "all") or not 1 <= limit <= 200:
            raise HTTPException(422, "Invalid delivery filter")
        try:
            items, next_before = db.list_delivery(db_path, status, kind, limit, before)
        except ValueError:
            raise HTTPException(422, "Invalid cursor") from None
        return {"items": items, "next_before": next_before,
                "counts": {item: db.delivery_status(db_path, item) for item in ("push", "webhook")}}

    def wake_delivery(kind: str) -> None:
        if kind in ("push", "all"):
            worker.event.set()
        if kind in ("webhook", "all"):
            webhook_worker.event.set()

    @app.post("/api/admin/delivery/retry")
    def admin_retry_delivery(body: DeliveryRetryIn, admin: dict = Depends(require_admin)):
        result = db.retry_delivery(db_path, body.kind, body.id)
        if result == "missing":
            raise HTTPException(404, "Not found")
        if result != "ok":
            raise HTTPException(400, "Job is not failed")
        wake_delivery(body.kind)
        return {"ok": True}

    @app.post("/api/admin/delivery/retry-all")
    def admin_retry_all_delivery(body: DeliveryKindIn, admin: dict = Depends(require_admin)):
        count = db.retry_all_delivery(db_path, body.kind)
        if count:
            wake_delivery(body.kind)
        return {"retried": count}

    @app.delete("/api/admin/delivery/failed")
    def admin_clear_failed_delivery(body: DeliveryKindIn, admin: dict = Depends(require_admin)):
        return {"deleted": db.clear_failed_delivery(db_path, body.kind)}

    @app.get("/api/admin/known-topics")
    def admin_known_topics(admin: dict = Depends(require_admin)):
        return {"topics": db.known_topics(db_path)}

    @app.get("/api/cli/ping")
    def cli_ping(request: Request):
        _cli_auth(request)
        return {"ok": True}

    @app.post("/api/cli/send")
    async def cli_send(request: Request, text: str | None = Form(None), markdown: str = Form("0"),
                       type: str = Form("message"), source_path: str | None = Form(None),
                       file: UploadFile | None = File(None)):
        _cli_auth(request)
        if type not in ("message", "photo", "document") or markdown not in ("0", "1"):
            raise HTTPException(400, "Invalid notification")
        if type == "message" and not (text or "").strip():
            raise HTTPException(400, "Message text is required")
        if type != "message" and file is None:
            raise HTTPException(400, "File is required")
        file_path = file_name = mime = None
        file_size = None
        if type != "message" and file is not None:
            file_name = _safe_name(file.filename)
            relative = Path(db.now_iso()[:7]) / uuid.uuid4().hex / file_name
            target = file_directory / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            limit = 10 * 1024 * 1024 if type == "photo" else 50 * 1024 * 1024
            file_size = 0
            try:
                with target.open("wb") as stream:
                    while chunk := await file.read(1024 * 1024):
                        file_size += len(chunk)
                        if file_size > limit:
                            raise HTTPException(413, "File too large")
                        stream.write(chunk)
            except BaseException:
                target.unlink(missing_ok=True)
                raise
            file_path = relative.as_posix()
            mime = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
        pairs = extract_topics(text)
        rows, routes = db.routing_data(db_path)
        users = [UserRouting(**row) for row in rows]
        recipients = compute_recipients(text, file_name, [key for key, _ in pairs], users, routes)
        status = "success" if recipients else "skipped"
        nid = db.create_notification(db_path, {"created_at": db.now_iso(), "type": type, "text": text,
             "markdown": int(markdown), "file_path": file_path, "file_name": file_name,
             "file_size": file_size, "mime": mime, "source_path": source_path,
             "status": status, "error": None if recipients else "no recipients after filters"}, pairs, recipients)
        count = worker.enqueue_for_notification(nid, recipients)
        webhook_count = webhook_worker.enqueue_for_notification(nid, recipients, [key for key, _ in pairs])
        names = {user["id"]: user["username"] for user in db.all_users(db_path)}
        return {"id": nid, "status": status, "recipients": [names[user_id] for user_id in recipients],
                "push_jobs": count, "webhook_jobs": webhook_count}

    @app.get("/assets/{path:path}")
    def assets(path: str):
        target = (DIST_DIR / "assets" / path).resolve()
        base = (DIST_DIR / "assets").resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise HTTPException(404, "Not found")
        response = FileResponse(target)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found")
        if not DIST_DIR.is_dir():
            return PlainTextResponse("frontend not built") if not path else PlainTextResponse("frontend not built", status_code=404)
        target = (DIST_DIR / path).resolve()
        base = DIST_DIR.resolve()
        if path and target.is_relative_to(base) and target.is_file():
            response = FileResponse(target)
            if path in ("sw.js", "manifest.webmanifest"):
                response.headers["Cache-Control"] = "no-cache"
                if path == "sw.js":
                    response.headers["Service-Worker-Allowed"] = "/"
            return response
        response = FileResponse(DIST_DIR / "index.html")
        response.headers["Cache-Control"] = "no-cache"
        return response

    return app
