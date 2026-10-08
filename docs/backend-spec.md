# notify backend + CLI spec

This file is the contract between `server/` (Python), `cli/` and `web/` (Preact, already being written separately — do NOT touch `web/`).
Implement exactly what is written. Where something is unspecified, choose the simplest behavior and note it in your final report.

Machine constraints: 1.8 GB RAM, Atom CPU. Keep it light: one process, stdlib `sqlite3`, no ORM, no Redis, no extra daemons.
Python 3.13 via `uv`. Dependencies are already pinned in `pyproject.toml` and installed in `.venv` (`uv sync` done):
fastapi 0.118.0, uvicorn[standard] 0.37.0, pydantic 2.11.9, python-multipart 0.0.20, bcrypt 4.3.0, itsdangerous 2.2.0 (may be unused), pywebpush 2.5.0 (brings py_vapid, cryptography, requests). Dev: pytest 8.4.2, pytest-asyncio 1.2.0, httpx 0.28.1.
Do not add dependencies. Do not import anything from other projects on this machine.

## 1. Files to create

```
server/__init__.py
server/__main__.py     # `python -m server` -> run uvicorn; `python -m server reset-password USER PASS`
server/paths.py        # repo root, data dir, files dir, dist dir; atomic_write helper
server/config.py       # data/config.json load/create with defaults
server/db.py           # sqlite connection, schema/migrations, all queries as functions
server/auth.py         # password hashing, sessions, FastAPI dependencies current_user / require_admin
server/routing.py      # topic extraction + recipient computation (pure functions, no I/O besides passed-in data)
server/push.py         # VAPID keys, push worker (serial, spaced), payload building
server/app.py          # FastAPI app factory `create_app(data_dir: Path | None = None, start_worker=True)`, all routes, static serving
cli/notify.py          # the CLI
bin/notify             # bash wrapper, executable
deploy/notify.service  # systemd unit
deploy/nginx-notify.conf
tests/conftest.py, tests/test_routing.py, tests/test_api.py, tests/test_push.py, tests/test_cli.py
```

## 2. Paths and config

- Repo root `ROOT = Path(__file__).resolve().parent.parent` (from `server/paths.py`).
- Data dir default `ROOT/'data'`, overridable by env `NOTIFY_DATA_DIR` (tests use tmp dirs). Create with mode 0700.
- `data/notify.db` (SQLite), `data/files/` (stored attachments), `data/vapid_private.pem`, `data/cli_token` (mode 0600), `data/config.json`.
- Built frontend: `ROOT/'web'/'dist'`.
- `data/config.json` created on first start if missing, with:
  ```json
  {"host": "::1", "port": 18794, "public_url": "https://notify.example.com", "vapid_subject": "mailto:admin@example.com"}
  ```
  Missing keys fall back to these defaults.

## 3. Database (SQLite, WAL, foreign_keys=ON)

Use one module-level helper that opens a connection per call (`sqlite3.connect(path, timeout=10)`, `row_factory=sqlite3.Row`) — the app is low-traffic; simplicity beats pooling. Set `PRAGMA journal_mode=WAL` at init. Run schema creation idempotently at startup (`CREATE TABLE IF NOT EXISTS`). Store a `schema_version` in `settings` for future migrations.

Timestamps: `now_iso()` = `datetime.now().astimezone().isoformat(timespec="seconds")` (e.g. `2026-10-04T10:00:00+08:00`). Comparisons in SQL use `substr(col,1,19)`.

```sql
users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  pw_changed_at TEXT NOT NULL
)
user_settings(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  topics_mode TEXT NOT NULL DEFAULT 'all',      -- 'all' | 'only'
  topics TEXT NOT NULL DEFAULT '[]',            -- JSON list of topic strings (no '#'), as entered
  blacklist TEXT NOT NULL DEFAULT '[]',         -- JSON list, user-editable
  admin_blacklist TEXT NOT NULL DEFAULT '[]'    -- JSON list, admin-only (user sees it read-only)
)
sessions(
  token_hash TEXT PRIMARY KEY,                  -- sha256 hex of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  user_agent TEXT
)
notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,                           -- 'message' | 'photo' | 'document'
  text TEXT,                                    -- message text or caption; may be NULL for bare files
  markdown INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,                               -- path RELATIVE to data/files, e.g. '2026-10/<uuid>/report.pdf'
  file_name TEXT,                               -- original basename
  file_size INTEGER,
  mime TEXT,
  source_path TEXT,                             -- the path the CLI was given (for CLI history '[target]')
  status TEXT NOT NULL,                         -- 'success' | 'skipped' | 'failed'
  error TEXT
)
notification_topics(
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,                          -- casefolded, no '#'
  display TEXT NOT NULL,                        -- first-seen original spelling, no '#'
  PRIMARY KEY (notification_id, topic)
)
deliveries(
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT,
  archived_at TEXT,
  PRIMARY KEY (notification_id, user_id)
)
CREATE INDEX deliveries_user ON deliveries(user_id, notification_id DESC)
topic_routes(
  topic TEXT PRIMARY KEY,                       -- casefolded, no '#'
  display TEXT NOT NULL,
  user_ids TEXT NOT NULL DEFAULT '[]'           -- JSON list of user ids
)
subscriptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
)
push_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,  -- NULL for test pushes
  payload TEXT NOT NULL,                        -- JSON string sent as push body
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before REAL NOT NULL DEFAULT 0,           -- unix time; retry backoff
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'sent' | 'failed' | 'gone'
  error TEXT,
  sent_at TEXT
)
settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)   -- values JSON-encoded
```

Settings keys and defaults: `registration_open` false, `invite_only` false, `invite_code` "" , `push_interval_sec` 5 (number, allowed 0–600), `schema_version` 1.

Seeding: if `users` is empty at startup, create `admin` / password `changeme`, `is_admin=1`, plus its `user_settings` row. Every user always has a `user_settings` row (create it in the same transaction as the user).

Housekeeping at startup and every 24 h inside the worker loop: delete `push_jobs` with status != 'pending' older than 30 days; delete sessions with `last_seen` older than 365 days.

## 4. Auth

- Passwords: bcrypt (`bcrypt.hashpw(pw.encode(), bcrypt.gensalt())`). Password rules: 4–128 chars. Username rules: regex `^[A-Za-z0-9_.-]{2,32}$`.
- Session cookie name `nt_session`, value `secrets.token_urlsafe(32)`; DB stores sha256 hex. Cookie: HttpOnly, SameSite=Lax, Path=/, Max-Age 365 days, `Secure` when the request scheme is https or header `X-Forwarded-Proto: https`.
- `current_user` dependency: look up session, join user, reject (401 `{"detail":"Authentication required"}`) if missing or user disabled. Update `last_seen` at most once per 10 minutes per session.
- `require_admin`: 403 `Admin only` if not admin.
- CSRF: for every non-GET `/api/*` request except `/api/cli/*`, if an `Origin` header is present its host must equal the `Host` header (else 403 `Bad origin`). Implement as middleware.
- Login rate limit: in-memory per IP (`X-Real-IP` header, else client host) — more than 8 failures within 10 minutes -> 429 `Too many login attempts`.
- Changing a password (self or admin reset) deletes all OTHER sessions of that user (self-change keeps the current session; admin reset deletes all sessions of the target, except when the admin resets their own password, then keep the current session).

## 5. Topics and routing (`server/routing.py`)

Topic extraction:
```python
TOPIC_RE = re.compile(r'(?<![\w/&#])#(\w[\w-]{0,63})')
```
(`\w` is Unicode-aware so CJK topics work; `# Heading` does not match because of the space; `page#frag` does not match.) `extract_topics(text) -> list[tuple[key, display]]` where `key = display.casefold()`, de-duplicated by key, order of first appearance. Strip a trailing `-` from display. `None`/empty text -> `[]`.

Keyword match: `contains_keyword(text, keywords)` -> True if any non-empty keyword (stripped) is a case-insensitive (`casefold`) substring of `text` (text None -> ""). For photo/document the text is the caption plus the file name (joined with a newline) — so a blacklist can also block by file name.

Recipient computation — pure function:
```python
def compute_recipients(text: str | None, file_name: str | None, topics: list[str], users: list[UserRouting], routes: dict[str, list[int]]) -> list[int]
```
`UserRouting` = dataclass(id, disabled, topics_mode, topics(list, casefolded on comparison, leading '#' stripped), blacklist, admin_blacklist).
1. Candidate set: if any notification topic key exists in `routes` with a non-empty user list -> union of those routed user ids (“routed = True”). Otherwise all users (“routed = False”).
2. Remove disabled users and ids not in `users`.
3. Remove users where `contains_keyword(text+file_name, blacklist + admin_blacklist)`.
4. If not routed: remove users with `topics_mode == 'only'` unless the notification has at least one topic in their topic list (no topics -> removed). If routed: the topics-only filter is skipped (admin routing wins), but blacklists (step 3) still apply.
5. Return sorted ids.

## 6. Push (`server/push.py`)

VAPID:
- On startup, if `data/vapid_private.pem` is missing, generate with `py_vapid.Vapid01()` -> `generate_keys()` -> `save_key(path)`; chmod 0600. Never regenerate if present.
- Public key for browsers: uncompressed EC point (65 bytes) base64url without padding (`vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)`).
- Send with `pywebpush.webpush(subscription_info={"endpoint":..., "keys":{"p256dh":..., "auth":...}}, data=payload_json, vapid_private_key=<pem path str>, vapid_claims={"sub": config.vapid_subject}, ttl=86400, headers={"Urgency": "high"}, timeout=20)`. Run it in `asyncio.to_thread` so the event loop is never blocked.

Payload (JSON, built at enqueue time, kept small, max 3000 bytes):
```json
{"id": 123, "title": "...", "body": "...", "url": "/n/123", "tag": "n-123"}
```
- Plain-text body: take `text` (strip markdown syntax lightly when `markdown=1`: remove `*`, `_`, `` ` ``, and turn `[label](url)` into `label`). If text has 2+ non-empty lines, `title` = first non-empty line (max 80 chars, ellipsis `…`), `body` = the remaining lines joined by `\n` (max 240 chars). Else `title` = `"Notify"`, `body` = the text (max 240 chars).
- photo with no text: body `"Image: <file_name>"`; document with no text: body `"File: <file_name>"`. With text, append nothing.
- Test push: `{"id": 0, "title": "Notify", "body": "Test notification. Push is working on this device.", "url": "/settings", "tag": "test-<unix ms>"}`.

Worker (`PushWorker` class, one instance, started in the FastAPI lifespan when `start_worker=True`):
- Strictly serial: a single asyncio task processes ONE job at a time, never concurrently.
- Spacing: before each HTTP request, wait until `last_request_started + interval` where `interval = push_interval_sec` read from the settings table right before waiting (so admin changes apply immediately). The first request after idle may go immediately if the interval already elapsed. Use an injectable clock/sleep (`time_fn`, `sleep_fn` constructor args, default `time.monotonic` / `asyncio.sleep`) so tests can verify spacing without real waiting.
- Job selection: oldest `pending` job (by id) with `not_before <= time.time()`. If none, wait on an `asyncio.Event` (set by `enqueue`) with a timeout of 30 s (also covers backoff timers), then loop.
- Results: 2xx -> status `sent`, `sent_at`, subscription `last_ok_at=now`, `fail_count=0`, `last_error=NULL`. HTTP 404/410 -> delete the subscription (its pending jobs cascade away; mark this job `gone` first or just let cascade delete it — either is fine). HTTP 413 or 400 -> status `failed` (no retry), record error. Other errors (429, 5xx, network/timeouts) -> `attempts+1`, subscription `fail_count+1`, `last_error`; if attempts < 3 set `not_before = time.time() + 60 * attempts` and keep `pending`, else `failed`. Never let an exception kill the loop (log and continue).
- On startup, pending jobs left from a previous run are processed normally (persistent queue).
- Shutdown: cancel the task cleanly in lifespan exit.
- `enqueue_for_notification(notification_id, user_ids)`: insert one job per subscription of each user (ordered by user id then subscription id), then set the event.
- Status for admin: `worker.status()` -> `{"pending": n, "failed_24h": n, "sent_24h": n, "interval": float}`.

## 7. HTTP API

All JSON. Errors: `HTTPException(status, detail_string)`. Paths below are exact.

Notification JSON object (`NotificationOut`) used by every list/detail endpoint:
```json
{
  "id": 12, "created_at": "2026-10-04T10:00:00+08:00", "type": "message|photo|document",
  "text": "full text or null", "markdown": false,
  "topics": ["Deploy", "server"],            // display spellings
  "file": null | {"name": "report.pdf", "size": 12345, "mime": "application/pdf", "is_image": true|false,
                  "url": "/api/notifications/12/file", "download_url": "/api/notifications/12/file?download=1"},
  "read": false, "archived": false, "read_at": null, "archived_at": null
}
```
In LIST responses, `text` is truncated to 600 characters (append `…` when cut) and add `"truncated": true|false`. Detail returns full text with `"truncated": false`.

### Public / auth
- `GET /api/health` -> `{"ok": true}` (no auth).
- `GET /api/public/config` -> `{"registration_open": bool, "invite_only": bool}` (no auth).
- `POST /api/login` `{username, password}` -> sets cookie, returns `MeOut`. Wrong creds -> 401 `Invalid username or password`. Disabled -> 403 `Account disabled`.
- `POST /api/logout` -> deletes current session, clears cookie, `{"ok": true}`. Works even if not logged in.
- `POST /api/register` `{username, password, invite_code?}` -> if `registration_open` false: 403 `Registration is closed`. If `invite_only` true and code != `invite_code` (or invite_code empty): 403 `Invalid invite code`. Username taken -> 409 `Username already exists`. Success: creates non-admin user, logs in (cookie), returns `MeOut`.
- `GET /api/me` -> `MeOut`:
  ```json
  {"user": {"id": 1, "username": "admin", "is_admin": true},
   "settings": {"topics_mode": "all", "topics": [], "blacklist": [], "admin_blacklist": []},
   "unread": 3}
  ```
  (`unread` = deliveries of this user with read_at NULL and archived_at NULL.)
- `POST /api/me/password` `{current_password, new_password}` -> 400 `Current password is incorrect` on mismatch; `{"ok": true}`.
- `PUT /api/me/settings` `{topics_mode?, topics?, blacklist?}` -> validate: topics_mode in {'all','only'}; topics list of strings, strip whitespace and leading '#', drop empties, dedupe casefold, max 100 items, each max 64 chars; blacklist same cleaning (no '#' stripping), max 200 items, each max 100 chars. `admin_blacklist` in body is ignored. Returns `MeOut`.

### Notifications (current user only — always restricted to the user's deliveries)
- `GET /api/notifications?view=inbox|archived|history&q=&topic=&unread=0|1&before=<id>&limit=30`
  - inbox: `archived_at IS NULL`; archived: `archived_at IS NOT NULL`; history: all.
  - `q`: case-insensitive substring match against `text` OR `file_name` (SQL `LIKE` with `%`, `_`, `\` escaped, `ESCAPE '\'`; SQLite LIKE is ASCII-case-insensitive, that is acceptable). Also: if `q` starts with `#`, treat it as topic filter instead.
  - `topic`: casefolded match in notification_topics.
  - `unread=1`: only `read_at IS NULL`.
  - Order `notification_id DESC`; `before` = cursor (return ids `< before`); `limit` 1–100, default 30.
  - Response `{"items": [NotificationOut...], "next_before": <id of last item> | null (null when fewer than limit returned), "unread": <inbox unread count>}`.
- `GET /api/notifications/{id}` -> `NotificationOut` (full text) or 404 `Not found` if the user has no delivery for it. Does NOT auto-mark read (the frontend calls the state endpoint).
- `POST /api/notifications/state` `{ids: [int] (1–500), read?: bool, archived?: bool}` -> for ids that belong to the user: read true -> set `read_at=now` where NULL; read false -> NULL. archived true -> `archived_at=now` where NULL; false -> NULL. At least one of read/archived required (400). Returns `{"updated": n, "unread": <inbox unread>}`.
- `POST /api/notifications/read-all` `{view?: "inbox"|"archived"|"history", topic?: str}` (default inbox, no topic) -> marks all matching unread as read. Returns `{"updated": n, "unread": n}`.
- `GET /api/topics?view=inbox|archived|history` (default inbox) -> `{"topics": [{"topic": "Deploy", "key": "deploy", "count": 5, "unread": 2}]}` for the user's deliveries in that view, ordered by most recent use (max notification id desc). `display` = the display of the most recent notification with that key.
- `GET /api/notifications/{id}/file[?download=1]` -> `FileResponse` of `data/files/<file_path>` if the user has a delivery for it, else 404. `Content-Disposition: inline` by default, `attachment` with `download=1` (use RFC 5987 `filename*=UTF-8''...` so Chinese names work). Set `Cache-Control: private, max-age=86400`. Guard against path traversal (resolved path must be inside files dir). Set `X-Content-Type-Options: nosniff`; for non-image/non-pdf/non-text types force attachment even without `download=1`; serve `text/html` / `image/svg+xml` always as attachment (stored XSS guard).

### Push subscriptions
- `GET /api/push/public-key` (auth) -> `{"public_key": "<base64url>"}`.
- `POST /api/push/subscriptions` `{endpoint, keys: {p256dh, auth}}` -> upsert by endpoint (reassign to the current user if it belonged to someone else, update keys, user_agent from header, reset fail_count). Validate endpoint is `https://` and ≤ 1000 chars. Returns `{"ok": true, "id": n}`.
- `DELETE /api/push/subscriptions` body `{endpoint}` -> delete only if it belongs to the current user. `{"ok": true}` (also when it did not exist).
- `GET /api/push/subscriptions` -> `{"items": [{"id", "user_agent", "created_at", "last_ok_at", "last_error", "fail_count", "endpoint_host"}]}` of the current user (endpoint_host = hostname of endpoint, never the full endpoint).
- `POST /api/push/test` `{endpoint?}` -> enqueue the test payload for that subscription if given and owned by the user, else for all the user's subscriptions. 400 `No push subscription on this account` if none. Returns `{"queued": n, "position": <pending jobs ahead>}`.

### Admin (require_admin)
- `GET /api/admin/users` -> `{"items": [AdminUserOut]}` where `AdminUserOut` = `{"id","username","is_admin","disabled","created_at","settings": {topics_mode, topics, blacklist, admin_blacklist}, "subscriptions": n, "delivered": n, "unread": n}`.
- `POST /api/admin/users` `{username, password, is_admin?: bool}` -> 409 if taken; returns AdminUserOut.
- `PATCH /api/admin/users/{id}` `{is_admin?, disabled?, password?, settings?: {topics_mode?, topics?, blacklist?, admin_blacklist?}}` -> same validation as /api/me/settings (admin_blacklist like blacklist). Must refuse (400 `At least one active admin is required`) any change that leaves zero enabled admins. Setting a password resets sessions as in §4. Disabling a user deletes their sessions. Returns AdminUserOut.
- `DELETE /api/admin/users/{id}` -> refuse deleting yourself (400 `You cannot delete your own account`) and the last enabled admin. Cascade removes deliveries/subscriptions/sessions/push_jobs. Also remove the id from every `topic_routes.user_ids` (delete the route if it becomes empty). `{"ok": true}`.
- `GET /api/admin/routes` -> `{"items": [{"topic": "<display>", "key": "...", "user_ids": [..], "users": ["admin", ...]}]}`.
- `PUT /api/admin/routes` `{topic, user_ids}` -> upsert by casefolded topic (strip '#'); user_ids must all exist and be non-empty (400 otherwise). Returns the item.
- `DELETE /api/admin/routes/{key}` -> `{"ok": true}`.
- `GET /api/admin/settings` -> `{"registration_open", "invite_only", "invite_code", "push_interval_sec", "push": worker.status(), "vapid_public_key"}`.
- `PATCH /api/admin/settings` any subset of `{registration_open: bool, invite_only: bool, invite_code: str (≤64), push_interval_sec: number 0–600}` -> returns same as GET.
- `GET /api/admin/known-topics` -> `{"topics": ["Deploy", ...]}` distinct display spellings from notification_topics + routes (most recent first, max 200) — used for autocomplete.

### CLI endpoint
- `POST /api/cli/send` multipart form: fields `text` (optional), `markdown` ("0"/"1"), `type` ("message"|"photo"|"document"), `source_path` (optional), file part `file` (required for photo/document).
  - Auth: header `Authorization: Bearer <data/cli_token>` (constant-time compare). Also reject (403) if the request has an `X-Real-IP` or `X-Forwarded-For` header (i.e. came through nginx) or the client host is not loopback (`127.0.0.1`, `::1`, or `testclient` in tests).
  - Limits: photo ≤ 10 MB, document ≤ 50 MB (413 `File too large`). message requires non-empty text (400).
  - Stream the upload to `data/files/<YYYY-MM>/<uuid4 hex>/<safe basename>` (safe basename: strip directories, replace `/` `\` and control chars, max 200 chars, fallback `file`). mime from `mimetypes.guess_type` else `application/octet-stream`.
  - Then: create the notification row (status success), insert topics, compute recipients with routing.py, insert deliveries, enqueue pushes. If recipients is empty: set status `skipped`, error `no recipients after filters` (keep the row and the file).
  - Response `{"id": n, "status": "success|skipped", "recipients": ["admin", "bob"], "push_jobs": n}`.
- `GET /api/cli/ping` same auth -> `{"ok": true}`.
- Token: generated (`secrets.token_urlsafe(32)`) at startup if `data/cli_token` missing, mode 0600.

### Static frontend
- If `web/dist` exists: serve `/assets/*` with `Cache-Control: public, max-age=31536000, immutable`; serve top-level files that exist in dist (`/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/favicon...`) — `sw.js` and `manifest.webmanifest` with `Cache-Control: no-cache`; `sw.js` also with `Service-Worker-Allowed: /`. Every other non-`/api/` GET returns `dist/index.html` with `Cache-Control: no-cache` (SPA fallback, e.g. `/n/12`, `/settings`, `/admin`). Unknown `/api/...` -> JSON 404.
- If dist is missing, `/` returns plain text `frontend not built`.

## 8. CLI (`cli/notify.py`) — must behave like the old NotifyBot CLI minus channels

Run as `bin/notify`:
```bash
#!/bin/bash
# notify CLI wrapper: resolves symlinks, runs cli/notify.py with the project venv.
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"; SOURCE="$(readlink "$SOURCE")"; [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"; done
ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
PY="$ROOT/.venv/bin/python3"; [ -x "$PY" ] || PY=python3
exec "$PY" "$ROOT/cli/notify.py" "$@"
```
The CLI itself uses only the standard library (urllib, sqlite3, argparse, json, mimetypes, uuid) — it must work even with system python3.

Arguments (argparse, `RawDescriptionHelpFormatter`, description `Send notifications to the notify web push service`, an epilog with examples like the old one but without channel examples):
- `message` (nargs="?"; `-` means read stdin)
- `-i/--image PATH`, `-f/--file PATH`, `-m/--markdown`, `-t/--text-file PATH`
- `-c/--config PATH` default: `<ROOT>/data/config.json`. The CLI reads `host`/`port` from it (URL `http://[host]:port` for IPv6 hosts, `http://host:port` otherwise; override with key `url` if present) and `token_file` (default: `cli_token` next to the config file). Also env `NOTIFY_URL` overrides the URL.
- `--history [N]` (const 20), `--search KEYWORD`, `--since DATE`, `--until DATE`, `--limit N` (default 20).
- No `-C/--channel`, `-a/--all`, `-l/--list-channels`: passing them is an argparse error.

History mode (any of --history/--search/--since/--until given): read `<data dir>/notify.db` directly (data dir = directory of the config file), read-only (`file:...?mode=ro` URI). Identical semantics and output to the old CLI:
- DB missing -> print `暂无历史发送记录`. No rows -> `未找到匹配的历史记录`.
- limit = `--history` value if given else `--limit`. keyword -> `text LIKE %kw% OR file_name LIKE %kw%`. since/until normalized like the old `_normalize_date_filter` (date-only since -> `T00:00:00`, until -> `T23:59:59`, space -> `T`), compared against `substr(created_at,1,19)`.
- Query newest first `ORDER BY id DESC LIMIT ?`, print in reversed order (oldest first), each line:
  `[{id}] {created_at[:19]} {icon} {label}{target_info}{recipients_info}: {text_one_line}{error_info}`
  icon: `✓` success, `→` skipped, `✗` failed. label: message `文本`, photo `图片`, document `文件`. target_info ` [{source_path or file_name}]` if any. recipients_info ` -> {comma-joined usernames}` from deliveries⨝users (ordered by user id) if any. text newlines replaced by spaces, NOT truncated. error_info `  错误: {error}` if error.
- Then a blank line and `共 {n} 条记录`.

Send mode:
- Text from `--text-file` (utf-8; on error print `Error: could not read text file '<path>': <err>` exit 1), else `message`, `-` -> stdin. If no image, no file and no text -> print help, exit 1.
- `--image` path missing -> print `Error: Photo file '<path>' not found.` exit 1; `--file` missing -> `Error: Document file '<path>' not found.` exit 1. Size checks locally too: image > 10 MB -> `✗ Failed to send photo: image exceeds 10MB limit` exit 1; file > 50 MB -> `✗ Failed to send document: file exceeds 50MB limit` exit 1. These local failures are NOT logged (server not involved) — acceptable.
- If both --image and --file: image wins (old behavior).
- POST multipart to `/api/cli/send` (build the multipart body manually with a random boundary; stream file bytes; timeout 120 s).
- Output on success: `✓ Message sent successfully -> admin, bob` / `✓ Photo sent successfully -> ...` / `✓ Document sent successfully -> ...`. On status skipped: `✓ Notification skipped (no recipients after filters)` exit 0.
- On HTTP error: `✗ Failed to send message: <detail>` (label message/photo/document), exit 1. On connection error (server down): print `✗ Failed to send message: notify server unreachable at <url> (<err>)`, and log a `failed` row directly into the DB (insert into `notifications` with status failed, error text, source_path, text, type, markdown) if the DB exists and is writable; exit 1.

## 9. systemd and nginx

`deploy/notify.service` — mirror this shape:
```
[Unit]
Description=notify web push service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=notify
Group=notify
WorkingDirectory=/opt/notify
Environment=HOME=/opt/notify
Environment=LANG=C.UTF-8
Environment=LC_ALL=C.UTF-8
Environment=PYTHONUNBUFFERED=1
ExecStart=/opt/notify/.venv/bin/python -m server
Restart=always
RestartSec=3
UMask=0077
MemoryMax=300M

[Install]
WantedBy=multi-user.target
```
`server/__main__.py` runs `uvicorn.run(create_app(), host=cfg.host, port=cfg.port, proxy_headers=True, forwarded_allow_ips="::1,127.0.0.1", log_level="info", workers=1)`.
Note: the HTTPS proxy env vars must not leak into the service; pywebpush requests to push services (Apple/Google/Mozilla) go out directly.

`deploy/nginx-notify.conf`:
```
server {
    listen 80;
    listen [::]:80;
    server_name notify.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name notify.example.com;
    include /etc/nginx/tls.conf;
    client_max_body_size 2m;

    location /api/cli/ { return 404; }

    location / {
        proxy_pass http://[::1]:18794;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }
}
```
Do NOT install either file into /etc — just write them in deploy/.

## 10. Tests (pytest, all must pass with `uv run pytest -q`, total runtime < 60 s)

Use `create_app(data_dir=tmp_path, start_worker=False)` + `fastapi.testclient.TestClient` (httpx). For the worker use a fake `webpush` function injected into `PushWorker` (constructor arg `send_fn`, default the real pywebpush call) and fake clock/sleep.

Must cover at least:
- routing: topic regex cases (`#deploy done`, `# Heading` no match, `a#b` no match, `#中文话题`, `#a-b-`, dedupe case), blacklist case-insensitive, admin_blacklist, topics-only with/without topics, routed topic overrides topics-only but blacklist still applies, disabled user excluded, multiple routes union.
- auth: seeded admin login with `admin`/`changeme`, wrong password 401, rate limit 429, /api/me, logout, change password keeps current session and kills others, disabled user cannot log in / is kicked.
- registration: closed -> 403; open; invite_only wrong/right code; duplicate username 409.
- admin: create/patch/delete users, last-admin protection, delete self refused, routes CRUD, settings patch validation (push_interval_sec out of range -> 422/400).
- feed: send via `/api/cli/send` with bearer token (and 403 without token, 403 with X-Real-IP), deliveries per user, inbox/archived/history views, search `q`, `#topic` q, topic filter, cursor pagination, state endpoint (read/unread/archive/unarchive), read-all, topics endpoint counts, list truncation at 600 chars, cross-user access 404 for detail and file.
- files: photo and document upload stored under data/files, file endpoint inline vs download headers, html forced attachment, size limit 413.
- push: worker sends jobs strictly one at a time and waits `push_interval_sec` between requests (fake clock asserts gaps ≥ interval and no overlap), interval change applies to next wait, 410 deletes subscription, 500 retries with backoff up to 3 then failed, test push endpoint queues jobs, payload title/body rules.
- CLI: run `cli/notify.py` via `subprocess` against a live uvicorn server started in a background thread on a random free port on 127.0.0.1 (use `NOTIFY_URL` env + a temp config/token), covering: text send output line, `--text-file`, `--markdown`, `--image`, `--file`, missing file error text, `--history`, `--history 1`, `--search`, `--since/--until`, `--limit`, `-C` rejected (exit code 2), server-down failure logs a failed row and exits 1.

## 11. Done criteria

- `uv run pytest -q` passes.
- `uv run python -c "from server.app import create_app; create_app()"` works with the real data dir (creates data/, seeds admin, keys, token).
- Write a short report (what was built, any deviations from this spec, anything uncertain) to the `-o` report file. Do not start services, do not touch /etc, do not touch `web/`, do not commit.
