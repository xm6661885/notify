from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from server import db
from server.push import PushWorker, push_service
from server.webhooks import WebhookWorker, notification_context, render, render_request, send_webhook


def hook(name="hook", **overrides):
    return {"name": name, "url": "http://127.0.0.1/hook", "method": "POST", "headers": "{}",
            "body_kind": "json", "body": "", "enabled": 1, "use_proxy": 0, "topics": "[]"} | overrides


def test_templates_context_and_response_rules():
    context = {"text": "hello world", "user": "a b"}
    assert render("{{ text:6 }} {{missing}}", context) == "hello… {{missing}}"
    assert render("/{{user}}", context, True) == "/a%20b"
    url, headers, payload = render_request(hook(url="https://example.org/{{user}}", headers={"X-Test": "{{text}}"},
                                           body='{"value":"{{text}}","ok":true,"n":3}'), context)
    assert url == "https://example.org/a%20b" and headers["X-Test"] == "hello world"
    assert payload["json"] == {"value": "hello world", "ok": True, "n": 3}
    assert render_request(hook(method="GET", body="ignored"), context)[2] == {}
    assert render_request(hook(body_kind="text", body=""), context)[2] == {"data": b"hello world"}
    base = {"id": 4, "type": "photo", "text": None, "file_name": "cat.png", "created_at": "now"}
    assert notification_context(base, "admin", "https://n.example", ["cat"])["text"] == "Image: cat.png"
    assert notification_context(base | {"text": "caption"}, "admin", "https://n.example", [])["text"] == "caption\nImage: cat.png"
    assert notification_context(base | {"type": "document", "file_name": "a.pdf"}, "admin", "https://n.example", [])["text"] == "File: a.pdf"
    assert notification_context(base | {"type": "document", "file_name": "a.pdf", "text": "caption"}, "admin", "https://n.example", [])["text"] == "caption\nFile: a.pdf"

    class Session:
        def __init__(self, body):
            self.body = body

        def request(self, *args, **kwargs):
            assert kwargs["timeout"] == 20 and kwargs["allow_redirects"] is False
            return SimpleNamespace(status_code=200, json=lambda: self.body, text="reply")

    assert send_webhook(Session({"ok": False}), "POST", "https://example.org", {}, {})[0] is False
    assert send_webhook(Session({"retcode": 1}), "POST", "https://example.org", {}, {})[0] is False
    assert send_webhook(Session({"retcode": "0"}), "POST", "https://example.org", {}, {})[0] is True
    assert [push_service("https://" + host + "/x") for host in
            ("FCM.GOOGLEAPIS.COM", "a.push.apple.com", "push.services.mozilla.com", "notify.windows.com", "example.org")] == [
                "google", "apple", "mozilla", "microsoft", "other"]


def test_webhook_api_and_settings(admin, app, monkeypatch):
    monkeypatch.setattr("server.app.public_url", lambda url: not url.startswith("http://127.0.0.1"))
    bob_id = admin.post("/api/admin/users", json={"username": "bob", "password": "pass"}).json()["id"]
    other_id = admin.post("/api/admin/users", json={"username": "other", "password": "pass"}).json()["id"]
    bob = TestClient(app, backend_options={"use_uvloop": True})
    bob.post("/api/login", json={"username": "bob", "password": "pass"})
    other = TestClient(app, backend_options={"use_uvloop": True})
    other.post("/api/login", json={"username": "other", "password": "pass"})
    path = f"/api/users/{bob_id}/webhooks"
    assert bob.post(path, json={"name": "local", "url": "http://127.0.0.1/"}).status_code == 422
    assert bob.post(path, json={"name": "bad", "url": "https://example.org", "method": "DELETE"}).status_code == 422
    assert bob.post(path, json={"name": "bad", "url": "https://example.org", "body": "{"}).status_code == 422
    assert bob.post(path, json={"name": "bad", "url": "https://example.org", "headers": {"bad_name": "x"}}).status_code == 422
    created = bob.post(path, json={"name": " One ", "url": "https://example.org", "topics": [" #News ", "news", "#ALERT"]})
    assert created.status_code == 200, created.text
    item = created.json()
    assert item["name"] == "One" and item["topics"] == ["News", "ALERT"]
    assert other.get(path).status_code == 403 and other.patch(f"{path}/{item['id']}", json={"name": "x"}).status_code == 403
    assert admin.get(path).json()["items"][0]["id"] == item["id"]
    assert admin.patch(f"{path}/{item['id']}", json={"method": "put"}).json()["method"] == "PUT"
    local = admin.post("/api/users/1/webhooks", json={"name": "local", "url": "http://127.0.0.1/"})
    assert local.status_code == 200
    app.state.webhook_worker.send_fn = lambda session, method, url, headers, payload: (
        payload["json"]["text"] == "Test notification from Notify", 200, None)
    assert admin.post(f"/api/users/1/webhooks/{local.json()['id']}/test").json() == {"ok": True, "status": 200, "error": None}
    app.state.webhook_worker.send_fn = lambda *args: (False, 500, "test failed")
    assert admin.post(f"/api/users/1/webhooks/{local.json()['id']}/test").json()["ok"] is False
    assert db.get_webhook(app.state.db_path, 1, local.json()["id"])["fail_count"] == 1
    assert admin.get("/api/admin/users").json()["items"][1]["webhooks"] == 1
    assert admin.patch("/api/admin/settings", json={"push_proxy": {"apple": True}, "proxy_url": "socks5h://localhost:1080"}).json()["push_proxy"] == {
        "google": True, "apple": True, "mozilla": False, "microsoft": False, "other": False}
    assert admin.patch("/api/admin/settings", json={"push_proxy": {"wrong": True}}).status_code == 422
    assert admin.patch("/api/admin/settings", json={"proxy_url": "ftp://example.org"}).status_code == 422
    assert admin.delete(f"{path}/{item['id']}").json() == {"ok": True}
    assert bob.get(path).json()["items"] == []
    assert admin.get(f"/api/users/{other_id}/webhooks").status_code == 200


@pytest.mark.asyncio
async def test_enqueue_and_webhook_worker(admin, app, cli_headers, monkeypatch):
    path = app.state.db_path
    bob_id = admin.post("/api/admin/users", json={"username": "bob", "password": "pass"}).json()["id"]
    db.patch_user(path, bob_id, {}, {"blacklist": ["BLOCK"]})
    wid = db.create_webhook(path, 1, hook())["id"]
    filtered = db.create_webhook(path, 1, hook("filtered", topics='["news"]'))["id"]
    unmatched = db.create_webhook(path, 1, hook("unmatched", topics='["other"]'))["id"]
    db.create_webhook(path, 1, hook("disabled", enabled=0))
    db.create_webhook(path, bob_id, hook("bob", url="https://example.org"))
    result = admin.post("/api/cli/send", data={"text": "#news BLOCK", "type": "message"}, headers=cli_headers).json()
    assert result["recipients"] == ["admin"] and result["webhook_jobs"] == 2
    with db.connection(path) as conn:
        assert {row[0] for row in conn.execute("SELECT webhook_id FROM webhook_jobs")} == {wid, filtered}
        assert unmatched not in {row[0] for row in conn.execute("SELECT webhook_id FROM webhook_jobs")}
    events = [(True, 200, None), (False, 500, "server"), (False, 500, "server"), (False, 500, "server"),
              (False, 400, "bad")]
    worker = WebhookWorker(path, "https://notify.example", lambda *args: events.pop(0))
    assert await worker.process_one()
    assert db.get_webhook(path, 1, wid)["last_ok_at"]
    assert await worker.process_one()
    for _ in range(2):
        with db.connection(path) as conn:
            conn.execute("UPDATE webhook_jobs SET not_before=0 WHERE status='pending'")
        assert await worker.process_one()
    assert db.delivery_status(path, "webhook")["failed_24h"] == 1
    nid = result["id"]
    db.enqueue_webhooks(path, nid, [1], ["news"])
    with db.connection(path) as conn:
        conn.execute("UPDATE webhooks SET enabled=0 WHERE id=?", (filtered,))
    assert await worker.process_one()  # 400 on the first newly queued job
    assert await worker.process_one()  # disabled job
    with db.connection(path) as conn:
        rows = conn.execute("SELECT status,error FROM webhook_jobs ORDER BY id").fetchall()
    assert rows[-2]["status"] == "failed" and rows[-1]["error"] == "disabled"


@pytest.mark.asyncio
async def test_push_proxy_and_admin_delivery(admin, app, cli_headers):
    path = app.state.db_path
    admin.patch("/api/admin/settings", json={"push_interval_sec": 0, "proxy_url": "http://localhost:7890"})
    sid = db.upsert_subscription(path, 1, "https://fcm.googleapis.com/x", "key", "auth", None)
    nid = admin.post("/api/cli/send", data={"text": "hello", "type": "message"}, headers=cli_headers).json()["id"]
    sessions = []
    def fake_push(**kwargs):
        sessions.append(kwargs["requests_session"])
        return SimpleNamespace(status_code=500)
    push = PushWorker(path, app.state.data_dir / "vapid_private.pem", "mailto:test@example.org", fake_push)
    assert await push.process_one()
    assert sessions[0].proxies == {"http": "http://localhost:7890", "https": "http://localhost:7890"}
    assert sessions[0].trust_env is False
    admin.patch("/api/admin/settings", json={"push_proxy": {"google": False}})
    with db.connection(path) as conn:
        conn.execute("UPDATE push_jobs SET not_before=0")
    assert await push.process_one()
    assert sessions[1] is push.session and not sessions[1].trust_env
    with db.connection(path) as conn:
        conn.execute("UPDATE push_jobs SET status='failed',attempts=3,error='push failed' WHERE subscription_id=?", (sid,))
    whid = db.create_webhook(path, 1, hook("delivery"))["id"]
    db.enqueue_webhooks(path, nid, [1], [])
    with db.connection(path) as conn:
        conn.execute("UPDATE webhook_jobs SET status='failed',attempts=3,error='webhook failed' WHERE webhook_id=?", (whid,))
    listing = admin.get("/api/admin/delivery", params={"limit": 1}).json()
    assert len(listing["items"]) == 1 and listing["next_before"]
    second = admin.get("/api/admin/delivery", params={"limit": 1, "before": listing["next_before"]}).json()
    assert len(second["items"]) == 1 and {listing["items"][0]["kind"], second["items"][0]["kind"]} == {"push", "webhook"}
    job = listing["items"][0]
    assert admin.post("/api/admin/delivery/retry", json={"kind": job["kind"], "id": job["id"]}).json() == {"ok": True}
    assert admin.post("/api/admin/delivery/retry", json={"kind": job["kind"], "id": job["id"]}).status_code == 400
    assert admin.post("/api/admin/delivery/retry", json={"kind": job["kind"], "id": 99999}).status_code == 404
    assert admin.post("/api/admin/delivery/retry-all", json={"kind": "all"}).json() == {"retried": 1}
    with db.connection(path) as conn:
        conn.execute("UPDATE push_jobs SET status='failed' WHERE subscription_id=?", (sid,))
    assert admin.request("DELETE", "/api/admin/delivery/failed", json={"kind": "all"}).json() == {"deleted": 1}
