from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import backup_menu as script  # noqa: E402


class BackupRemotesTest(unittest.TestCase):
    def test_parse_remotes_splits_and_trims(self) -> None:
        self.assertEqual(script.parse_remotes(""), [])
        self.assertEqual(script.parse_remotes("gdrive-crypt:"), ["gdrive-crypt:"])
        self.assertEqual(
            script.parse_remotes(" gdrive-crypt: , b2-crypt:bucket ,, "),
            ["gdrive-crypt:", "b2-crypt:bucket"],
        )

    def test_one_failing_remote_does_not_block_the_others(self) -> None:
        calls: list[str] = []

        def fake_copy(archive: Path, checksum: Path, remote: str, binary: str) -> None:
            calls.append(remote)
            if remote == "first:":
                raise subprocess.CalledProcessError(1, "rclone")

        with mock.patch.object(script, "copy_to_remote", fake_copy):
            outcome = script.copy_to_remotes(Path("a.zip"), Path("a.sha256"), ["first:", "second:"], "rclone")

        self.assertEqual(calls, ["first:", "second:"])
        self.assertEqual([o["ok"] for o in outcome], [False, True])
        self.assertEqual([o["dest"] for o in outcome], ["first:", "second:"])


if __name__ == "__main__":
    unittest.main()
