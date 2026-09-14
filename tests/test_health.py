from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from backend import health


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.db"
        self.patch = patch.object(health.store, "DB_PATH", self.path)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def create_database(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute("CREATE TABLE meal_plans (id TEXT)")
            connection.execute("CREATE TABLE meal_slots (id TEXT)")

    def assert_unavailable(self):
        response = health.readiness()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(json.loads(response.body), {"status": "unavailable"})
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_ready_with_empty_valid_database(self):
        self.create_database()
        before = self.path.read_bytes()
        response = health.readiness()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body), {"status": "ok"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(self.path.read_bytes(), before)

    def test_missing_database_is_not_created(self):
        self.assert_unavailable()
        self.assertFalse(self.path.exists())

    def test_missing_schema_is_not_repaired(self):
        with sqlite3.connect(self.path):
            pass
        self.assert_unavailable()
        with sqlite3.connect(self.path) as connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master").fetchall(), [])

    def test_corrupt_database_does_not_leak_details(self):
        self.path.write_bytes(b"private diagnostic data: not a database")
        self.assert_unavailable()

    def test_locked_database_has_bounded_wait(self):
        self.create_database()
        connection = sqlite3.connect(self.path)
        try:
            connection.execute("BEGIN EXCLUSIVE")
            start = time.monotonic()
            self.assert_unavailable()
            self.assertLess(time.monotonic() - start, 2.5)
        finally:
            connection.close()

    def test_route_get_only_and_no_startup_needed(self):
        from fastapi.testclient import TestClient
        from backend.main import app
        self.create_database()
        client = TestClient(app)
        self.assertEqual(client.get("/api/ready").status_code, 200)
        self.assertEqual(client.post("/api/ready").status_code, 405)

