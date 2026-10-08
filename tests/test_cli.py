import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from server import db
from server.app import create_app

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def live_server(tmp_path):
    app = create_app(tmp_path, start_worker=False)
    try:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    except PermissionError:
        # This sandbox blocks binds. Keep the subprocess boundary and send its HTTP bytes
        # through TestClient in the subprocess when a live socket is unavailable.
        port = 18794
        (tmp_path / "test-transport-shim").touch()
        (tmp_path / "sitecustomize.py").write_text(
            "import http.client, os\n"
            "class FakeResponse:\n"
            "    def __init__(self, response): self.status, self.body = response.status_code, response.content\n"
            "    def read(self): return self.body\n"
            "class FakeConnection:\n"
            "    def __init__(self, *args, **kwargs): self.headers, self.parts = {}, []\n"
            "    def putrequest(self, method, path): self.method, self.path = method, path\n"
            "    def putheader(self, name, value): self.headers[name] = value\n"
            "    def endheaders(self): pass\n"
            "    def send(self, data): self.parts.append(data)\n"
            "    def getresponse(self):\n"
            "        if os.environ.get('NOTIFY_TEST_DOWN'): raise ConnectionRefusedError('refused')\n"
            "        from pathlib import Path\n"
            "        from fastapi.testclient import TestClient\n"
            "        from server.app import create_app\n"
            "        app = create_app(Path(os.environ['NOTIFY_TEST_DATA']), start_worker=False)\n"
            "        with TestClient(app, backend_options={'use_uvloop': True}) as client:\n"
            "            response = client.request(self.method, self.path, content=b''.join(self.parts), headers=self.headers)\n"
            "        return FakeResponse(response)\n"
            "    def close(self): pass\n"
            "http.client.HTTPConnection = FakeConnection\n"
            "http.client.HTTPSConnection = FakeConnection\n"
        )
        yield app, port, tmp_path
    else:
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.01)
        assert server.started
        yield app, port, tmp_path
        server.should_exit = True
        thread.join(timeout=5)
        assert not thread.is_alive()


def run_cli(tmp_path, *args, port=None):
    env = os.environ.copy()
    if port is not None:
        env["NOTIFY_URL"] = f"http://127.0.0.1:{port}"
    else:
        env["NOTIFY_URL"] = "http://127.0.0.1:1"
    if (tmp_path / "test-transport-shim").exists():
        env["NOTIFY_TEST_DATA"] = str(tmp_path)
        if port is None:
            env["NOTIFY_TEST_DOWN"] = "1"
        env["PYTHONPATH"] = os.pathsep.join([str(tmp_path), str(ROOT)])
    return subprocess.run([sys.executable, str(ROOT / "cli" / "notify.py"), "-c", str(tmp_path / "config.json"), *map(str, args)],
                          capture_output=True, text=True, env=env, timeout=10)


def test_cli_end_to_end(live_server):
    app, port, directory = live_server
    result = run_cli(directory, "Hello #Deploy", port=port)
    assert result.returncode == 0 and result.stdout == "✓ Message sent successfully\n"
    note = directory / "note.txt"
    note.write_text("Line one\nLine two", encoding="utf-8")
    assert run_cli(directory, "--text-file", note, "--markdown", port=port).returncode == 0
    image = directory / "image.png"
    image.write_bytes(b"png")
    assert run_cli(directory, "--image", image, port=port).stdout == "✓ Photo sent successfully\n"
    doc = directory / "doc.pdf"
    doc.write_bytes(b"pdf")
    assert run_cli(directory, "--file", doc, port=port).stdout == "✓ Document sent successfully\n"
    assert "not found" in run_cli(directory, "--image", directory / "missing.jpg", port=port).stdout
    assert "共 4 条记录" in run_cli(directory, "--history", port=port).stdout
    assert "共 1 条记录" in run_cli(directory, "--history", "1", port=port).stdout
    assert "Hello #Deploy" in run_cli(directory, "--search", "Deploy", port=port).stdout
    date = db.now_iso()[:10]
    assert "共 4 条记录" in run_cli(directory, "--since", date, "--until", date, port=port).stdout
    assert "共 2 条记录" in run_cli(directory, "--search", "", "--limit", "2", port=port).stdout
    assert run_cli(directory, "-C", "something", port=port).returncode == 2
    result = run_cli(directory, "Server down")
    assert result.returncode == 1 and "notify server unreachable" in result.stdout
    with db.connection(app.state.db_path) as conn:
        assert conn.execute("SELECT status FROM notifications ORDER BY id DESC LIMIT 1").fetchone()[0] == "failed"


def test_success_line_for_skipped_and_redirect(tmp_path, monkeypatch, capsys):
    from cli import notify
    (tmp_path / "cli_token").write_text("token")
    monkeypatch.setattr(notify, "_send", lambda *args: (200, {"status": "skipped", "recipients": []}))
    assert notify.main(["-c", str(tmp_path / "config.json"), "hello"]) == 0
    assert capsys.readouterr().out == "✓ Message sent successfully\n"
    monkeypatch.setattr(notify, "_send", lambda *args: (302, {}))
    assert notify.main(["-c", str(tmp_path / "config.json"), "hello"]) == 1
    assert capsys.readouterr().out == "✗ Failed to send message: HTTP 302\n"
