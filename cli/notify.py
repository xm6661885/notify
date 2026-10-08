#!/usr/bin/env python3
"""Send notifications and inspect the local send history."""
from __future__ import annotations

import argparse
import http.client
import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parent.parent


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Send notifications to the notify web push service",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n  notify 'Hello #team'\n  notify --image photo.jpg 'A caption'\n  notify --file report.pdf\n  notify --history 20\n  notify --search deploy",
    )
    result.add_argument("message", nargs="?")
    result.add_argument("-i", "--image", metavar="PATH")
    result.add_argument("-f", "--file", metavar="PATH")
    result.add_argument("-m", "--markdown", action="store_true")
    result.add_argument("-t", "--text-file", metavar="PATH")
    result.add_argument("-c", "--config", default=str(ROOT / "data" / "config.json"), metavar="PATH")
    result.add_argument("--history", nargs="?", type=int, const=20, metavar="N")
    result.add_argument("--search", metavar="KEYWORD")
    result.add_argument("--since", metavar="DATE")
    result.add_argument("--until", metavar="DATE")
    result.add_argument("--limit", type=int, default=20, metavar="N")
    return result


def _date_filter(value: str, end: bool) -> str:
    value = value.strip().replace(" ", "T", 1)
    if len(value) == 10:
        return value + ("T23:59:59" if end else "T00:00:00")
    return value[:19]


def history(args: argparse.Namespace, directory: Path) -> int:
    db_path = directory / "notify.db"
    if not db_path.is_file():
        print("暂无历史发送记录")
        return 0
    limit = args.history if args.history is not None else args.limit
    if limit < 1:
        print("未找到匹配的历史记录")
        return 0
    clauses = []
    params: list = []
    if args.search:
        clauses.append("(n.text LIKE ? OR n.file_name LIKE ?)")
        params.extend([f"%{args.search}%"] * 2)
    if args.since:
        clauses.append("substr(n.created_at,1,19)>=?")
        params.append(_date_filter(args.since, False))
    if args.until:
        clauses.append("substr(n.created_at,1,19)<=?")
        params.append(_date_filter(args.until, True))
    sql = "SELECT n.* FROM notifications n"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY n.id DESC LIMIT ?"
    params.append(limit)
    uri = "file:" + quote(str(db_path)) + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(sql, params).fetchall()
        if not rows:
            print("未找到匹配的历史记录")
            return 0
        for row in reversed(rows):
            users = [item[0] for item in conn.execute("SELECT u.username FROM deliveries d JOIN users u ON u.id=d.user_id WHERE d.notification_id=? ORDER BY u.id", (row["id"],))]
            icon = {"success": "✓", "skipped": "→", "failed": "✗"}.get(row["status"], "?")
            label = {"message": "文本", "photo": "图片", "document": "文件"}.get(row["type"], row["type"])
            target = row["source_path"] or row["file_name"]
            target_info = f" [{target}]" if target else ""
            recipients_info = " -> " + ", ".join(users) if users else ""
            content = (row["text"] or "").replace("\r", " ").replace("\n", " ")
            error_info = f"  错误: {row['error']}" if row["error"] else ""
            print(f"[{row['id']}] {row['created_at'][:19]} {icon} {label}{target_info}{recipients_info}: {content}{error_info}")
    print(f"\n共 {len(rows)} 条记录")
    return 0


def _read_config(path: Path) -> tuple[str, Path]:
    config = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    host = config.get("host", "::1")
    port = config.get("port", 18794)
    default_url = f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"
    url = os.environ.get("NOTIFY_URL") or config.get("url") or default_url
    token_file = Path(config.get("token_file", "cli_token"))
    if not token_file.is_absolute():
        token_file = path.parent / token_file
    return url.rstrip("/"), token_file


def _part(boundary: str, name: str, value: str) -> bytes:
    return (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").encode("utf-8")


def _send(url: str, token: str, kind: str, text: str | None, markdown: bool, source_path: str | None, path: Path | None) -> tuple[int, dict]:
    boundary = "----notify-" + uuid.uuid4().hex
    parts = [_part(boundary, "type", kind), _part(boundary, "markdown", "1" if markdown else "0")]
    if text is not None:
        parts.append(_part(boundary, "text", text))
    if source_path is not None:
        parts.append(_part(boundary, "source_path", source_path))
    if path is not None:
        filename = path.name.replace('"', "_").replace("\r", "_").replace("\n", "_")
        header = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode("utf-8")
        parts.append(header)
    ending = f"\r\n--{boundary}--\r\n".encode() if path is not None else f"--{boundary}--\r\n".encode()
    length = sum(map(len, parts)) + (path.stat().st_size if path else 0) + len(ending)
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"Invalid URL: {url}")
    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    conn = connection_type(parsed.hostname, parsed.port, timeout=120)
    endpoint = (parsed.path.rstrip("/") if parsed.path else "") + "/api/cli/send"
    try:
        conn.putrequest("POST", endpoint)
        conn.putheader("Authorization", f"Bearer {token}")
        conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        conn.putheader("Content-Length", str(length))
        conn.endheaders()
        for part in parts:
            conn.send(part)
        if path:
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    conn.send(chunk)
        conn.send(ending)
        response = conn.getresponse()
        raw = response.read()
        return response.status, json.loads(raw.decode("utf-8"))
    finally:
        conn.close()


def _log_failed(directory: Path, kind: str, text: str | None, markdown: bool, source_path: str | None, error: str) -> None:
    db_path = directory / "notify.db"
    if not db_path.is_file():
        return
    from datetime import datetime
    try:
        with sqlite3.connect(db_path, timeout=10) as conn:
            conn.execute("INSERT INTO notifications(created_at,type,text,markdown,source_path,status,error) VALUES(?,?,?,?,?,'failed',?)",
                         (datetime.now().astimezone().isoformat(timespec="seconds"), kind, text, int(markdown), source_path, error))
    except sqlite3.Error:
        pass


def main(argv: list[str] | None = None) -> int:
    arg_parser = parser()
    args = arg_parser.parse_args(argv)
    config_path = Path(args.config).expanduser().resolve()
    directory = config_path.parent
    if args.history is not None or args.search is not None or args.since is not None or args.until is not None:
        return history(args, directory)
    if args.text_file:
        try:
            text = Path(args.text_file).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            print(f"Error: could not read text file '{args.text_file}': {exc}")
            return 1
    elif args.message == "-":
        text = sys.stdin.read()
    else:
        text = args.message
    if not args.image and not args.file and not text:
        arg_parser.print_help()
        return 1
    kind = "photo" if args.image else "document" if args.file else "message"
    selected = args.image or args.file
    path = Path(selected) if selected else None
    if path and not path.is_file():
        if kind == "photo":
            print(f"Error: Photo file '{selected}' not found.")
        else:
            print(f"Error: Document file '{selected}' not found.")
        return 1
    if path:
        limit = 10 * 1024 * 1024 if kind == "photo" else 50 * 1024 * 1024
        if path.stat().st_size > limit:
            print(f"✗ Failed to send {kind}: {'image exceeds 10MB limit' if kind == 'photo' else 'file exceeds 50MB limit'}")
            return 1
    url, token_path = _read_config(config_path)
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        print(f"✗ Failed to send {kind}: could not read CLI token ({exc})")
        return 1
    try:
        code, result = _send(url, token, kind, text, args.markdown, selected, path)
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        error = f"notify server unreachable at {url} ({exc})"
        print(f"✗ Failed to send {kind}: {error}")
        _log_failed(directory, kind, text, args.markdown, selected, error)
        return 1
    if not 200 <= code < 300:
        print(f"✗ Failed to send {kind}: {result.get('detail', 'HTTP ' + str(code))}")
        return 1
    label = {"message": "Message", "photo": "Photo", "document": "Document"}[kind]
    print(f"✓ {label} sent successfully")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
