"""Text webhook rendering and serial delivery."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
import socket
import time
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlsplit

import requests

from . import db
from .push import title_body

log = logging.getLogger(__name__)
PLACEHOLDER = re.compile(r"\{\{\s*([a-z_]+)(?::(\d+))?\s*\}\}")
PUBLIC_URL_ERROR = "Webhook URL must point to a public address"


def public_url(url: str) -> bool:
    try:
        host = urlsplit(url).hostname
        if not host:
            return False
        addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        return bool(addresses) and all(ipaddress.ip_address(item[4][0]).is_global for item in addresses)
    except (OSError, ValueError):
        return False


def render(value: str, context: dict[str, str], encode: bool = False) -> str:
    def replace(match: re.Match) -> str:
        name, length = match.groups()
        if name not in context:
            return match.group(0)
        result = context[name]
        if length is not None:
            n = int(length)
            if len(result) > n:
                result = result[:n - 1] + "…" if n else ""
        return quote(result, safe="") if encode else result
    return PLACEHOLDER.sub(replace, value)


def notification_context(notification: dict, username: str, public_base: str, topics: list[str]) -> dict[str, str]:
    text = notification.get("text") or ""
    file_name = notification.get("file_name") or ""
    if file_name:
        label = ("Image: " if notification["type"] == "photo" else "File: ") + file_name
        text = text + "\n" + label if text else label
    title, body = title_body(notification)
    return {"text": text, "title": title, "body": body, "id": str(notification["id"]),
            "type": notification["type"], "file_name": file_name,
            "topics": " ".join("#" + topic for topic in topics), "time": notification["created_at"],
            "user": username, "url": public_base.rstrip("/") + f"/n/{notification['id']}"}


def test_context(username: str, public_base: str) -> dict[str, str]:
    text = "Test notification from Notify"
    return {"text": text, "title": "Notify", "body": text, "id": "0", "type": "message",
            "file_name": "", "topics": "", "time": db.now_iso(), "user": username,
            "url": public_base.rstrip("/") + "/"}


def render_request(webhook: dict, context: dict[str, str]) -> tuple[str, dict[str, str], dict]:
    url = render(webhook["url"], context, True)
    source_headers = webhook["headers"] if isinstance(webhook["headers"], dict) else json.loads(webhook["headers"])
    headers = {key: render(value, context) for key, value in source_headers.items()}
    payload = {}
    if webhook["method"] == "GET":
        return url, headers, payload
    body = webhook["body"]
    if webhook["body_kind"] == "json":
        def substitute(value):
            if isinstance(value, str):
                return render(value, context)
            if isinstance(value, list):
                return [substitute(item) for item in value]
            if isinstance(value, dict):
                return {key: substitute(item) for key, item in value.items()}
            return value
        payload["json"] = substitute(json.loads(body)) if body else {"text": context["text"]}
    else:
        if not any(key.lower() == "content-type" for key in headers):
            headers["Content-Type"] = "text/plain; charset=utf-8"
        payload["data"] = (render(body, context) if body else context["text"]).encode("utf-8")
    return url, headers, payload


def send_webhook(session: requests.Session, method: str, url: str, headers: dict[str, str], payload: dict) -> tuple[bool, int | None, str | None]:
    try:
        response = session.request(method, url, headers=headers, timeout=20, allow_redirects=False, **payload)
        status = response.status_code
        try:
            result = response.json()
        except ValueError:
            result = None
        bad_json = isinstance(result, dict) and (result.get("ok") is False or result.get("status") == "failed" or result.get("retcode") not in (None, 0, "0"))
        if 200 <= status < 300 and not bad_json:
            return True, status, None
        error = result.get("message") or result.get("wording") or str(result) if isinstance(result, dict) else f"HTTP {status}: {response.text[:300]}"
        return False, status, str(error)[:500]
    except requests.RequestException as exc:
        return False, None, str(exc)[:500]


class WebhookWorker:
    def __init__(self, db_path: Path, public_base: str, send_fn: Callable = send_webhook,
                 sleep_fn: Callable = asyncio.sleep):
        self.db_path = db_path
        self.public_base = public_base
        self.send_fn = send_fn
        self.sleep_fn = sleep_fn
        self.event = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.session = requests.Session()
        self.session.trust_env = False
        self.proxy_sessions: dict[str, requests.Session] = {}

    def session_for(self, webhook: dict) -> requests.Session:
        proxy = db.get_settings(self.db_path)["proxy_url"] if webhook["use_proxy"] else ""
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

    def enqueue_for_notification(self, notification_id: int, user_ids: list[int], topics: list[str]) -> int:
        count = db.enqueue_webhooks(self.db_path, notification_id, user_ids, topics)
        if count:
            self.event.set()
        return count

    def status(self) -> dict:
        return db.delivery_status(self.db_path, "webhook")

    def deliver(self, webhook: dict, context: dict[str, str]) -> tuple[bool, int | None, str | None]:
        if not webhook["is_admin"] and not public_url(webhook["url"]):
            return False, None, PUBLIC_URL_ERROR
        url, headers, payload = render_request(webhook, context)
        return self.send_fn(self.session_for(webhook), webhook["method"], url, headers, payload)

    async def process_one(self) -> bool:
        job = db.next_webhook_job(self.db_path, time.time())
        if not job:
            return False
        if not job["enabled"]:
            db.webhook_result(self.db_path, job, False, "disabled", True)
            return True
        notification = {"id": job["notification_id"], "type": job["type"], "text": job["text"],
                        "markdown": job["markdown"], "file_name": job["file_name"], "created_at": job["notification_time"]}
        topics = db.notification_topics(self.db_path, [job["notification_id"]])[job["notification_id"]]
        context = notification_context(notification, job["username"], self.public_base, topics)
        try:
            ok, status, error = await asyncio.to_thread(self.deliver, job, context)
        except Exception as exc:
            ok, status, error = False, None, str(exc)
            log.warning("Webhook job %s failed: %s", job["id"], exc)
        permanent = error == PUBLIC_URL_ERROR or (status is not None and 400 <= status <= 499 and status not in (408, 429))
        db.webhook_result(self.db_path, job, ok, error, permanent)
        return True

    async def run(self) -> None:
        while True:
            try:
                if await self.process_one():
                    continue
                self.event.clear()
                if db.next_webhook_job(self.db_path, time.time()):
                    continue
                try:
                    await asyncio.wait_for(self.event.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Webhook worker loop error")
                await self.sleep_fn(1)
