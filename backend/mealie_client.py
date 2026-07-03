from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_MEALIE_URL = os.getenv("MEALIE_URL", "https://mealie.kb87.net")
_MEALIE_API_KEY = os.getenv("MEALIE_API_KEY", "")
_CACHE_TTL = 3600  # 1 heure

_recipe_list_cache: dict[str, Any] = {}
_recipe_list_cache_at: float = 0.0
_recipe_detail_cache: dict[str, Any] = {}
_recipe_detail_cache_at: float = 0.0
_tag_cache: list[str] = []
_tag_cache_at: float = 0.0


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_MEALIE_API_KEY}"}


def _get(path: str) -> Any:
    url = f"{_MEALIE_URL}/api{path}"
    resp = httpx.get(url, headers=_headers(), timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_recipes(force: bool = False) -> list[dict[str, Any]]:
    """Vue LISTE (résumé, sans recipeIngredient) — voir get_recipe() pour le détail complet."""
    global _recipe_list_cache, _recipe_list_cache_at
    if not force and _recipe_list_cache and (time.time() - _recipe_list_cache_at) < _CACHE_TTL:
        return list(_recipe_list_cache.values())
    data = _get("/recipes?perPage=1000")
    items = data.get("items", data) if isinstance(data, dict) else data
    _recipe_list_cache = {r["slug"]: r for r in items if "slug" in r}
    _recipe_list_cache_at = time.time()
    _refresh_tag_cache(items)
    return list(_recipe_list_cache.values())


def get_recipe(slug: str) -> dict[str, Any] | None:
    """Vue DÉTAIL (inclut recipeIngredient) — cache séparé de get_recipes() car
    l'endpoint liste de Mealie ne renvoie pas les ingrédients."""
    global _recipe_detail_cache, _recipe_detail_cache_at
    if (time.time() - _recipe_detail_cache_at) >= _CACHE_TTL:
        _recipe_detail_cache = {}
        _recipe_detail_cache_at = time.time()
    if slug in _recipe_detail_cache:
        return _recipe_detail_cache[slug]
    try:
        recipe = _get(f"/recipes/{slug}")
        _recipe_detail_cache[slug] = recipe
        return recipe
    except httpx.HTTPStatusError:
        return None


def get_recipe_ingredients(slug: str) -> list[dict[str, Any]]:
    recipe = get_recipe(slug)
    if not recipe:
        return []
    return recipe.get("recipeIngredient", [])


def get_mealie_tags() -> list[str]:
    global _tag_cache, _tag_cache_at
    if _tag_cache and (time.time() - _tag_cache_at) < _CACHE_TTL:
        return _tag_cache
    try:
        data = _get("/organizers/tags?perPage=1000")
        items = data.get("items", data) if isinstance(data, dict) else data
        _tag_cache = [t["name"] for t in items if "name" in t]
        _tag_cache_at = time.time()
    except Exception:
        logger.warning("Mealie: échec de récupération des tags", exc_info=True)
    return _tag_cache


def _refresh_tag_cache(recipes: list[dict]) -> None:
    global _tag_cache, _tag_cache_at
    tags: set[str] = set()
    for r in recipes:
        for t in r.get("tags", []):
            if isinstance(t, dict) and "name" in t:
                tags.add(t["name"])
            elif isinstance(t, str):
                tags.add(t)
    if tags:
        _tag_cache = sorted(tags)
        _tag_cache_at = time.time()


def is_configured() -> bool:
    return bool(_MEALIE_API_KEY and _MEALIE_URL)
