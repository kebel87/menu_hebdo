from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

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
            items.extend(resp.json().get("items", []))
        _cache = items
        _cache_at = time.time()
    except Exception:
        logger.warning("inventaire_familial: échec de récupération de l'inventaire", exc_info=True)
    return _cache


def get_inventory_products(force: bool = False) -> list[dict[str, Any]]:
    """Produits distincts (dédupliqués par product_id, quantités sommées à travers
    les lots) — utilisé pour la recherche d'items lors du lien ingrédient/inventaire."""
    by_product: dict[str, dict[str, Any]] = {}
    for item in get_inventory(force=force):
        product_id = item.get("product_id")
        if not product_id:
            continue
        entry = by_product.setdefault(product_id, {
            "product_id": product_id,
            "name": item.get("name", ""),
            "domain": item.get("domain", ""),
            "unit": item.get("unit", ""),
            "quantity": 0.0,
        })
        entry["quantity"] += float(item.get("quantity") or 0)
    return sorted(by_product.values(), key=lambda p: str(p["name"]).lower())


def score_ingredients(
    entries: list[dict[str, Any]], canonical_availability: dict[str, float]
) -> dict[str, Any]:
    """Score de disponibilité basé sur les liens canoniques confirmés (pas de
    matching approximatif sur le nom). `entries` : [{"name": str,
    "canonical_ingredient_id": str | None}, ...]. Un ingrédient sans lien
    canonique est exclu du calcul (ni disponible ni manquant) — un ingrédient
    non suivi ne doit jamais pénaliser une recette, contrairement à un
    ingrédient suivi mais épuisé (quantité disponible à 0)."""
    linked = [e for e in entries if e.get("canonical_ingredient_id")]
    missing: list[str] = []
    available: list[str] = []
    for e in linked:
        qty = canonical_availability.get(e["canonical_ingredient_id"], 0.0)
        (available if qty > 0 else missing).append(e.get("name", ""))
    total = len(linked)
    return {
        "score": round(len(available) / total, 2) if total > 0 else None,
        "missing": missing,
        "available": available,
        "ingredients_declared": len(entries) > 0,
        "ingredients_linked": total > 0,
    }


def get_item_history(name: str, domain: str) -> dict[str, Any]:
    """Historique des événements (dont item.consume) pour un produit d'inventaire,
    utilisé pour vérifier qu'un repas a bien été débité. Lecture seule, ne
    nécessite que la permission inventory.read côté inventaire_familial."""
    if not is_configured():
        return {"events": []}
    try:
        resp = httpx.get(
            f"{_INVENTAIRE_URL}/api/stats/item-history",
            params={"name": name, "domain": domain},
            headers=_headers(),
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        logger.warning("inventaire_familial: échec de récupération de l'historique de %s", name, exc_info=True)
        return {"events": []}


def is_configured() -> bool:
    return bool(_INVENTAIRE_URL and _SERVICE_KEY)
