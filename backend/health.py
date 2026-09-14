from __future__ import annotations

import sqlite3
from contextlib import closing

from fastapi.responses import JSONResponse

from menu_app import store


def readiness() -> JSONResponse:
    """Check local application storage without migrations or external calls."""
    try:
        # Read-only mode must fail if the database is missing, never create it.
        uri = store.DB_PATH.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=1.0)) as connection:
            connection.execute("SELECT id FROM meal_plans LIMIT 1").fetchone()
            connection.execute("SELECT id FROM meal_slots LIMIT 1").fetchone()
    except Exception:
        # Public endpoint: do not expose paths, database contents or errors.
        return JSONResponse(
            {"status": "unavailable"}, status_code=503,
            headers={"Cache-Control": "no-store"},
        )
    return JSONResponse({"status": "ok"}, headers={"Cache-Control": "no-store"})
