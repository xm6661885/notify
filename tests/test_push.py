import asyncio
import json
from types import SimpleNamespace

import pytest

from server import db
from server.push import PushWorker, build_payload


def add_job(app):
    path = app.state.db_path
    sid = db.upsert_subscription(path, 1, "https://push.example/one", "p256dh", "auth", "browser")
    nid = db.create_notification(path, {"created_at": db.now_iso(), "type": "message", "text": "Hi\nSecond line", "markdown": 0, "status": "success"}, [], [1])
    db.enqueue_jobs(path, nid, [sid], build_payload(db.notification(path, nid)))
    return sid, nid


def test_payload_rules():
    assert json.loads(build_payload({"id": 1, "type": "message", "text": "*Head*\n[link](url) body", "markdown": 1}))["body"] == "link body"
    assert json.loads(build_payload({"id": 2, "type": "photo", "text": None, "file_name": "猫.jpg"}))["body"] == "Image: 猫.jpg"
    assert json.loads(build_payload({"id": 3, "type": "document", "text": None, "file_name": "a.pdf"}))["body"] == "File: a.pdf"
    assert len(json.loads(build_payload({"id": 4, "type": "message", "text": "a" * 300}))["body"]) <= 240


@pytest.mark.asyncio
async def test_worker_spacing_and_interval_change(app):
    path = app.state.db_path
    sid, nid = add_job(app)
    db.enqueue_jobs(path, nid, [sid, sid], build_payload(db.notification(path, nid)))
    clock = [100.0]
    starts = []
    running = [False]

    async def fake_sleep(delay):
        clock[0] += delay

    def fake_send(**kwargs):
        assert not running[0]
        running[0] = True
        starts.append(clock[0])
        running[0] = False
        return SimpleNamespace(status_code=201)

    worker = PushWorker(path, app.state.data_dir / "vapid_private.pem", "mailto:test@example.com", fake_send,
                        lambda: clock[0], fake_sleep)
    assert await worker.process_one()
    assert await worker.process_one()
    db.set_settings(path, {"push_interval_sec": 2})
    assert await worker.process_one()
    assert starts == [100.0, 105.0, 107.0]
    assert worker.status()["sent_24h"] == 3


@pytest.mark.asyncio
async def test_worker_gone_retry_and_test_queue(app, client):
    path = app.state.db_path
    sid, nid = add_job(app)
    events = [410]

    def fake_send(**kwargs):
        return SimpleNamespace(status_code=events.pop(0))

    worker = PushWorker(path, app.state.data_dir / "vapid_private.pem", "mailto:test@example.com", fake_send,
                        sleep_fn=lambda delay: asyncio.sleep(0))
    assert await worker.process_one()
    assert db.subscriptions(path, 1) == []
    sid = db.upsert_subscription(path, 1, "https://push.example/two", "p256dh", "auth", None)
    db.enqueue_jobs(path, nid, [sid], build_payload(db.notification(path, nid)))
    events[:] = [500, 500, 500]
    for attempt in range(3):
        assert await worker.process_one()
        if attempt < 2:
            with db.connection(path) as conn:
                conn.execute("UPDATE push_jobs SET not_before=0 WHERE status='pending'")
    assert db.push_status(path)["failed_24h"] == 1
    assert db.subscriptions(path, 1)[0]["fail_count"] == 3
    client.post("/api/login", json={"username": "admin", "password": "changeme"})
    result = client.post("/api/push/test", json={})
    assert result.status_code == 200 and result.json()["queued"] == 1
    assert client.post("/api/push/test").status_code == 200
    listing = client.get("/api/push/subscriptions").json()["items"]
    assert listing[0]["endpoint_host"] == "push.example"
    assert "endpoint" not in listing[0]
