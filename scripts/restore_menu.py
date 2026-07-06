from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "menu.db"
DEFAULT_BACKUP_DIR = PROJECT_ROOT / "data" / "backups"
DEFAULT_PREFIX = "menu-hebdo"


def main() -> int:
    args = parse_args()

    archive_path = resolve_archive(args)
    checksum_path = archive_path.with_suffix(".sha256")
    if not checksum_path.exists():
        print(f"Missing checksum file: {checksum_path}", file=sys.stderr)
        return 2
    if not verify_checksum(archive_path, checksum_path):
        print("Checksum verification FAILED - refusing to restore.", file=sys.stderr)
        return 3
    print(f"Checksum OK: {archive_path.name}")

    extract_dir = args.backup_dir / "._restore_tmp"
    extract_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive_path) as zf:
            names = zf.namelist()
            if len(names) != 1:
                print(f"Unexpected archive contents: {names}", file=sys.stderr)
                return 4
            zf.extractall(extract_dir)
            snapshot_path = extract_dir / names[0]

        integrity = check_integrity(snapshot_path)
        if integrity != "ok":
            print(f"Integrity check FAILED: {integrity}", file=sys.stderr)
            return 5
        print("Integrity check: ok")

        print_summary(snapshot_path, args.db_path)

        if not args.yes:
            print()
            print("Dry run only - no changes made. Re-run with --yes to actually restore.")
            print("IMPORTANT: stop the app container first (docker compose stop <service>)")
            print("so nothing writes to the database while it is being replaced.")
            return 0

        if args.db_path.exists():
            safety_copy = args.db_path.with_name(
                args.db_path.name
                + f".pre-restore-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.bak"
            )
            shutil.copy2(args.db_path, safety_copy)
            print(f"Safety copy of current db: {safety_copy}")

        restore_into(snapshot_path, args.db_path)
        print(f"Restored {args.db_path} from {archive_path.name}")
        return 0
    finally:
        shutil.rmtree(extract_dir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Restore the menu_hebdo SQLite database from a backup archive."
    )
    parser.add_argument("--db-path", type=Path, default=Path(os.getenv("BACKUP_DB_PATH", DEFAULT_DB_PATH)))
    parser.add_argument("--backup-dir", type=Path, default=Path(os.getenv("BACKUP_DIR", DEFAULT_BACKUP_DIR)))
    parser.add_argument("--prefix", default=os.getenv("BACKUP_PREFIX", DEFAULT_PREFIX))
    parser.add_argument(
        "--archive",
        type=Path,
        default=None,
        help="Restore from this specific zip file instead of auto-selecting the latest.",
    )
    parser.add_argument(
        "--fetch-remote",
        action="store_true",
        help="Fetch the latest backup from the rclone remote instead of using local files.",
    )
    parser.add_argument("--rclone-dest", default=os.getenv("BACKUP_RCLONE_DEST", ""))
    parser.add_argument("--rclone-binary", default=os.getenv("RCLONE_BINARY", "rclone"))
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually perform the restore. Without this flag, only a dry-run summary is printed.",
    )
    return parser.parse_args()


def resolve_archive(args: argparse.Namespace) -> Path:
    if args.archive:
        return args.archive
    if args.fetch_remote:
        return fetch_latest_from_remote(args)
    candidates = sorted(args.backup_dir.glob(f"{args.prefix}-*.zip"))
    if not candidates:
        print(f"No local backups found matching {args.prefix}-*.zip in {args.backup_dir}", file=sys.stderr)
        sys.exit(2)
    return candidates[-1]


def fetch_latest_from_remote(args: argparse.Namespace) -> Path:
    remote = args.rclone_dest or os.getenv("BACKUP_RCLONE_DEST", "").strip()
    if not remote:
        print("No rclone destination configured (BACKUP_RCLONE_DEST / --rclone-dest).", file=sys.stderr)
        sys.exit(2)
    listing = subprocess.run(
        [args.rclone_binary, "lsf", remote, "--include", f"{args.prefix}-*.zip"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if not listing:
        print(f"No backups found on remote {remote}", file=sys.stderr)
        sys.exit(2)
    latest_name = sorted(listing)[-1]
    checksum_name = latest_name[: -len(".zip")] + ".sha256"
    args.backup_dir.mkdir(parents=True, exist_ok=True)
    for name in (latest_name, checksum_name):
        subprocess.run(
            [args.rclone_binary, "copyto", f"{remote}{name}", str(args.backup_dir / name)],
            check=True,
        )
    print(f"Fetched {latest_name} from {remote}")
    return args.backup_dir / latest_name


def verify_checksum(archive_path: Path, checksum_path: Path) -> bool:
    expected = checksum_path.read_text().split()[0]
    return expected == sha256_file(archive_path)


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def check_integrity(db_path: Path) -> str:
    con = sqlite3.connect(db_path)
    try:
        return con.execute("PRAGMA integrity_check;").fetchone()[0]
    finally:
        con.close()


def table_counts(db_path: Path) -> dict[str, int]:
    if not db_path.exists():
        return {}
    con = sqlite3.connect(db_path)
    try:
        tables = [
            row[0]
            for row in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        ]
        return {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in tables}
    finally:
        con.close()


def print_summary(snapshot_path: Path, live_db_path: Path) -> None:
    snap_counts = table_counts(snapshot_path)
    live_counts = table_counts(live_db_path)
    print()
    print(f"{'table':<30}{'backup':>10}{'current live':>15}")
    for table in sorted(set(snap_counts) | set(live_counts)):
        print(f"{table:<30}{snap_counts.get(table, '-'):>10}{live_counts.get(table, '-'):>15}")


def restore_into(snapshot_path: Path, target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(snapshot_path)) as source:
        with closing(sqlite3.connect(target_path)) as target:
            source.backup(target)


if __name__ == "__main__":
    raise SystemExit(main())
