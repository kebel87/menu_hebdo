from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import subprocess
import sys
import zipfile
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "menu.db"
DEFAULT_BACKUP_DIR = PROJECT_ROOT / "data" / "backups"


@dataclass(frozen=True)
class BackupResult:
    archive_path: Path
    checksum_path: Path
    digest: str


def main() -> int:
    args = parse_args()
    db_path = args.db_path
    backup_dir = args.backup_dir

    if not db_path.exists():
        print(f"Database not found: {db_path}", file=sys.stderr)
        return 2

    backup_dir.mkdir(parents=True, exist_ok=True)
    result = create_backup(db_path, backup_dir, args.prefix)
    print(f"Created {result.archive_path}")
    print(f"SHA256 {result.digest}")

    prune_local_backups(backup_dir, args.prefix, args.keep_local)

    remote = args.rclone_dest or os.getenv("BACKUP_RCLONE_DEST", "").strip()
    if remote:
        copy_to_remote(result.archive_path, result.checksum_path, remote, args.rclone_binary)
        print(f"Copied backup to {remote}")

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a consistent menu SQLite backup.")
    parser.add_argument(
        "--db-path",
        type=Path,
        default=Path(os.getenv("BACKUP_DB_PATH", DEFAULT_DB_PATH)),
        help="SQLite database path. Defaults to data/menu.db.",
    )
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=Path(os.getenv("BACKUP_DIR", DEFAULT_BACKUP_DIR)),
        help="Local backup directory. Defaults to data/backups.",
    )
    parser.add_argument(
        "--prefix",
        default=os.getenv("BACKUP_PREFIX", "menu-hebdo"),
        help="Backup filename prefix.",
    )
    parser.add_argument(
        "--keep-local",
        type=int,
        default=int(os.getenv("BACKUP_KEEP_LOCAL", "14")),
        help="Number of local ZIP archives to keep.",
    )
    parser.add_argument(
        "--rclone-dest",
        default=os.getenv("BACKUP_RCLONE_DEST", ""),
        help="Optional rclone destination, for example gdrive-crypt:MenuHebdo/backups.",
    )
    parser.add_argument(
        "--rclone-binary",
        default=os.getenv("RCLONE_BINARY", "rclone"),
        help="rclone executable path.",
    )
    return parser.parse_args()


def create_backup(db_path: Path, backup_dir: Path, prefix: str) -> BackupResult:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    snapshot_path = backup_dir / f"{prefix}-{timestamp}.sqlite"
    archive_path = backup_dir / f"{prefix}-{timestamp}.zip"
    checksum_path = backup_dir / f"{prefix}-{timestamp}.sha256"

    snapshot_sqlite(db_path, snapshot_path)
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot_path, arcname=snapshot_path.name)
        digest = sha256_file(archive_path)
        checksum_path.write_text(f"{digest}  {archive_path.name}\n", encoding="utf-8")
    finally:
        snapshot_path.unlink(missing_ok=True)

    return BackupResult(archive_path=archive_path, checksum_path=checksum_path, digest=digest)


def snapshot_sqlite(source_path: Path, target_path: Path) -> None:
    with closing(sqlite3.connect(source_path)) as source:
        with closing(sqlite3.connect(target_path)) as target:
            source.backup(target)


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def prune_local_backups(backup_dir: Path, prefix: str, keep: int) -> None:
    if keep <= 0:
        return
    archives = sorted(
        backup_dir.glob(f"{prefix}-*.zip"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for archive in archives[keep:]:
        checksum = archive.with_suffix(".sha256")
        archive.unlink(missing_ok=True)
        checksum.unlink(missing_ok=True)


def copy_to_remote(archive_path: Path, checksum_path: Path, remote: str, rclone_binary: str) -> None:
    command = [
        rclone_binary,
        "copy",
        str(archive_path.parent),
        remote,
        "--include",
        archive_path.name,
        "--include",
        checksum_path.name,
        "--exclude",
        "*",
    ]
    subprocess.run(command, check=True)


if __name__ == "__main__":
    raise SystemExit(main())
