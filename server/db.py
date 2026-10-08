"""SQLite persistence. Each operation opens and closes its own connection."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterator


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


@contextmanager
def connection(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 pw_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, pw_changed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_settings(
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 topics_mode TEXT NOT NULL DEFAULT 'all', topics TEXT NOT NULL DEFAULT '[]',
 blacklist TEXT NOT NULL DEFAULT '[]', admin_blacklist TEXT NOT NULL DEFAULT '[]',
 feed_topics TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, last_seen TEXT NOT NULL, user_agent TEXT);
CREATE TABLE IF NOT EXISTS notifications(
 id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
 type TEXT NOT NULL, text TEXT, markdown INTEGER NOT NULL DEFAULT 0,
 file_path TEXT, file_name TEXT, file_size INTEGER, mime TEXT, source_path TEXT,
 status TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS notification_topics(
 notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 topic TEXT NOT NULL, display TEXT NOT NULL, PRIMARY KEY(notification_id, topic));
CREATE TABLE IF NOT EXISTS deliveries(
 notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 read_at TEXT, archived_at TEXT, PRIMARY KEY(notification_id, user_id));
CREATE INDEX IF NOT EXISTS deliveries_user ON deliveries(user_id, notification_id DESC);
CREATE TABLE IF NOT EXISTS topic_routes(
 topic TEXT PRIMARY KEY, display TEXT NOT NULL, user_ids TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS subscriptions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
 user_agent TEXT, created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT,
 fail_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS push_jobs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
 notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
 payload TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 not_before REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
 error TEXT, sent_at TEXT);
CREATE TABLE IF NOT EXISTS webhooks(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 url TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'POST',
 headers TEXT NOT NULL DEFAULT '{}', body_kind TEXT NOT NULL DEFAULT 'json', body TEXT NOT NULL DEFAULT '',
 use_proxy INTEGER NOT NULL DEFAULT 0, topics TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
 last_ok_at TEXT, last_error TEXT, fail_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS webhook_jobs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
 notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 not_before REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT, sent_at TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

SETTING_DEFAULTS = {
    "registration_open": False, "invite_only": False, "invite_code": "",
    "push_interval_sec": 5, "schema_version": 1,
    "proxy_url": "http://127.0.0.1:7890",
    "push_proxy": {"google": True, "apple": False, "mozilla": False, "microsoft": False, "other": False},
}


def initialize(path: Path, admin_hash: str | Callable[[], str]) -> None:
    with connection(path) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        cols = {row[1] for row in conn.execute("PRAGMA table_info(user_settings)")}
        if "feed_topics" not in cols:
            conn.execute("ALTER TABLE user_settings ADD COLUMN feed_topics TEXT NOT NULL DEFAULT '[]'")
        if "actions" not in cols:
            conn.execute("ALTER TABLE user_settings ADD COLUMN actions TEXT NOT NULL DEFAULT '[]'")
        for key, value in SETTING_DEFAULTS.items():
            conn.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", (key, json.dumps(value)))
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            stamp = now_iso()
            seed_hash = admin_hash() if callable(admin_hash) else admin_hash
            cursor = conn.execute(
                "INSERT INTO users(username,pw_hash,is_admin,created_at,pw_changed_at) VALUES(?,?,1,?,?)",
                ("admin", seed_hash, stamp, stamp),
            )
            conn.execute("INSERT INTO user_settings(user_id) VALUES(?)", (cursor.lastrowid,))


def get_settings(path: Path) -> dict:
    with connection(path) as conn:
        return {row["key"]: json.loads(row["value"]) for row in conn.execute("SELECT * FROM settings")}


def set_settings(path: Path, values: dict) -> None:
    with connection(path) as conn:
        for key, value in values.items():
            conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))


def create_user(path: Path, username: str, pw_hash: str, is_admin: bool = False) -> int:
    stamp = now_iso()
    with connection(path) as conn:
        cursor = conn.execute(
            "INSERT INTO users(username,pw_hash,is_admin,created_at,pw_changed_at) VALUES(?,?,?,?,?)",
            (username, pw_hash, int(is_admin), stamp, stamp),
        )
        conn.execute("INSERT INTO user_settings(user_id) VALUES(?)", (cursor.lastrowid,))
        return cursor.lastrowid


def get_user(path: Path, *, user_id: int | None = None, username: str | None = None) -> dict | None:
    with connection(path) as conn:
        if user_id is not None:
            row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else None


def all_users(path: Path) -> list[dict]:
    with connection(path) as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM users ORDER BY id")]


def user_settings(path: Path, user_id: int) -> dict:
    with connection(path) as conn:
        row = conn.execute("SELECT * FROM user_settings WHERE user_id=?", (user_id,)).fetchone()
        return {key: json.loads(row[key]) if key != "topics_mode" else row[key] for key in ("topics_mode", "topics", "blacklist", "admin_blacklist", "feed_topics", "actions")}


def patch_user(path: Path, user_id: int, fields: dict, settings: dict | None = None, keep_token_hash: str | None = None) -> None:
    with connection(path) as conn:
        if fields:
            cols = ", ".join(f"{key}=?" for key in fields)
            conn.execute(f"UPDATE users SET {cols} WHERE id=?", (*fields.values(), user_id))
        if settings:
            cols = ", ".join(f"{key}=?" for key in settings)
            vals = [value if key == "topics_mode" else json.dumps(value, ensure_ascii=False) for key, value in settings.items()]
            conn.execute(f"UPDATE user_settings SET {cols} WHERE user_id=?", (*vals, user_id))
        if "pw_hash" in fields or fields.get("disabled"):
            if keep_token_hash:
                conn.execute("DELETE FROM sessions WHERE user_id=? AND token_hash!=?", (user_id, keep_token_hash))
            else:
                conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def enabled_admin_count(path: Path, excluding_id: int | None = None) -> int:
    with connection(path) as conn:
        return conn.execute("SELECT COUNT(*) FROM users WHERE is_admin=1 AND disabled=0 AND id!=?", (excluding_id or -1,)).fetchone()[0]


def delete_user(path: Path, user_id: int) -> None:
    with connection(path) as conn:
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        for route in conn.execute("SELECT topic,user_ids FROM topic_routes").fetchall():
            ids = [value for value in json.loads(route["user_ids"]) if value != user_id]
            if ids:
                conn.execute("UPDATE topic_routes SET user_ids=? WHERE topic=?", (json.dumps(ids), route["topic"]))
            else:
                conn.execute("DELETE FROM topic_routes WHERE topic=?", (route["topic"],))


def create_session(path: Path, token_hash: str, user_id: int, user_agent: str | None) -> None:
    stamp = now_iso()
    with connection(path) as conn:
        conn.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (token_hash, user_id, stamp, stamp, user_agent))


def session_user(path: Path, token_hash: str) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("SELECT u.*, s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?", (token_hash,)).fetchone()
        if row and not row["disabled"]:
            from datetime import timedelta
            try:
                old = datetime.fromisoformat(row["last_seen"])
                if datetime.now().astimezone() - old >= timedelta(minutes=10):
                    conn.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now_iso(), token_hash))
            except ValueError:
                pass
        return dict(row) if row else None


def delete_session(path: Path, token_hash: str) -> None:
    with connection(path) as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))


def unread_count(path: Path, user_id: int) -> int:
    with connection(path) as conn:
        return conn.execute("SELECT COUNT(*) FROM deliveries WHERE user_id=? AND read_at IS NULL AND archived_at IS NULL", (user_id,)).fetchone()[0]


def routing_data(path: Path) -> tuple[list[dict], dict[str, list[int]]]:
    with connection(path) as conn:
        rows = conn.execute("SELECT u.id,u.disabled,s.topics_mode,s.topics,s.blacklist,s.admin_blacklist FROM users u JOIN user_settings s ON s.user_id=u.id").fetchall()
        users = [{**dict(row), **{key: json.loads(row[key]) for key in ("topics", "blacklist", "admin_blacklist")}} for row in rows]
        routes = {row["topic"]: json.loads(row["user_ids"]) for row in conn.execute("SELECT * FROM topic_routes")}
        return users, routes


def create_notification(path: Path, data: dict, topics: list[tuple[str, str]], recipients: list[int]) -> int:
    with connection(path) as conn:
        cols = ",".join(data)
        marks = ",".join("?" for _ in data)
        cursor = conn.execute(f"INSERT INTO notifications({cols}) VALUES({marks})", tuple(data.values()))
        nid = cursor.lastrowid
        conn.executemany("INSERT INTO notification_topics VALUES(?,?,?)", [(nid, key, display) for key, display in topics])
        conn.executemany("INSERT INTO deliveries(notification_id,user_id) VALUES(?,?)", [(nid, user_id) for user_id in recipients])
        return nid


def notification(path: Path, notification_id: int) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("SELECT * FROM notifications WHERE id=?", (notification_id,)).fetchone()
        return dict(row) if row else None


def notification_for_user(path: Path, user_id: int, notification_id: int) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("SELECT n.*,d.read_at,d.archived_at FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.user_id=? AND n.id=?", (user_id, notification_id)).fetchone()
        return dict(row) if row else None


def notification_topics(path: Path, notification_ids: list[int]) -> dict[int, list[str]]:
    if not notification_ids:
        return {}
    with connection(path) as conn:
        marks = ",".join("?" for _ in notification_ids)
        result = {nid: [] for nid in notification_ids}
        for row in conn.execute(f"SELECT notification_id,display FROM notification_topics WHERE notification_id IN ({marks}) ORDER BY rowid", notification_ids):
            result[row["notification_id"]].append(row["display"])
        return result


def _view_condition(view: str) -> str:
    return "AND d.archived_at IS NULL" if view == "inbox" else "AND d.archived_at IS NOT NULL" if view == "archived" else ""


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _feed_where(user_id: int, view: str, q: str, topic: str, unread: bool, before: int | None) -> tuple[str, list]:
    sql = "FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE d.user_id=? " + _view_condition(view)
    args: list = [user_id]
    if q.startswith("#"):
        topic, q = q[1:], ""
    if q:
        sql += " AND (n.text LIKE ? ESCAPE '\\' OR n.file_name LIKE ? ESCAPE '\\')"
        args.extend([f"%{_escape_like(q)}%"] * 2)
    if topic:
        sql += " AND EXISTS(SELECT 1 FROM notification_topics nt WHERE nt.notification_id=n.id AND nt.topic=?)"
        args.append(topic.lstrip("#").casefold())
    if unread:
        sql += " AND d.read_at IS NULL"
    if before is not None:
        sql += " AND n.id<?"
        args.append(before)
    return sql, args


def list_notifications(path: Path, user_id: int, view: str, q: str, topic: str, unread: bool, before: int | None, limit: int, offset: int = 0) -> list[dict]:
    where, args = _feed_where(user_id, view, q, topic, unread, before)
    sql = "SELECT n.*,d.read_at,d.archived_at " + where + " ORDER BY n.id DESC LIMIT ? OFFSET ?"
    with connection(path) as conn:
        return [dict(row) for row in conn.execute(sql, [*args, limit, offset])]


def count_notifications(path: Path, user_id: int, view: str, q: str, topic: str, unread: bool) -> int:
    where, args = _feed_where(user_id, view, q, topic, unread, None)
    with connection(path) as conn:
        return conn.execute("SELECT COUNT(*) " + where, args).fetchone()[0]


def set_delivery_state(path: Path, user_id: int, ids: list[int], read: bool | None, archived: bool | None) -> int:
    marks = ",".join("?" for _ in ids)
    updates = []
    args: list = []
    if read is not None:
        updates.append("read_at=COALESCE(read_at, ?)" if read else "read_at=NULL")
        if read:
            args.append(now_iso())
    if archived is not None:
        updates.append("archived_at=COALESCE(archived_at, ?)" if archived else "archived_at=NULL")
        if archived:
            args.append(now_iso())
    with connection(path) as conn:
        return conn.execute(f"UPDATE deliveries SET {','.join(updates)} WHERE user_id=? AND notification_id IN ({marks})", (*args, user_id, *ids)).rowcount


def read_all(path: Path, user_id: int, view: str, topic: str | None) -> int:
    sql = "UPDATE deliveries AS d SET read_at=? WHERE d.user_id=? AND d.read_at IS NULL " + _view_condition(view)
    args: list = [now_iso(), user_id]
    if topic:
        sql += " AND EXISTS(SELECT 1 FROM notification_topics nt WHERE nt.notification_id=d.notification_id AND nt.topic=?)"
        args.append(topic.lstrip("#").casefold())
    with connection(path) as conn:
        return conn.execute(sql, args).rowcount


def topic_counts(path: Path, user_id: int, view: str) -> list[dict]:
    sql = """SELECT nt.topic,COUNT(*) AS count,
      SUM(CASE WHEN d.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
      MAX(nt.notification_id) AS latest
      FROM deliveries d JOIN notification_topics nt ON nt.notification_id=d.notification_id
      WHERE d.user_id=? """ + _view_condition(view) + " GROUP BY nt.topic ORDER BY latest DESC"
    with connection(path) as conn:
        result = []
        for row in conn.execute(sql, (user_id,)):
            display = conn.execute("SELECT display FROM notification_topics WHERE notification_id=? AND topic=?", (row["latest"], row["topic"])).fetchone()[0]
            result.append({"topic": display, "key": row["topic"], "count": row["count"], "unread": row["unread"]})
        return result


def admin_users(path: Path) -> list[dict]:
    with connection(path) as conn:
        return [dict(row) for row in conn.execute("""SELECT u.*,s.topics_mode,s.topics,s.blacklist,s.admin_blacklist,s.feed_topics,
          (SELECT COUNT(*) FROM subscriptions WHERE user_id=u.id) AS subscriptions,
          (SELECT COUNT(*) FROM webhooks WHERE user_id=u.id) AS webhooks,
          (SELECT COUNT(*) FROM deliveries WHERE user_id=u.id) AS delivered,
          (SELECT COUNT(*) FROM deliveries WHERE user_id=u.id AND read_at IS NULL AND archived_at IS NULL) AS unread
          FROM users u JOIN user_settings s ON s.user_id=u.id ORDER BY u.id""")]


def get_routes(path: Path) -> list[dict]:
    with connection(path) as conn:
        users = {row["id"]: row["username"] for row in conn.execute("SELECT id,username FROM users")}
        return [{"topic": row["display"], "key": row["topic"], "user_ids": ids,
                 "users": [users[i] for i in ids if i in users]}
                for row in conn.execute("SELECT * FROM topic_routes ORDER BY topic")
                for ids in [json.loads(row["user_ids"])]]


def put_route(path: Path, key: str, display: str, user_ids: list[int]) -> None:
    with connection(path) as conn:
        conn.execute("INSERT INTO topic_routes(topic,display,user_ids) VALUES(?,?,?) ON CONFLICT(topic) DO UPDATE SET display=excluded.display,user_ids=excluded.user_ids", (key, display, json.dumps(user_ids)))


def delete_route(path: Path, key: str) -> None:
    with connection(path) as conn:
        conn.execute("DELETE FROM topic_routes WHERE topic=?", (key.casefold(),))


def known_topics(path: Path) -> list[str]:
    with connection(path) as conn:
        rows = conn.execute("""SELECT display,MAX(rank) AS rank FROM (
          SELECT topic,display,notification_id AS rank FROM notification_topics
          UNION ALL SELECT topic,display,0 AS rank FROM topic_routes)
          GROUP BY display ORDER BY rank DESC LIMIT 200""").fetchall()
        return [row["display"] for row in rows]


def upsert_subscription(path: Path, user_id: int, endpoint: str, p256dh: str, auth: str, user_agent: str | None) -> int:
    with connection(path) as conn:
        conn.execute("""INSERT INTO subscriptions(user_id,endpoint,p256dh,auth,user_agent,created_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,
          p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent,
          fail_count=0,last_error=NULL""", (user_id, endpoint, p256dh, auth, user_agent, now_iso()))
        return conn.execute("SELECT id FROM subscriptions WHERE endpoint=?", (endpoint,)).fetchone()[0]


def delete_subscription(path: Path, user_id: int, endpoint: str) -> None:
    with connection(path) as conn:
        conn.execute("DELETE FROM subscriptions WHERE user_id=? AND endpoint=?", (user_id, endpoint))


def subscriptions(path: Path, user_id: int) -> list[dict]:
    with connection(path) as conn:
        return [dict(row) for row in conn.execute("SELECT * FROM subscriptions WHERE user_id=? ORDER BY id", (user_id,))]


def enqueue_jobs(path: Path, notification_id: int | None, subscription_ids: list[int], payload: str) -> tuple[int, int]:
    with connection(path) as conn:
        ahead = conn.execute("SELECT COUNT(*) FROM push_jobs WHERE status='pending'").fetchone()[0]
        conn.executemany("INSERT INTO push_jobs(subscription_id,notification_id,payload,created_at) VALUES(?,?,?,?)", [(sid, notification_id, payload, now_iso()) for sid in subscription_ids])
        return len(subscription_ids), ahead


def subscription_ids_for_users(path: Path, user_ids: list[int]) -> list[int]:
    if not user_ids:
        return []
    marks = ",".join("?" for _ in user_ids)
    with connection(path) as conn:
        return [row[0] for row in conn.execute(f"SELECT id FROM subscriptions WHERE user_id IN ({marks}) ORDER BY user_id,id", user_ids)]


def next_push_job(path: Path, unix_now: float) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("""SELECT j.*,s.endpoint,s.p256dh,s.auth FROM push_jobs j
          JOIN subscriptions s ON s.id=j.subscription_id WHERE j.status='pending' AND j.not_before<=?
          ORDER BY j.id LIMIT 1""", (unix_now,)).fetchone()
        return dict(row) if row else None


def push_sent(path: Path, job: dict) -> None:
    with connection(path) as conn:
        conn.execute("UPDATE push_jobs SET status='sent',sent_at=?,attempts=attempts+1,error=NULL WHERE id=?", (now_iso(), job["id"]))
        conn.execute("UPDATE subscriptions SET last_ok_at=?,fail_count=0,last_error=NULL WHERE id=?", (now_iso(), job["subscription_id"]))


def push_gone(path: Path, job: dict) -> None:
    with connection(path) as conn:
        conn.execute("DELETE FROM subscriptions WHERE id=?", (job["subscription_id"],))


def push_failed(path: Path, job: dict, error: str, permanent: bool) -> None:
    attempts = job["attempts"] + 1
    with connection(path) as conn:
        conn.execute("UPDATE subscriptions SET fail_count=fail_count+1,last_error=? WHERE id=?", (error, job["subscription_id"]))
        conn.execute("UPDATE push_jobs SET attempts=?,error=?,status=?,not_before=? WHERE id=?", (attempts, error, "failed" if permanent or attempts >= 3 else "pending", 0 if permanent or attempts >= 3 else time.time() + 60 * attempts, job["id"]))


def push_status(path: Path) -> dict:
    from datetime import timedelta
    cutoff = (datetime.now().astimezone() - timedelta(hours=24)).isoformat(timespec="seconds")[:19]
    with connection(path) as conn:
        pending = conn.execute("SELECT COUNT(*) FROM push_jobs WHERE status='pending'").fetchone()[0]
        counts = {row["status"]: row["n"] for row in conn.execute("SELECT status,COUNT(*) AS n FROM push_jobs WHERE status IN ('failed','sent') AND substr(COALESCE(sent_at,created_at),1,19)>=? GROUP BY status", (cutoff,))}
    return {"pending": pending, "failed_24h": counts.get("failed", 0), "sent_24h": counts.get("sent", 0)}


def webhook_out(row: dict) -> dict:
    return {**row, "enabled": bool(row["enabled"]), "use_proxy": bool(row["use_proxy"]),
            "headers": json.loads(row["headers"]), "topics": json.loads(row["topics"])}


def list_webhooks(path: Path, user_id: int) -> list[dict]:
    with connection(path) as conn:
        return [webhook_out(dict(row)) for row in conn.execute("SELECT * FROM webhooks WHERE user_id=? ORDER BY id", (user_id,))]


def get_webhook(path: Path, user_id: int, webhook_id: int) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("SELECT * FROM webhooks WHERE user_id=? AND id=?", (user_id, webhook_id)).fetchone()
        return webhook_out(dict(row)) if row else None


def create_webhook(path: Path, user_id: int, fields: dict) -> dict | None:
    with connection(path) as conn:
        if conn.execute("SELECT COUNT(*) FROM webhooks WHERE user_id=?", (user_id,)).fetchone()[0] >= 20:
            return None
        data = {"user_id": user_id, **fields, "created_at": now_iso()}
        cols = ",".join(data)
        marks = ",".join("?" for _ in data)
        cursor = conn.execute(f"INSERT INTO webhooks({cols}) VALUES({marks})", tuple(data.values()))
        row = conn.execute("SELECT * FROM webhooks WHERE id=?", (cursor.lastrowid,)).fetchone()
        return webhook_out(dict(row))


def patch_webhook(path: Path, user_id: int, webhook_id: int, fields: dict) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("SELECT * FROM webhooks WHERE user_id=? AND id=?", (user_id, webhook_id)).fetchone()
        if not row:
            return None
        if fields:
            cols = ",".join(f"{key}=?" for key in fields)
            conn.execute(f"UPDATE webhooks SET {cols} WHERE id=?", (*fields.values(), webhook_id))
        return webhook_out(dict(conn.execute("SELECT * FROM webhooks WHERE id=?", (webhook_id,)).fetchone()))


def delete_webhook(path: Path, user_id: int, webhook_id: int) -> bool:
    with connection(path) as conn:
        return conn.execute("DELETE FROM webhooks WHERE user_id=? AND id=?", (user_id, webhook_id)).rowcount > 0


def enqueue_webhooks(path: Path, notification_id: int, user_ids: list[int], topics: list[str]) -> int:
    if not user_ids:
        return 0
    marks = ",".join("?" for _ in user_ids)
    keys = {topic.casefold() for topic in topics}
    with connection(path) as conn:
        rows = conn.execute(f"SELECT id,topics FROM webhooks WHERE enabled=1 AND user_id IN ({marks}) ORDER BY id", user_ids)
        ids = [row["id"] for row in rows if not json.loads(row["topics"]) or keys.intersection(
               topic.casefold() for topic in json.loads(row["topics"]))]
        stamp = now_iso()
        conn.executemany("INSERT INTO webhook_jobs(webhook_id,notification_id,created_at) VALUES(?,?,?)",
                         [(wid, notification_id, stamp) for wid in ids])
        return len(ids)


def next_webhook_job(path: Path, unix_now: float) -> dict | None:
    with connection(path) as conn:
        row = conn.execute("""SELECT j.*,w.user_id,w.name,w.enabled,w.url,w.method,w.headers,w.body_kind,w.body,w.use_proxy,
          u.username,u.is_admin,n.type,n.text,n.markdown,n.file_name,n.created_at AS notification_time
          FROM webhook_jobs j JOIN webhooks w ON w.id=j.webhook_id JOIN users u ON u.id=w.user_id
          JOIN notifications n ON n.id=j.notification_id
          WHERE j.status='pending' AND j.not_before<=? ORDER BY j.id LIMIT 1""", (unix_now,)).fetchone()
        return dict(row) if row else None


def webhook_result(path: Path, job: dict, ok: bool, error: str | None = None, permanent: bool = False) -> None:
    stamp = now_iso()
    attempts = job["attempts"] + 1
    error = (error or "Unknown error")[:500] if not ok else None
    with connection(path) as conn:
        if ok:
            conn.execute("UPDATE webhook_jobs SET status='sent',sent_at=?,attempts=?,error=NULL WHERE id=?", (stamp, attempts, job["id"]))
            conn.execute("UPDATE webhooks SET last_ok_at=?,last_error=NULL,fail_count=0 WHERE id=?", (stamp, job["webhook_id"]))
        else:
            status = "failed" if permanent or attempts >= 3 else "pending"
            conn.execute("UPDATE webhook_jobs SET status=?,attempts=?,error=?,not_before=? WHERE id=?",
                         (status, attempts, error, 0 if status == "failed" else time.time() + 60 * attempts, job["id"]))
            conn.execute("UPDATE webhooks SET last_error=?,fail_count=fail_count+1 WHERE id=?", (error, job["webhook_id"]))


def webhook_test_result(path: Path, webhook_id: int, ok: bool, error: str | None) -> None:
    with connection(path) as conn:
        if ok:
            conn.execute("UPDATE webhooks SET last_ok_at=?,last_error=NULL,fail_count=0 WHERE id=?", (now_iso(), webhook_id))
        else:
            conn.execute("UPDATE webhooks SET last_error=?,fail_count=fail_count+1 WHERE id=?", ((error or "Unknown error")[:500], webhook_id))


def delivery_status(path: Path, kind: str) -> dict:
    from datetime import timedelta
    cutoff = (datetime.now().astimezone() - timedelta(hours=24)).isoformat(timespec="seconds")[:19]
    table = "push_jobs" if kind == "push" else "webhook_jobs"
    with connection(path) as conn:
        pending = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE status='pending'").fetchone()[0]
        counts = {row["status"]: row["n"] for row in conn.execute(
            f"SELECT status,COUNT(*) AS n FROM {table} WHERE status IN ('failed','sent') AND substr(COALESCE(sent_at,created_at),1,19)>=? GROUP BY status", (cutoff,))}
        return {"pending": pending, "failed_24h": counts.get("failed", 0), "sent_24h": counts.get("sent", 0)}


def list_delivery(path: Path, status: str, kind: str, limit: int, before: str | None) -> tuple[list[dict], str | None]:
    cursor = None
    if before:
        try:
            date, cursor_kind, ident = before.rsplit("|", 2)
            cursor = (date, cursor_kind, int(ident))
            if cursor_kind not in ("push", "webhook"):
                raise ValueError
        except ValueError:
            raise ValueError("Invalid cursor") from None
    kinds = ("push", "webhook") if kind == "all" else (kind,)
    rows = []
    with connection(path) as conn:
        for entry_kind in kinds:
            if entry_kind == "push":
                sql = """SELECT j.*,n.type,n.text,n.file_name,n.id AS nid,u.id AS uid,u.username,s.endpoint AS target
                  FROM push_jobs j JOIN subscriptions s ON s.id=j.subscription_id JOIN users u ON u.id=s.user_id
                  LEFT JOIN notifications n ON n.id=j.notification_id"""
            else:
                sql = """SELECT j.*,n.type,n.text,n.file_name,n.id AS nid,u.id AS uid,u.username,w.name AS target
                  FROM webhook_jobs j JOIN webhooks w ON w.id=j.webhook_id JOIN users u ON u.id=w.user_id
                  LEFT JOIN notifications n ON n.id=j.notification_id"""
            where = []
            args = []
            if status != "all":
                where.append("j.status=?")
                args.append(status)
            if cursor:
                op = "<=" if entry_kind < cursor[1] else "<"
                where.append(f"(j.created_at<? OR (j.created_at=? AND j.id{op}?))")
                args.extend((cursor[0], cursor[0], cursor[2]))
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY j.created_at DESC,j.id DESC LIMIT ?"
            args.append(limit + 1)
            for row in conn.execute(sql, args):
                item = dict(row)
                item["kind"] = entry_kind
                rows.append(item)
    rows.sort(key=lambda row: (row["created_at"], row["id"], row["kind"]), reverse=True)
    more = len(rows) > limit
    rows = rows[:limit]
    items = []
    from urllib.parse import urlsplit
    for row in rows:
        preview = (row["text"] or row["file_name"] or "")[:120]
        items.append({"kind": row["kind"], "id": row["id"], "status": row["status"], "attempts": row["attempts"],
                      "error": row["error"], "created_at": row["created_at"], "sent_at": row["sent_at"],
                      "notification": {"id": row["nid"], "type": row["type"], "preview": preview} if row["nid"] else None,
                      "user": {"id": row["uid"], "username": row["username"]} if row["uid"] else None,
                      "target": urlsplit(row["target"]).hostname if row["kind"] == "push" else row["target"]})
    last = rows[-1] if more else None
    return items, f"{last['created_at']}|{last['kind']}|{last['id']}" if last else None


def retry_delivery(path: Path, kind: str, job_id: int) -> str:
    table = "push_jobs" if kind == "push" else "webhook_jobs"
    with connection(path) as conn:
        row = conn.execute(f"SELECT status FROM {table} WHERE id=?", (job_id,)).fetchone()
        if not row:
            return "missing"
        if row["status"] != "failed":
            return "not_failed"
        conn.execute(f"UPDATE {table} SET status='pending',attempts=0,not_before=0,error=NULL WHERE id=?", (job_id,))
        return "ok"


def retry_all_delivery(path: Path, kind: str) -> int:
    from datetime import timedelta
    cutoff = (datetime.now().astimezone() - timedelta(hours=24)).isoformat(timespec="seconds")[:19]
    total = 0
    with connection(path) as conn:
        for item in (("push", "webhook") if kind == "all" else (kind,)):
            table = "push_jobs" if item == "push" else "webhook_jobs"
            total += conn.execute(f"UPDATE {table} SET status='pending',attempts=0,not_before=0,error=NULL WHERE status='failed' AND substr(created_at,1,19)>=?", (cutoff,)).rowcount
    return total


def clear_failed_delivery(path: Path, kind: str) -> int:
    total = 0
    with connection(path) as conn:
        for item in (("push", "webhook") if kind == "all" else (kind,)):
            table = "push_jobs" if item == "push" else "webhook_jobs"
            total += conn.execute(f"DELETE FROM {table} WHERE status='failed'").rowcount
    return total


def housekeeping(path: Path) -> None:
    from datetime import timedelta
    cutoff_30 = (datetime.now().astimezone() - timedelta(days=30)).isoformat(timespec="seconds")[:19]
    cutoff_365 = (datetime.now().astimezone() - timedelta(days=365)).isoformat(timespec="seconds")[:19]
    with connection(path) as conn:
        conn.execute("DELETE FROM push_jobs WHERE status!='pending' AND substr(created_at,1,19)<?", (cutoff_30,))
        conn.execute("DELETE FROM webhook_jobs WHERE status!='pending' AND substr(created_at,1,19)<?", (cutoff_30,))
        conn.execute("DELETE FROM sessions WHERE substr(last_seen,1,19)<?", (cutoff_365,))
