from pathlib import Path

from fastapi.testclient import TestClient

from server import db


def send(client, headers, text=None, kind="message", filename=None, content=b"abc", source=None, markdown="0"):
    form = {"type": kind, "markdown": markdown}
    if text is not None:
        form["text"] = text
    if source:
        form["source_path"] = source
    files = {"file": (filename or "a.txt", content)} if kind != "message" else None
    return client.post("/api/cli/send", data=form, files=files, headers=headers)


def test_auth_and_registration(client, app):
    assert client.get("/api/health").json() == {"ok": True}
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/register", json={"username": "bob", "password": "pass"}).status_code == 403
    assert client.post("/api/login", json={"username": "admin", "password": "wrong"}).status_code == 401
    for _ in range(8):
        result = client.post("/api/login", json={"username": "admin", "password": "wrong"})
    assert result.status_code == 429
    # A fresh IP still works.
    result = client.post("/api/login", json={"username": "admin", "password": "changeme"}, headers={"X-Real-IP": "127.0.0.2"})
    assert result.status_code == 200
    assert result.json()["user"]["is_admin"] is True
    assert client.get("/api/me").status_code == 200
    other = TestClient(app, backend_options={"use_uvloop": True})
    assert other.post("/api/login", json={"username": "admin", "password": "changeme"}, headers={"X-Real-IP": "127.0.0.3"}).status_code == 200
    assert client.post("/api/me/password", json={"current_password": "bad", "new_password": "newpass"}).status_code == 400
    assert client.post("/api/me/password", json={"current_password": "changeme", "new_password": "newpass"}).status_code == 200
    assert client.get("/api/me").status_code == 200
    assert other.get("/api/me").status_code == 401
    assert client.post("/api/logout").status_code == 200
    assert client.get("/api/me").status_code == 401


def test_admin_registration_users_routes_settings(admin, app):
    assert admin.post("/api/register", json={"username": "bob", "password": "pass"}).status_code == 403
    assert admin.patch("/api/admin/settings", json={"registration_open": True, "invite_only": True, "invite_code": "invite"}).status_code == 200
    assert admin.patch("/api/admin/settings", json={"push_interval_sec": 601}).status_code in (400, 422)
    assert admin.post("/api/register", json={"username": "bob", "password": "pass", "invite_code": "bad"}).status_code == 403
    assert admin.post("/api/register", json={"username": "bob", "password": "pass", "invite_code": "invite"}).status_code == 200
    assert admin.post("/api/register", json={"username": "BOB", "password": "pass", "invite_code": "invite"}).status_code == 409
    # Registration logged in as Bob; use a separate admin client.
    root = TestClient(app, backend_options={"use_uvloop": True})
    assert root.post("/api/login", json={"username": "admin", "password": "changeme"}).status_code == 200
    new = root.post("/api/admin/users", json={"username": "alice", "password": "pass", "is_admin": True}).json()
    assert new["settings"]["topics"] == []
    uid = new["id"]
    assert root.patch(f"/api/admin/users/{uid}", json={"settings": {"admin_blacklist": ["SECRET"]}}).json()["settings"]["admin_blacklist"] == ["SECRET"]
    assert root.put("/api/admin/routes", json={"topic": "#Deploy", "user_ids": [uid]}).json()["users"] == ["alice"]
    assert root.get("/api/admin/routes").json()["items"][0]["key"] == "deploy"
    assert "Deploy" in root.get("/api/admin/known-topics").json()["topics"]
    assert root.delete(f"/api/admin/users/{uid}").status_code == 200
    assert root.get("/api/admin/routes").json()["items"] == []
    # Check last-admin guard with an authenticated root session before the update.
    check = TestClient(app, backend_options={"use_uvloop": True})
    check.post("/api/login", json={"username": "admin", "password": "changeme"})
    assert check.patch("/api/admin/users/1", json={"disabled": True}).status_code == 400
    assert check.delete("/api/admin/users/1").status_code == 400


def test_settings_disabled_and_origin(admin, app):
    created = admin.post("/api/admin/users", json={"username": "bob", "password": "pass"}).json()
    uid = created["id"]
    bob = TestClient(app, backend_options={"use_uvloop": True})
    assert bob.post("/api/login", json={"username": "bob", "password": "pass"}).status_code == 200
    assert bob.put("/api/me/settings", json={"feed_topics": ["#Ops", "ops", "News"]}).json()["settings"]["feed_topics"] == ["Ops", "News"]
    bob.put("/api/me/settings", json={"feed_topics": []})
    result = bob.put("/api/me/settings", json={"topics_mode": "only", "topics": [" #Deploy ", "deploy", ""], "blacklist": [" SPAM ", "spam"], "admin_blacklist": ["hacked"]})
    assert result.json()["settings"] == {"topics_mode": "only", "topics": ["Deploy"], "blacklist": ["SPAM"], "admin_blacklist": [], "feed_topics": [], "actions": []}
    assert bob.post("/api/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert admin.patch(f"/api/admin/users/{uid}", json={"password": "newpass"}).status_code == 200
    assert bob.get("/api/me").status_code == 401
    assert bob.post("/api/login", json={"username": "bob", "password": "newpass"}).status_code == 200
    assert admin.patch(f"/api/admin/users/{uid}", json={"disabled": True}).status_code == 200
    assert bob.get("/api/me").status_code == 401
    assert bob.post("/api/login", json={"username": "bob", "password": "newpass"}).status_code == 403


def test_feed_files_and_filters(admin, app, cli_headers, tmp_path: Path):
    created = admin.post("/api/admin/users", json={"username": "bob", "password": "pass"}).json()
    bob_id = created["id"]
    admin.put("/api/admin/routes", json={"topic": "Private", "user_ids": [1]})
    assert send(admin, {}, "hello").status_code == 403
    assert send(admin, cli_headers | {"X-Real-IP": "127.0.0.1"}, "hello").status_code == 403
    first = send(admin, cli_headers, "#Deploy first").json()["id"]
    second = send(admin, cli_headers, "#Deploy " + "x" * 620).json()["id"]
    private = send(admin, cli_headers, "#Private hidden", kind="document", filename="private.pdf").json()["id"]
    photo = send(admin, cli_headers, kind="photo", filename="猫.png", content=b"png").json()["id"]
    html = send(admin, cli_headers, kind="document", filename="page.html", content=b"<script>x</script>").json()["id"]
    assert (tmp_path / "files").exists()
    assert db.notification(app.state.db_path, photo)["file_path"]
    assert admin.get("/api/notifications", params={"limit": 2}).json()["next_before"] == photo
    assert admin.get("/api/notifications", params={"before": html}).json()["items"][0]["id"] == photo
    p2 = admin.get("/api/notifications", params={"limit": 2, "page": 2}).json()
    assert p2["total"] >= 3 and p2["items"] == admin.get("/api/notifications", params={"limit": 2, "before": photo}).json()["items"]
    assert admin.get("/api/notifications", params={"page": 0}).status_code == 422
    assert admin.get("/api/notifications", params={"q": "#deploy"}).json()["items"][0]["id"] == second
    assert admin.get("/api/notifications", params={"topic": "deploy"}).json()["items"][0]["id"] == second
    assert admin.get("/api/notifications", params={"q": "x" * 5}).json()["items"][0]["truncated"] is True
    assert len(admin.get(f"/api/notifications/{second}").json()["text"]) > 600
    assert admin.get("/api/topics").json()["topics"][0]["key"] in ("deploy", "private")
    assert admin.post("/api/notifications/state", json={"ids": [first], "read": True, "archived": True}).json()["updated"] == 1
    assert first not in [item["id"] for item in admin.get("/api/notifications").json()["items"]]
    assert first in [item["id"] for item in admin.get("/api/notifications", params={"view": "archived"}).json()["items"]]
    assert admin.post("/api/notifications/state", json={"ids": [first], "read": False, "archived": False}).json()["updated"] == 1
    assert admin.post("/api/notifications/read-all", json={"topic": "deploy"}).json()["updated"] == 2
    assert admin.post("/api/notifications/read-all").status_code == 200
    inline = admin.get(f"/api/notifications/{photo}/file")
    assert inline.status_code == 200 and inline.headers["content-disposition"].startswith("inline")
    assert "filename*=utf-8''" in inline.headers["content-disposition"].lower()
    assert admin.get(f"/api/notifications/{photo}/file?download=1").headers["content-disposition"].startswith("attachment")
    assert admin.get(f"/api/notifications/{html}/file").headers["content-disposition"].startswith("attachment")
    bob = TestClient(app, backend_options={"use_uvloop": True})
    bob.post("/api/login", json={"username": "bob", "password": "pass"})
    assert bob.get(f"/api/notifications/{private}").status_code == 404
    assert bob.get(f"/api/notifications/{private}/file").status_code == 404
    assert bob_id in [row["user_id"] for row in _deliveries(app.state.db_path, first)]
    big = send(admin, cli_headers, kind="photo", filename="large.jpg", content=b"0" * (10 * 1024 * 1024 + 1))
    assert big.status_code == 413


def _deliveries(path, nid):
    with db.connection(path) as conn:
        return conn.execute("SELECT * FROM deliveries WHERE notification_id=?", (nid,)).fetchall()


def test_custom_actions(admin, cli_headers):
    bad = admin.put("/api/me/settings", json={"actions": [{"name": "x", "url": "javascript:alert(1)"}]})
    assert bad.status_code == 422
    assert admin.put("/api/me/settings", json={"actions": [{"name": "x", "url": "no scheme"}]}).status_code == 422
    saved = admin.put("/api/me/settings", json={"actions": [{"name": " Shortcut ", "url": "shortcuts://run?text={{text}}&id={{id}}"}]})
    assert saved.json()["settings"]["actions"] == [{"name": "Shortcut", "url": "shortcuts://run?text={{text}}&id={{id}}"}]
    nid = send(admin, cli_headers, "a b&c").json()["id"]
    detail = admin.get(f"/api/notifications/{nid}").json()
    assert detail["actions"] == [{"name": "Shortcut", "url": f"shortcuts://run?text=a%20b%26c&id={nid}"}]
