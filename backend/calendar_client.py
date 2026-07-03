from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_CALENDAR_URL = os.getenv("CALENDAR_API_URL", "https://calendrier.kb87.net")
_CALENDAR_API_TOKEN = os.getenv("CALENDAR_API_TOKEN", "")
_PRESENCE_CACHE_TTL = 300  # 5 minutes : la presence peut changer en cours de journee (override manuel)
_CHILDREN_CACHE_TTL = 3600

_presence_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_children_cache: list[dict[str, Any]] = []
_children_cache_at: float = 0.0


def is_configured() -> bool:
    return bool(_CALENDAR_API_TOKEN and _CALENDAR_URL)


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_CALENDAR_API_TOKEN}"}


def get_children() -> list[dict[str, Any]]:
    """Liste des enfants (id, name, short_label) telle que definie dans calendrier_familiale."""
    global _children_cache, _children_cache_at
    if _children_cache and (time.time() - _children_cache_at) < _CHILDREN_CACHE_TTL:
        return _children_cache
    if not is_configured():
        return []
    try:
        resp = httpx.get(f"{_CALENDAR_URL}/api/ha/children", headers=_headers(), timeout=5)
        resp.raise_for_status()
        _children_cache = resp.json().get("children", [])
        _children_cache_at = time.time()
    except Exception:
        logger.warning("calendrier_familiale: échec de récupération des enfants", exc_info=True)
    return _children_cache


def get_presence(iso_date: str) -> dict[str, Any] | None:
    """Presence des enfants pour une date donnee (garde partagee). None si indisponible."""
    if not is_configured():
        return None
    cached = _presence_cache.get(iso_date)
    if cached and (time.time() - cached[0]) < _PRESENCE_CACHE_TTL:
        return cached[1]
    try:
        resp = httpx.get(
            f"{_CALENDAR_URL}/api/ha/presence/{iso_date}", headers=_headers(), timeout=5
        )
        resp.raise_for_status()
        data = resp.json()
        _presence_cache[iso_date] = (time.time(), data)
        return data
    except Exception:
        logger.warning("calendrier_familiale: échec de récupération de la présence pour %s", iso_date, exc_info=True)
        return None
