from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from scripts.backup_menu import copy_to_remotes, create_backup, parse_remotes, prune_local_backups


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT / "data" / "menu.db"
DEFAULT_BACKUP_DIR = ROOT / "data" / "backups"


def backup_settings() -> dict[str, Any]:
    db_path = Path(os.getenv("BACKUP_DB_PATH", DEFAULT_DB_PATH))
    backup_dir = Path(os.getenv("BACKUP_DIR", DEFAULT_BACKUP_DIR))
    keep_local = int(os.getenv("BACKUP_KEEP_LOCAL", "14"))
    rclone_dest = os.getenv("BACKUP_RCLONE_DEST", "").strip()
    rclone_binary = os.getenv("RCLONE_BINARY", "rclone").strip() or "rclone"
    rclone_config = os.getenv("RCLONE_CONFIG", "").strip()
    return {
        "dbPath": str(db_path),
        "backupDir": str(backup_dir),
        "prefix": os.getenv("BACKUP_PREFIX", "menu-hebdo"),
        "keepLocal": keep_local,
        "rcloneDest": rclone_dest,
        "rcloneBinary": rclone_binary,
        "rcloneConfig": rclone_config,
        "rcloneConfigured": bool(parse_remotes(rclone_dest)) and (not rclone_config or Path(rclone_config).exists()),
        "databaseExists": db_path.exists(),
    }


def list_backup_archives() -> list[dict[str, Any]]:
    settings = backup_settings()
    backup_dir = Path(settings["backupDir"])
    prefix = str(settings["prefix"])
    if not backup_dir.exists():
        return []
    return [
        backup_file_info(path)
        for path in sorted(
            backup_dir.glob(f"{prefix}-*.zip"),
            key=lambda entry: entry.stat().st_mtime,
            reverse=True,
        )
    ]


def backup_file_info(path: Path) -> dict[str, Any]:
    checksum_path = path.with_suffix(".sha256")
    checksum = ""
    if checksum_path.exists():
        checksum = checksum_path.read_text(encoding="utf-8").split()[0]
    return {
        "name": path.name,
        "checksumName": checksum_path.name if checksum_path.exists() else "",
        "size": path.stat().st_size,
        "createdAt": created_at_from_name(path) or path.stat().st_mtime,
        "checksum": checksum,
    }


def created_at_from_name(path: Path) -> str:
    parts = path.stem.rsplit("-", 1)
    if len(parts) != 2:
        return ""
    stamp = parts[1]
    if len(stamp) != 16 or not stamp.endswith("Z"):
        return ""
    return f"{stamp[0:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[9:11]}:{stamp[11:13]}:{stamp[13:15]}Z"


def backup_status() -> dict[str, Any]:
    settings = backup_settings()
    files = list_backup_archives()
    return {
        "settings": {
            "backupDir": settings["backupDir"],
            "keepLocal": settings["keepLocal"],
            "rcloneDest": settings["rcloneDest"],
            "rcloneConfigured": settings["rcloneConfigured"],
            "databaseExists": settings["databaseExists"],
        },
        "files": files,
        "lastBackup": files[0] if files else None,
    }


def run_backup() -> dict[str, Any]:
    settings = backup_settings()
    db_path = Path(settings["dbPath"])
    backup_dir = Path(settings["backupDir"])
    if not db_path.exists():
        raise FileNotFoundError(str(db_path))

    backup_dir.mkdir(parents=True, exist_ok=True)
    result = create_backup(db_path, backup_dir, str(settings["prefix"]))
    prune_local_backups(backup_dir, str(settings["prefix"]), int(settings["keepLocal"]))

    remotes = parse_remotes(str(settings["rcloneDest"]))
    destinations = copy_to_remotes(
        result.archive_path, result.checksum_path, remotes, str(settings["rcloneBinary"])
    )
    errors = [f"{d['dest']}: {d['error']}" for d in destinations if not d["ok"]]
    remote_result: dict[str, Any] = {
        "enabled": bool(remotes),
        "ok": not errors,
        "error": "; ".join(errors),
        "destinations": destinations,
    }

    return {
        "created": backup_file_info(result.archive_path),
        "remote": remote_result,
        **backup_status(),
    }


def backup_download_path(filename: str) -> Path:
    name = Path(filename).name
    if name != filename or not (name.endswith(".zip") or name.endswith(".sha256")):
        raise ValueError("Invalid backup filename")
    backup_dir = Path(backup_settings()["backupDir"]).resolve()
    path = (backup_dir / name).resolve()
    if backup_dir not in path.parents:
        raise ValueError("Invalid backup filename")
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(name)
    return path
