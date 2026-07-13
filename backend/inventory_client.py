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


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_unit(unit: Any) -> str:
    raw = str(unit or "").strip().lower()
    aliases = {
        "lbs": "lb",
        "livre": "lb",
        "livres": "lb",
        "pounds": "lb",
        "pound": "lb",
        "kilogramme": "kg",
        "kilogrammes": "kg",
        "gramme": "g",
        "grammes": "g",
    }
    return aliases.get(raw, raw)


def inventory_available_quantity(item: dict[str, Any]) -> tuple[float, str]:
    """Quantité utile côté menu.

    Pour un item d'inventaire en paquets, `quantity` représente le nombre de
    sacs/boîtes/etc. ; Menu Hebdo doit plutôt raisonner sur le contenu total
    (ex. 2 sacs x 2 lb = 4 lb).
    """
    quantity = _as_float(item.get("quantity"))
    content_unit = normalize_unit(item.get("package_content_unit"))
    if item.get("consumption_mode") == "package" and content_unit:
        return quantity * _as_float(item.get("package_content_quantity"), 1.0), content_unit
    return quantity, normalize_unit(item.get("unit"))


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
            "stock_unit": item.get("unit", ""),
            "quantity": 0.0,
            "stock_quantity": 0.0,
            "available_quantity": 0.0,
            "available_unit": "",
            "consumption_mode": item.get("consumption_mode", ""),
            "package_content_unit": item.get("package_content_unit", ""),
        })
        stock_qty = _as_float(item.get("quantity"))
        available_qty, available_unit = inventory_available_quantity(item)
        entry["quantity"] += available_qty
        entry["stock_quantity"] += stock_qty
        entry["available_quantity"] += available_qty
        if not entry["available_unit"] and available_unit:
            entry["available_unit"] = available_unit
    return sorted(by_product.values(), key=lambda p: str(p["name"]).lower())


def score_ingredients(
    entries: list[dict[str, Any]], canonical_availability: dict[str, dict[str, float]]
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
        by_unit = canonical_availability.get(e["canonical_ingredient_id"], {})
        required_qty = _as_float(e.get("quantity"), 0.0)
        required_unit = normalize_unit(e.get("unit"))
        name = e.get("name", "")
        if required_qty > 0 and required_unit:
            qty = by_unit.get(required_unit, 0.0)
            label = f"{name} ({required_qty:g} {required_unit} requis, {qty:g} {required_unit} dispo)"
            (available if qty >= required_qty else missing).append(label)
        else:
            qty = sum(by_unit.values())
            (available if qty > 0 else missing).append(name)
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
