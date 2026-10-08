"""Persistent, serial Web Push queue."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid01
import requests
from pywebpush import webpush

from . import db

log = logging.getLogger(__name__)


def ensure_vapid(path: Path) -> str:
    if not path.exists():
        vapid = Vapid01()
        vapid.generate_keys()
        vapid.save_key(str(path))
    path.chmod(0o600)
    vapid = Vapid01.from_file(str(path))
    point = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(point).rstrip(b"=").decode("ascii")


def _clip(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1] + "…"


def title_body(notification: dict) -> tuple[str, str]:
    text = notification.get("text") or ""
    if notification.get("markdown"):
        text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
        text = text.translate(str.maketrans("", "", "*_`"))
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) >= 2:
        title, body = _clip(lines[0], 80), _clip("\n".join(lines[1:]), 240)
    else:
        title, body = "Notify", _clip(text.strip(), 240)
    if not text.strip() and notification.get("type") in ("photo", "document"):
        prefix = "Image" if notification["type"] == "photo" else "File"
        body = _clip(f"{prefix}: {notification.get('file_name') or 'file'}", 240)
    return title, body


def build_payload(notification: dict) -> str:
    title, body = title_body(notification)
    nid = notification["id"]
    payload = {"id": nid, "title": title, "body": body, "url": f"/n/{nid}", "tag": f"n-{nid}"}
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def push_service(endpoint: str) -> str:
    host = (urlsplit(endpoint).hostname or "").lower()
    if host == "fcm.googleapis.com" or host.endswith(".googleapis.com"):
        return "google"
    if host.endswith("push.apple.com"):
        return "apple"
    if host.endswith("push.services.mozilla.com"):
        return "mozilla"
    if host.endswith("notify.windows.com"):
        return "microsoft"
    return "other"


def test_payload() -> str:
    return json.dumps({"id": 0, "title": "Notify", "body": "Test notification. Push is working on this device.", "url": "/settings", "tag": f"test-{int(time.time() * 1000)}"}, separators=(",", ":"))


class PushWorker:
    def __init__(self, db_path: Path, vapid_path: Path, vapid_subject: str,
                 send_fn: Callable | None = None, time_fn: Callable[[], float] = time.monotonic,
                 sleep_fn: Callable = asyncio.sleep):
        self.db_path = db_path
        self.vapid_path = vapid_path
        self.vapid_subject = vapid_subject
        self.send_fn = send_fn or webpush
        self.time_fn = time_fn
        self.sleep_fn = sleep_fn
        self.event = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.last_request_started: float | None = None
        self.session = requests.Session()
        self.session.trust_env = False
        self.proxy_sessions: dict[str, requests.Session] = {}

    def session_for(self, endpoint: str, settings: dict) -> requests.Session:
        proxy = settings["proxy_url"] if settings["push_proxy"].get(push_service(endpoint), False) else ""
        if not proxy:
            return self.session
        if proxy not in self.proxy_sessions:
            session = requests.Session()
            session.trust_env = False
            session.proxies = {"http": proxy, "https": proxy}
            self.proxy_sessions[proxy] = session
        return self.proxy_sessions[proxy]

    def start(self) -> None:
        if not self.task:
            self.task = asyncio.create_task(self.run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None

    def enqueue_for_notification(self, notification_id: int, user_ids: list[int]) -> int:
        notification = db.notification(self.db_path, notification_id)
        ids = db.subscription_ids_for_users(self.db_path, user_ids)
        count, _ = db.enqueue_jobs(self.db_path, notification_id, ids, build_payload(notification)) if ids else (0, 0)
        if count:
            self.event.set()
        return count

    def enqueue_test(self, subscription_ids: list[int]) -> tuple[int, int]:
        result = db.enqueue_jobs(self.db_path, None, subscription_ids, test_payload())
        self.event.set()
        return result

    def status(self) -> dict:
        return {**db.push_status(self.db_path), "interval": float(db.get_settings(self.db_path)["push_interval_sec"])}

    async def process_one(self) -> bool:
        job = db.next_push_job(self.db_path, time.time())
        if not job:
            return False
        settings = db.get_settings(self.db_path)
        interval = float(settings["push_interval_sec"])
        if self.last_request_started is not None:
            wait = self.last_request_started + interval - self.time_fn()
            if wait > 0:
                await self.sleep_fn(wait)
        self.last_request_started = self.time_fn()
        info = {"endpoint": job["endpoint"], "keys": {"p256dh": job["p256dh"], "auth": job["auth"]}}
        try:
            result = await asyncio.to_thread(self.send_fn, subscription_info=info,
                data=job["payload"], vapid_private_key=str(self.vapid_path),
                vapid_claims={"sub": self.vapid_subject}, ttl=86400,
                headers={"Urgency": "high"}, timeout=20, requests_session=self.session_for(job["endpoint"], settings))
            status = getattr(result, "status_code", 201)
            if 200 <= status < 300:
                db.push_sent(self.db_path, job)
            elif status in (404, 410):
                db.push_gone(self.db_path, job)
            else:
                db.push_failed(self.db_path, job, f"HTTP {status}", status in (400, 413))
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            try:
                if status in (404, 410):
                    db.push_gone(self.db_path, job)
                else:
                    db.push_failed(self.db_path, job, str(exc), status in (400, 413))
            except Exception:
                log.exception("Could not update push job %s", job["id"])
            log.warning("Push job %s failed: %s", job["id"], exc)
        return True

    async def run(self) -> None:
        last_housekeeping = 0.0
        while True:
            try:
                if time.time() - last_housekeeping >= 86400:
                    db.housekeeping(self.db_path)
                    last_housekeeping = time.time()
                if await self.process_one():
                    continue
                self.event.clear()
                # Recheck after clear so an enqueue between SELECT and clear is not lost.
                if db.next_push_job(self.db_path, time.time()):
                    continue
                try:
                    await asyncio.wait_for(self.event.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Push worker loop error")
                await self.sleep_fn(1)
