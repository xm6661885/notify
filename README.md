# Notify

Self-hosted, multi-user Web Push notification center. It ships as an installable PWA plus a tiny `notify` command line tool, so any script, cron job or AI agent on your server can push a message to every phone and desktop you own:

```bash
notify "Backup finished #backup"
```

No third-party notification app, no Firebase project, no account with anyone. Just standard Web Push (VAPID) from your own box.

## Features

- **One-line CLI.** `notify "text #topic"`, images, files, Markdown, stdin. The command returns as soon as the server stores the message, so it never blocks your scripts.
- **PWA client.** Cards with search and `#topic` filters, read/unread state, archive by long-press or multi-select, full history, and a detail page that renders Markdown with copy and download. Light and dark themes follow the system.
- **Works on every major platform.** iPhone/iPad (iOS 16.4+, added to Home Screen), Android, macOS, Windows and Linux via Chrome, Edge, Firefox or Safari. An in-app guide walks through each one.
- **Multi-user with routing.**
  - Everyone receives every notification by default.
  - Each user can keep a keyword blacklist; the admin can add a separate per-user blacklist too.
  - A user can opt to receive only selected topics.
  - The admin can restrict a topic to chosen users.
- **Webhooks.** Each user can forward the notifications they receive to any HTTP endpoint (Telegram bot, chat bots, Slack-style hooks, ...) with URL/header/body templates. Non-admin webhooks may only target public addresses (SSRF protection).
- **Reliable delivery.** Push and webhook sending run in serial background workers with a configurable gap. Failures appear in Admin > Delivery, where they can be retried or cleared. Dead subscriptions (404/410) are removed automatically.
- **Optional HTTP proxy** per push service (Google FCM, Apple, Mozilla, Microsoft) and per webhook, for hosts where some push endpoints are blocked.
- **Light footprint.** FastAPI + SQLite, one process, runs fine on a 2 GB Atom box.

## Architecture

```
 scripts / cron / agents
          |  notify CLI (stdlib only, loopback + token)
          v
 +--------------------+      SQLite (data/notify.db)
 |  FastAPI server    | ---- files (data/files/)
 |  routing, auth     |
 +--------------------+
     |            |
 push worker   webhook worker   (serial queues)
     |            |
 Web Push       HTTP endpoints
 (FCM/APNs/...)
     |
 PWA on phones & desktops  <-- nginx (HTTPS) --> same server serves web/dist
```

```
server/        FastAPI backend: app.py routes, db.py SQLite, routing.py, push.py, webhooks.py, auth.py
cli/notify.py  CLI (Python stdlib only), launched through bin/notify
web/           Preact + Vite PWA (src/pages, src/components, src/lib, src/styles, public/sw.js)
deploy/        example systemd unit and nginx site
docs/          original backend/API/DB specification
tests/         pytest suite
data/          runtime data (created on first start, not in git)
```

## Requirements

- Linux server with Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node.js 18+ (only to build the frontend)
- A domain with HTTPS. Web Push and service workers require a secure origin.
- nginx or another reverse proxy

## Installation

```bash
git clone https://github.com/xm6661885/notify.git /opt/notify
cd /opt/notify

# backend
uv sync

# frontend
cd web && npm ci && npm run build && cd ..

# first start: creates data/, the VAPID key, the CLI token and the admin user
.venv/bin/python -m server
```

On first start the server creates:

| File | Purpose |
| --- | --- |
| `data/config.json` | listen address, public URL, VAPID contact |
| `data/vapid_private.pem` | VAPID key. **Back it up and never delete it**; every subscription is bound to it. |
| `data/cli_token` | secret used by the local CLI |
| `data/notify.db` | SQLite database |
| `data/files/` | uploaded images and files |

The default admin account is `admin` / `changeme`. Sign in and change it right away in Settings, or reset it from the shell:

```bash
.venv/bin/python -m server reset-password admin NEW_PASSWORD
```

### Configuration

Edit `data/config.json` and restart:

```json
{
  "host": "::1",
  "port": 18794,
  "public_url": "https://notify.example.com",
  "vapid_subject": "mailto:admin@example.com"
}
```

- `host`, `port`: where the service listens. Keep it on loopback behind the reverse proxy.
- `public_url`: the public HTTPS origin, used for links in pushes and webhooks.
- `vapid_subject`: contact address sent to push services.

Proxy URL, which push services use the proxy, push interval and other runtime options are admin settings inside the app (Admin page).

### systemd

```bash
sudo useradd --system --home /opt/notify notify
sudo chown -R notify:notify /opt/notify
sudo cp deploy/notify.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now notify
journalctl -u notify -f
```

Adjust `User`, `WorkingDirectory` and paths in the unit to match your setup.

### nginx

`deploy/nginx-notify.conf` is a complete example. Replace `notify.example.com` and the certificate paths, then:

```bash
sudo cp deploy/nginx-notify.conf /etc/nginx/sites-enabled/notify.conf
sudo nginx -t && sudo systemctl reload nginx
```

Keep the `location /api/cli/ { return 404; }` block. The CLI endpoint must only be reachable from loopback.

### Install the CLI

```bash
ln -s /opt/notify/bin/notify ~/.local/bin/notify
```

The CLI reads `data/config.json` and `data/cli_token` (pass `-c PATH` to use another config) and posts to `http://[host]:port/api/cli/send`. The users running it need read access to those two files.

## CLI usage

```bash
notify "Deploy done #ops"                    # plain text, #topics are parsed from the text
notify --markdown --text-file report.md      # Markdown body from a file
notify --image chart.png "Daily chart #money" # image with caption
notify --file backup.log                     # attach a file
echo "from a pipe" | notify -                # read from stdin

notify --history 20                          # last 20 notifications
notify --search deploy                       # search history
notify --since 2026-10-01 --until 2026-10-04 --limit 100
```

Output is stable for scripting: success prints `✓ Message sent successfully` and exits 0. Exit status only means the server stored the message; delivery problems are shown in the admin Delivery page, not in the CLI.

History lines look like:

```
[id] time icon label [target] -> users: text
```

## Topics and routing

Any `#word` in a message is a topic. Users can filter by topic in the app, subscribe only to some topics, and the admin can route a topic to specific users. Keyword blacklists (user-owned and admin-owned) drop matching notifications for that user.

## Webhooks

Settings > Webhooks. Each webhook has a method, URL, headers and a body (JSON or plain text), optionally limited to some topics. Placeholders work in the URL, headers and body:

| Placeholder | Value |
| --- | --- |
| `{{text}}` | full text |
| `{{title}}` | first line / title |
| `{{body}}` | body text |
| `{{topics}}` | `#a #b` |
| `{{url}}` | link to the notification in the PWA |
| `{{id}}`, `{{type}}`, `{{file_name}}`, `{{time}}`, `{{user}}` | metadata |

Add `:N` to truncate, for example `{{text:4096}}` for Telegram. Built-in presets cover Telegram bots and OneBot-style QQ bots. Each webhook has its own "Use HTTP proxy" switch.

## Subscribing devices

Open the site, sign in, then Settings > Web push on each device:

- **iPhone / iPad:** iOS 16.4 or later. Share > Add to Home Screen, then open the app from that icon and enable push.
- **Android:** Chrome or another browser with push support.
- **macOS:** Safari or Chrome.
- **Windows / Linux:** Chrome, Edge or Firefox.

## Development

```bash
uv run pytest -q                 # backend + CLI tests
cd web
npm run dev                      # Vite dev server, proxies the API to NOTIFY_BACKEND (default http://[::1]:18794)
npx tsc --noEmit                 # type check
npm run build                    # production build to web/dist
```

When you change the app shell or service worker, bump `CACHE` in `web/public/sw.js` so clients pick up the update. `docs/backend-spec.md` describes the original API and DB contract; the code is the source of truth.

## Security notes

- Registration, login rate limiting, session invalidation on password change and disabled users are built in.
- The CLI endpoint accepts only loopback requests carrying the token.
- Webhook URLs can contain secrets (for example bot tokens); treat the database as sensitive.
- Back up `data/` regularly.

## License

MIT
