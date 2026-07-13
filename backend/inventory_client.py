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


def _logical_product_id(item: dict[str, Any]) -> str:
    """Identifiant logique aligné sur les cartes d'inventaire_familial.

    Un même produit en paquets peut avoir plusieurs lots/formats physiques
    (ex. sacs de 1 lb et de 2 lb), mais Menu Hebdo doit l'associer une seule
    fois à un ingrédient pivot.
    """
    if item.get("consumption_mode") == "package":
        parts = [
            "package",
            item.get("domain", ""),
            item.get("category", ""),
            item.get("name", ""),
            item.get("unit", ""),
            normalize_unit(item.get("package_content_unit")),
        ]
    else:
        parts = [
            "item",
            item.get("domain", ""),
            item.get("category", ""),
            item.get("name", ""),
            item.get("unit", ""),
            item.get("consumption_mode", ""),
            str(item.get("consumption_step", "")),
        ]
    return "logical:" + "|".join(str(part).strip().lower() for part in parts)


def _format_number(value: float) -> str:
    return f"{value:g}"


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
    """Produits logiques (alignés avec les cartes d'inventaire_familial).

    Les lots/formats d'un produit en paquets sont regroupés en une seule entrée
    pour l'association Menu Hebdo, avec un résumé des formats physiques.
    """
    by_product: dict[str, dict[str, Any]] = {}
    for item in get_inventory(force=force):
        source_product_id = item.get("product_id")
        product_id = _logical_product_id(item)
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
            "source_product_ids": [],
            "format_breakdown": {},
        })
        if source_product_id and source_product_id not in entry["source_product_ids"]:
            entry["source_product_ids"].append(source_product_id)
        stock_qty = _as_float(item.get("quantity"))
        available_qty, available_unit = inventory_available_quantity(item)
        entry["quantity"] += available_qty
        entry["stock_quantity"] += stock_qty
        entry["available_quantity"] += available_qty
        if not entry["available_unit"] and available_unit:
            entry["available_unit"] = available_unit
        if item.get("consumption_mode") == "package":
            format_qty = _as_float(item.get("package_content_quantity"), 1.0)
            key = _format_number(format_qty)
            entry["format_breakdown"][key] = entry["format_breakdown"].get(key, 0.0) + stock_qty
    for entry in by_product.values():
        breakdown = [
            {
                "package_count": count,
                "content_quantity": float(content_qty),
                "content_unit": entry.get("available_unit") or normalize_unit(entry.get("package_content_unit")),
            }
            for content_qty, count in entry.pop("format_breakdown", {}).items()
        ]
        breakdown.sort(key=lambda row: row["content_quantity"])
        entry["format_breakdown"] = breakdown
        entry["format_summary"] = " · ".join(
            f"{_format_number(row['package_count'])} x {_format_number(row['content_quantity'])} {row['content_unit']}"
            for row in breakdown
        )
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
