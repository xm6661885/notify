from pathlib import Path

import pytest
import uvloop
from fastapi.testclient import TestClient

from server.app import create_app

uvloop.install()


@pytest.fixture
def app(tmp_path: Path):
    return create_app(data_dir=tmp_path, start_worker=False)


@pytest.fixture
def client(app):
    with TestClient(app, backend_options={"use_uvloop": True}) as test_client:
        yield test_client


@pytest.fixture
def admin(client):
    result = client.post("/api/login", json={"username": "admin", "password": "changeme"})
    assert result.status_code == 200, result.text
    return client


@pytest.fixture
def cli_headers(app):
    return {"Authorization": f"Bearer {app.state.cli_token}"}
