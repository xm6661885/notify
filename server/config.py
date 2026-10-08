"""Persistent service configuration."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .paths import atomic_write

DEFAULTS = {
    "host": "::1",
    "port": 18794,
    "public_url": "https://notify.example.com",
    "vapid_subject": "mailto:admin@example.com",
}


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    public_url: str
    vapid_subject: str


def load_config(directory: Path) -> Config:
    path = directory / "config.json"
    if not path.exists():
        atomic_write(path, (json.dumps(DEFAULTS, ensure_ascii=False, indent=2) + "\n").encode())
    values = {**DEFAULTS, **json.loads(path.read_text(encoding="utf-8"))}
    return Config(**{key: values[key] for key in DEFAULTS})
