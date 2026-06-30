from __future__ import annotations

import os
import time
from typing import Any

import httpx

_INVENTAIRE_URL = os.getenv("INVENTAIRE_API_URL", "")
_SERVICE_KEY = os.getenv("SERVICE_API_KEY", "")
_CACHE_TTL = 300  # 5 minutes

_cache: list[dict[str, Any]] = []
_cache_at: float = 0.0


def _headers() -> dict[str, str]:
    h: dict[str, str] = {}
    if _SERVICE_KEY:
        h["X-Service-Key"] = _SERVICE_KEY
    return h


def get_inventory(force: bool = False) -> list[dict[str, Any]]:
    global _cache, _cache_at
    if not _INVENTAIRE_URL:
        return []
    if not force and _cache and (time.time() - _cache_at) < _CACHE_TTL:
        return _cache
    try:
        items: list[dict] = []
        for domain in ("frozen", "household"):
            resp = httpx.get(
                f"{_INVENTAIRE_URL}/api/items",
                params={"domain": domain, "status": "active"},
                headers=_headers(),
                timeout=5,
            )
            resp.raise_for_status()
            items.extend(resp.json())
        _cache = items
        _cache_at = time.time()
    except Exception:
        pass
    return _cache


def inventory_score(
    ingredients: list[dict], inventory: list[dict] | None = None
) -> dict[str, Any]:
    if inventory is None:
        inventory = get_inventory()
    if not inventory:
        return {"score": None, "missing": [], "available": []}
    inv_names = {item.get("name", "").lower().strip() for item in inventory}
    found: list[str] = []
    missing: list[str] = []
    for ing in ingredients:
        name = ing.get("name", "") or ing.get("display", "") or ""
        name = name.lower().strip()
        if not name:
            continue
        if any(name in inv or inv in name for inv in inv_names):
            found.append(ing.get("name") or ing.get("display") or name)
        else:
            missing.append(ing.get("name") or ing.get("display") or name)
    total = len(found) + len(missing)
    return {
        "score": round(len(found) / total, 2) if total > 0 else None,
        "missing": missing,
        "available": found,
    }


def is_configured() -> bool:
    return bool(_INVENTAIRE_URL and _SERVICE_KEY)
