"""Run the service or reset an account password."""
from __future__ import annotations

import sys

import uvicorn

from . import db
from .app import create_app
from .auth import hash_password, validate_password


def main() -> None:
    app = create_app()
    if len(sys.argv) == 4 and sys.argv[1] == "reset-password":
        username, password = sys.argv[2:]
        validate_password(password)
        user = db.get_user(app.state.db_path, username=username)
        if not user:
            raise SystemExit(f"User not found: {username}")
        db.patch_user(app.state.db_path, user["id"], {"pw_hash": hash_password(password), "pw_changed_at": db.now_iso()})
        print(f"Password reset for {user['username']}")
        return
    if len(sys.argv) != 1:
        raise SystemExit("Usage: python -m server [reset-password USER PASS]")
    config = app.state.config
    uvicorn.run(app, host=config.host, port=config.port, proxy_headers=True,
                forwarded_allow_ips="::1,127.0.0.1", log_level="info", workers=1)


if __name__ == "__main__":
    main()
