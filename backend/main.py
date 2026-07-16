from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

from menu_app.store import (
    clear_slot,
    create_canonical_ingredient,
    create_canonical_tag,
    create_family_member,
    create_ingredient_inventory_link,
    create_local_recipe,
    create_meal_context,
    create_side,
    delete_canonical_ingredient,
    delete_canonical_tag,
    delete_family_member,
    delete_ingredient_inventory_link,
    delete_local_recipe,
    delete_meal_context,
    delete_push_subscription,
    delete_side,
    enqueue_notification,
    get_local_recipe,
    get_meta_value,
    get_meal_context,
    get_or_create_plan,
    get_recipe_meta,
    get_slot,
    import_mealie_ingredients,
    import_mealie_tags,
    list_canonical_ingredients,
    list_canonical_tags,
    list_child_colors,
    list_family_members,
    list_ingredient_inventory_links,
    list_local_recipes,
    list_meal_contexts,
    list_mealie_ingredient_mappings,
    list_plans,
    list_sides,
    list_slots_for_plan,
    list_slots_for_range,
    list_tag_mappings,
    meal_context_history,
    meal_side_associations,
    meal_context_stats,
    move_slot,
    recipe_history,
    recipe_frequency,
    recipe_usage_stats,
    set_child_color,
    set_meta_value,
    side_history,
    side_frequency,
    update_canonical_ingredient,
    update_family_member,
    update_meal_context,
    side_usage_stats,
    update_canonical_tag,
    save_push_subscription,
    search_history,
    set_slot_sides,
    swap_slots,
    update_local_recipe,
    update_side,
    upsert_ingredient_mapping,
    upsert_recipe_meta,
    upsert_slot,
    upsert_tag_mapping,
    initialize_database,
)
from .access_control import ACCESS_CONTROL_PATH
from .auth import Actor, current_actor, require_permission
from .mealie_client import get_recipes, get_recipe, get_mealie_tags, is_configured as mealie_ok
from .inventory_client import get_inventory_products, get_item_history, score_ingredients, is_configured as inv_ok
from . import calendar_client
from .notifications import (
    flush_notifications,
    get_vapid_public_key,
    start_notification_worker,
)

app = FastAPI(title="Menu hebdomadaire", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")


@app.on_event("startup")
def startup() -> None:
    if not ACCESS_CONTROL_PATH.exists():
        logger.error(
            "Fichier de configuration manquant : %s — montez le volume de données "
            "(ex. ./data:/app/data) avant de démarrer, sinon toutes les requêtes échoueront.",
            ACCESS_CONTROL_PATH,
        )
    initialize_database()
    start_notification_worker()
    _sync_mealie_tags()
    _start_reconciliation_worker()
    _refresh_external_caches()
    threading.Thread(target=_warm_mealie_cache, daemon=True).start()
    _start_external_sync_worker()


def _sync_mealie_tags() -> None:
    if mealie_ok():
        try:
            tags = get_mealie_tags()
            if tags:
                import_mealie_tags(tags)
        except Exception:
            logger.warning("Échec de synchronisation des tags Mealie au démarrage", exc_info=True)


_EXTERNAL_SYNC_INTERVAL = 1800  # 30 min
_MEALIE_NIGHTLY_REFRESH_HOUR = int(os.getenv("MEALIE_NIGHTLY_REFRESH_HOUR", "3"))
_external_sync_thread: threading.Thread | None = None
_last_mealie_nightly_refresh: str | None = None
_recipe_list_cache_ttl = 300  # 5 min
_recipe_list_cache: dict[bool, tuple[float, list[dict[str, Any]]]] = {}
_recipe_list_cache_lock = threading.Lock()


def _invalidate_recipe_list_cache() -> None:
    with _recipe_list_cache_lock:
        _recipe_list_cache.clear()


def _refresh_mealie_cache(force: bool, include_details: bool = True) -> int:
    if mealie_ok():
        recipes = get_recipes(force=force)
        if include_details:
            _mealie_details_by_slug([r["slug"] for r in recipes if r.get("slug")], force=force)
        _invalidate_recipe_list_cache()
        return len(recipes)
    return 0


def _refresh_external_caches(refresh_mealie: bool = False) -> dict[str, int]:
    """Rafraîchit les caches externes sans mettre Mealie dans le chemin chaud.

    La présence calendrier reste fréquente. Mealie est rafraîchi seulement sur
    demande ou par le cycle nocturne, car les recettes changent très rarement.
    """
    result = {"recipes": 0, "presence_days": 0}
    if refresh_mealie:
        try:
            result["recipes"] = _refresh_mealie_cache(force=True)
        except Exception:
            logger.warning("Échec de rafraîchissement du cache Mealie", exc_info=True)
    try:
        result["presence_days"] = calendar_client.refresh_presence_window()
    except Exception:
        logger.warning("Échec de rafraîchissement du cache de présence", exc_info=True)
    return result


def _warm_mealie_cache() -> None:
    try:
        count = _refresh_mealie_cache(force=False)
        if count:
            logger.info("Cache Mealie réchauffé: %s recette(s)", count)
    except Exception:
        logger.warning("Échec du réchauffement du cache Mealie", exc_info=True)


def _refresh_mealie_cache_if_nightly_window() -> None:
    global _last_mealie_nightly_refresh
    now = date.today()
    today_iso = now.isoformat()
    if _last_mealie_nightly_refresh == today_iso:
        return
    if time.localtime().tm_hour < _MEALIE_NIGHTLY_REFRESH_HOUR:
        return
    count = _refresh_mealie_cache(force=True)
    _last_mealie_nightly_refresh = today_iso
    logger.info("Refresh nocturne Mealie terminé: %s recette(s)", count)


def _external_sync_loop() -> None:
    while True:
        time.sleep(_EXTERNAL_SYNC_INTERVAL)
        try:
            _refresh_external_caches()
            _refresh_mealie_cache_if_nightly_window()
        except Exception:
            logger.warning("Échec du cycle de synchronisation externe", exc_info=True)


def _start_external_sync_worker() -> None:
    global _external_sync_thread
    if _external_sync_thread and _external_sync_thread.is_alive():
        return
    _external_sync_thread = threading.Thread(target=_external_sync_loop, daemon=True)
    _external_sync_thread.start()


# ---------------------------------------------------------------------------
# Health / me
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "mealie": mealie_ok(), "inventory": inv_ok()}


@app.get("/api/me")
def me(actor: Actor = Depends(current_actor)) -> dict:
    return actor.serialize()


# ---------------------------------------------------------------------------
# Semaine — plans et slots
# ---------------------------------------------------------------------------

def _mealie_tag_mapping_context() -> tuple[dict[str, dict], dict[str, str]] | None:
    """Tags canoniques + mappings confirmés, chargés une fois par requête pour
    résoudre les tags natifs Mealie -> tags canoniques ("app")."""
    try:
        canonical_by_id = {t["id"]: t for t in list_canonical_tags()}
        canonical_id_by_mealie_name = {
            m["mealie_tag_name"]: m["canonical_tag_id"]
            for m in list_tag_mappings(status="confirmed")
            if m.get("canonical_tag_id")
        }
        return canonical_by_id, canonical_id_by_mealie_name
    except Exception:
        logger.warning("Échec de chargement du contexte de mapping de tags Mealie", exc_info=True)
        return None


def _canonical_tags_for_mealie_recipe(
    recipe: dict[str, Any],
    canonical_by_id: dict[str, dict],
    canonical_id_by_mealie_name: dict[str, str],
) -> list[dict[str, Any]]:
    raw_names = [
        t["name"] if isinstance(t, dict) else t
        for t in recipe.get("tags", [])
        if (isinstance(t, dict) and "name" in t) or isinstance(t, str)
    ]
    seen: set[str] = set()
    tags: list[dict[str, Any]] = []
    for name in raw_names:
        cid = canonical_id_by_mealie_name.get(name)
        if cid and cid not in seen and cid in canonical_by_id:
            seen.add(cid)
            tags.append(canonical_by_id[cid])
    return tags


def _resolve_mealie_slot_tags(slots: list[dict[str, Any]]) -> None:
    """Complète (in place) slot["tags"] pour les slots Mealie, en résolvant les tags
    natifs Mealie de la recette vers les tags canoniques confirmés (mealie_tag_mappings).
    Utilise la liste résumée (déjà en cache, sert aussi à l'écran Recettes) plutôt que
    l'endpoint détail : elle contient déjà les tags, inutile de refaire un appel HTTP
    par recette juste pour ça."""
    mealie_slots = [s for s in slots if s.get("recipe_source") == "mealie" and s.get("mealie_slug")]
    if not mealie_slots or not mealie_ok():
        return
    ctx = _mealie_tag_mapping_context()
    if ctx is None:
        return
    canonical_by_id, canonical_id_by_mealie_name = ctx
    try:
        recipes_by_slug = {r["slug"]: r for r in get_recipes() if "slug" in r}
    except Exception:
        logger.warning("Mealie: échec de récupération de la liste des recettes", exc_info=True)
        return
    for slot in mealie_slots:
        recipe = recipes_by_slug.get(slot["mealie_slug"])
        if not recipe:
            continue
        slot["tags"] = _canonical_tags_for_mealie_recipe(recipe, canonical_by_id, canonical_id_by_mealie_name)


def _week_presence(week_start: str) -> dict[str, Any]:
    """Presence des enfants (via calendrier_familiale) pour chacun des 7 jours
    de la semaine. Dict vide si le calendrier n'est pas configure/joignable."""
    if not calendar_client.is_configured():
        return {}
    try:
        start = date.fromisoformat(week_start)
    except ValueError:
        return {}
    days = [(start + timedelta(days=i)).isoformat() for i in range(7)]
    presence: dict[str, Any] = {}
    with ThreadPoolExecutor(max_workers=7) as pool:
        results = pool.map(calendar_client.get_presence, days)
    for iso_day, day_presence in zip(days, results):
        if day_presence is not None:
            presence[iso_day] = day_presence
    return presence


@app.get("/api/week/{week_start}")
def get_week(
    week_start: str,
    actor: Actor = Depends(require_permission("menu.read")),
) -> dict[str, Any]:
    plan = get_or_create_plan(week_start)
    slots = list_slots_for_plan(plan["id"])
    _resolve_mealie_slot_tags(slots)
    return {"plan": plan, "slots": slots, "presence": _week_presence(week_start)}


@app.get("/api/children")
def api_children(actor: Actor = Depends(require_permission("menu.read"))) -> list[dict[str, Any]]:
    """Liste des enfants (id, name, short_label, color) : identité depuis
    calendrier_familiale, couleur du tag de présence gérée localement."""
    children = calendar_client.get_children()
    colors = list_child_colors()
    for c in children:
        c["color"] = colors.get(c["id"], "")
    return children


@app.patch("/api/children/{child_id}")
def api_update_child_color(
    child_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    return set_child_color(child_id, body.get("color", ""))


@app.get("/api/people")
def api_people(actor: Actor = Depends(require_permission("menu.read"))) -> list[dict[str, Any]]:
    """Tout le monde dont les préférences comptent pour 'aimé par' : les enfants
    (calendrier_familiale) + les parents (locaux, hors garde partagée). À ne pas
    confondre avec /api/children, qui ne sert qu'à la présence du jour."""
    children = calendar_client.get_children()
    colors = list_child_colors()
    for c in children:
        c["color"] = colors.get(c["id"], "")
    return children + list_family_members()


@app.get("/api/family-members")
def api_list_family_members(actor: Actor = Depends(require_permission("menu.read"))) -> list[dict[str, Any]]:
    return list_family_members()


@app.post("/api/family-members")
def api_create_family_member(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    short_label = body.get("short_label", "").strip() or name[:1].upper()
    return create_family_member(name, short_label, body.get("color", ""))


@app.patch("/api/family-members/{member_id}")
def api_update_family_member(
    member_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    try:
        return update_family_member(
            member_id,
            name=body.get("name"),
            short_label=body.get("short_label"),
            color=body.get("color"),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/family-members/{member_id}")
def api_delete_family_member(
    member_id: str,
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    delete_family_member(member_id)
    return {"ok": True}


@app.get("/api/month/{year}/{month}")
def get_month(
    year: int,
    month: int,
    actor: Actor = Depends(require_permission("menu.read")),
) -> dict[str, Any]:
    start = date(year, month, 1)
    end = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    slots = list_slots_for_range(start.isoformat(), end.isoformat())
    return {"slots": slots}


@app.put("/api/week/{week_start}/slot/{slot_date}")
def put_slot(
    week_start: str,
    slot_date: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict[str, Any]:
    plan = get_or_create_plan(week_start)
    slot_kind = body.get("slot_kind", "recipe")
    context_id = body.get("context_id")
    source = body.get("recipe_source", "free")
    recipe_name = body.get("recipe_name", "").strip()
    if slot_kind not in ("recipe", "away", "hosting", "restaurant"):
        raise HTTPException(status_code=422, detail="slot_kind invalide")
    if slot_kind in ("away", "restaurant"):
        if not context_id:
            raise HTTPException(status_code=422, detail="context_id requis")
        context = get_meal_context(context_id)
        if not context:
            raise HTTPException(status_code=404, detail="Contexte introuvable")
        if slot_kind == "restaurant" and context.get("kind") != "restaurant":
            raise HTTPException(status_code=422, detail="restaurant requis")
        if slot_kind == "away" and context.get("kind") != "people":
            raise HTTPException(status_code=422, detail="personne/foyer requis")
        if slot_kind == "away":
            source = "free"
            recipe_name = context["name"]
        elif source not in ("mealie", "local") or not recipe_name:
            source = "free"
            recipe_name = context["name"]
    elif slot_kind == "hosting":
        if not context_id:
            raise HTTPException(status_code=422, detail="context_id requis")
        context = get_meal_context(context_id)
        if not context:
            raise HTTPException(status_code=404, detail="Contexte introuvable")
        if context.get("kind") != "people":
            raise HTTPException(status_code=422, detail="personne/foyer requis")
    if not recipe_name:
        raise HTTPException(status_code=422, detail="recipe_name requis")
    return upsert_slot(
        plan_id=plan["id"],
        slot_date=slot_date,
        recipe_source=source,
        recipe_name=recipe_name,
        actor_name=actor.name,
        slot_kind=slot_kind,
        context_id=context_id,
        mealie_slug=body.get("mealie_slug"),
        local_recipe_id=body.get("local_recipe_id"),
        free_text=body.get("free_text"),
        makes_lunch=body.get("makes_lunch", False),
        notes=body.get("notes", ""),
    )


@app.delete("/api/week/{week_start}/slot/{slot_date}")
def delete_slot(
    week_start: str,
    slot_date: str,
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    plan = get_or_create_plan(week_start)
    clear_slot(plan["id"], slot_date, actor.name)
    return {"ok": True}


@app.post("/api/slots/swap")
def swap(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict[str, Any]:
    slot_a = body.get("slot_id_a")
    slot_b = body.get("slot_id_b")
    if not slot_a or not slot_b:
        raise HTTPException(status_code=422, detail="slot_id_a et slot_id_b requis")
    try:
        a, b = swap_slots(slot_a, slot_b, actor.name)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"slot_a": a, "slot_b": b}


@app.post("/api/slots/move")
def move(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict[str, Any]:
    slot_id = body.get("slot_id")
    new_date = body.get("new_date")
    if not slot_id or not new_date:
        raise HTTPException(status_code=422, detail="slot_id et new_date requis")
    try:
        return move_slot(slot_id, new_date, actor.name)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ---------------------------------------------------------------------------
# Sides du slot
# ---------------------------------------------------------------------------

@app.put("/api/slots/{slot_id}/sides")
def put_slot_sides(
    slot_id: str,
    body: list = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> list[dict[str, Any]]:
    slot = get_slot(slot_id)
    if not slot:
        raise HTTPException(status_code=404, detail="Slot introuvable")
    return set_slot_sides(slot_id, body)


# ---------------------------------------------------------------------------
# Bibliothèque sides
# ---------------------------------------------------------------------------

@app.get("/api/sides")
def api_list_sides(
    include_inactive: bool = False,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return list_sides(include_inactive)


@app.get("/api/sides/favorites")
def api_side_favorites(
    limit: int = 8,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    """Accompagnements les plus fréquemment utilisés (12 dernières semaines)."""
    freq = side_frequency(weeks=12)
    return [
        {"name": f["name"], "side_id": f.get("side_id")}
        for f in freq[:limit]
    ]


@app.get("/api/sides/stats")
def api_side_stats(actor: Actor = Depends(require_permission("menu.edit"))) -> list[dict[str, Any]]:
    """Vue de gestion : usage total, dernière consommation, statut favori (12 semaines)."""
    stats = side_usage_stats()
    freq = side_frequency(weeks=12)
    favorite_names = {f["name"] for f in freq[:8]}
    for s in stats:
        s["is_favorite"] = s["name"] in favorite_names
    return stats


@app.post("/api/sides")
def api_create_side(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    return create_side(name)


@app.patch("/api/sides/{side_id}")
def api_update_side(
    side_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    try:
        return update_side(side_id, body.get("name"), body.get("is_active"))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/sides/{side_id}")
def api_delete_side(
    side_id: str,
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    delete_side(side_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Contextes de repas (personnes / invitations / restaurants)
# ---------------------------------------------------------------------------

@app.get("/api/meal-contexts")
def api_list_meal_contexts(
    kind: str | None = None,
    include_inactive: bool = False,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    return list_meal_contexts(kind, include_inactive)


@app.post("/api/meal-contexts")
def api_create_meal_context(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict[str, Any]:
    kind = body.get("kind", "").strip()
    name = body.get("name", "").strip()
    if kind not in ("people", "restaurant"):
        raise HTTPException(status_code=422, detail="kind invalide")
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    return create_meal_context(
        kind=kind,
        name=name,
    )


@app.patch("/api/meal-contexts/{context_id}")
def api_update_meal_context(
    context_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict[str, Any]:
    if "kind" in body and body["kind"] not in ("people", "restaurant"):
        raise HTTPException(status_code=422, detail="kind invalide")
    try:
        return update_meal_context(context_id, body)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/meal-contexts/{context_id}")
def api_delete_meal_context(
    context_id: str,
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    delete_meal_context(context_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Recettes locales
# ---------------------------------------------------------------------------

@app.get("/api/local-recipes")
def api_list_local_recipes(
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return list_local_recipes()


@app.post("/api/local-recipes")
def api_create_local_recipe(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    recipe = create_local_recipe(
        name=name,
        ingredients=body.get("ingredients"),
        tag_ids=body.get("tag_ids"),
        liked_by=body.get("liked_by"),
        is_weekend=body.get("is_weekend", False),
        makes_lunch=body.get("makes_lunch", False),
        prep_minutes=body.get("prep_minutes"),
        notes=body.get("notes", ""),
    )
    _invalidate_recipe_list_cache()
    return recipe


@app.patch("/api/local-recipes/{recipe_id}")
def api_update_local_recipe(
    recipe_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    try:
        recipe = update_local_recipe(recipe_id, body)
        _invalidate_recipe_list_cache()
        return recipe
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/local-recipes/{recipe_id}")
def api_delete_local_recipe(
    recipe_id: str,
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    delete_local_recipe(recipe_id)
    _invalidate_recipe_list_cache()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Mealie proxy + recettes unifiées
# ---------------------------------------------------------------------------

def _canonical_availability() -> dict[str, dict[str, float]]:
    """Quantité disponible par ingrédient canonique et par unité utile.

    Pour les produits en paquets, inventory_client expose déjà la quantité en
    contenu total (ex. lb) plutôt qu'en nombre de sacs.
    """
    links = list_ingredient_inventory_links()
    products = {p["product_id"]: p for p in get_inventory_products()}
    for product in list(products.values()):
        for source_id in product.get("source_product_ids", []):
            products.setdefault(source_id, product)
    availability: dict[str, dict[str, float]] = {}
    counted: set[tuple[str, str]] = set()
    for link in links:
        product = products.get(link["inventory_product_id"])
        if not product:
            continue
        cid = link["canonical_ingredient_id"]
        logical_product_id = str(product.get("product_id") or link["inventory_product_id"])
        if (cid, logical_product_id) in counted:
            continue
        counted.add((cid, logical_product_id))
        qty = float(product.get("available_quantity") or product.get("quantity") or 0)
        unit = str(product.get("available_unit") or product.get("unit") or "")
        availability.setdefault(cid, {})
        availability[cid][unit] = availability[cid].get(unit, 0.0) + qty
    return availability


def _mealie_ingredient_entries(
    detail: dict[str, Any] | None, mapping_by_text: dict[str, str]
) -> list[dict[str, Any]]:
    if not detail:
        return []
    entries: list[dict[str, Any]] = []
    for ing in detail.get("recipeIngredient", []):
        text = _mealie_ingredient_text(ing)
        if not text:
            continue
        entries.append({"name": text, "canonical_ingredient_id": mapping_by_text.get(text)})
    return entries


def _mealie_details_by_slug(slugs: list[str], force: bool = False) -> dict[str, dict[str, Any] | None]:
    """Charge les détails Mealie requis pour les scores inventaire.

    L'endpoint liste de Mealie ne contient pas les ingrédients. Les charger en
    série rend l'onglet Recettes lent dès que le cache détail expire.
    """
    if not slugs:
        return {}

    def load(slug: str) -> tuple[str, dict[str, Any] | None]:
        try:
            return slug, get_recipe(slug, force=force)
        except Exception:
            logger.debug("Mealie: échec de récupération du détail %s", slug, exc_info=True)
            return slug, None

    details: dict[str, dict[str, Any] | None] = {}
    with ThreadPoolExecutor(max_workers=min(8, len(slugs))) as pool:
        for slug, detail in pool.map(load, slugs):
            details[slug] = detail
    failed = sum(1 for detail in details.values() if detail is None)
    if failed:
        logger.warning("Mealie: %s détail(s) de recette indisponible(s) pour le score inventaire", failed)
    return details


def _log_slow_recipe_build(include_hidden: bool, elapsed: float, recipes: list[dict[str, Any]]) -> None:
    if elapsed < 1:
        return
    sources: dict[str, int] = {}
    for recipe in recipes:
        source = str(recipe.get("source") or "unknown")
        sources[source] = sources.get(source, 0) + 1
    logger.info(
        "Construction liste recettes lente: %.2fs, include_hidden=%s, total=%s, sources=%s",
        elapsed,
        include_hidden,
        len(recipes),
        sources,
    )


_RECONCILIATION_META_KEY = "last_inventory_reconciliation_date"
_reconciliation_thread: threading.Thread | None = None


def _resolve_slot_ingredient_entries(slot: dict[str, Any]) -> list[dict[str, Any]]:
    """Entrées {name, canonical_ingredient_id} pour un slot recette (locale ou
    Mealie), tous ingrédients confondus (liés ou non)."""
    if slot.get("recipe_source") == "local" and slot.get("local_recipe_id"):
        recipe = get_local_recipe(slot["local_recipe_id"])
        return recipe.get("ingredients", []) if recipe else []
    if slot.get("recipe_source") == "mealie" and slot.get("mealie_slug"):
        mapping = {
            m["mealie_ingredient_text"]: m["canonical_ingredient_id"]
            for m in list_mealie_ingredient_mappings(status="confirmed")
            if m.get("canonical_ingredient_id")
        }
        return _mealie_ingredient_entries(get_recipe(slot["mealie_slug"]), mapping)
    return []


def _check_inventory_reconciliation() -> None:
    """Vérifie que les ingrédients liés des repas d'hier ont bien été débités de
    l'inventaire (via l'historique en lecture seule d'inventaire_familial) ;
    sinon notifie les admin/editor (un seul événement par slot). Skip
    silencieux si rien n'est suivi — jamais de notification pour une recette
    non liée, conforme à l'exigence "pas de malus si non suivi"."""
    if not inv_ok():
        return
    yesterday_iso = (date.today() - timedelta(days=1)).isoformat()
    slots = [
        s for s in list_slots_for_range(yesterday_iso, yesterday_iso)
        if s.get("slot_kind") == "recipe"
    ]
    if not slots:
        return
    links_by_canonical: dict[str, list[dict[str, Any]]] = {}
    for link in list_ingredient_inventory_links():
        links_by_canonical.setdefault(link["canonical_ingredient_id"], []).append(link)
    live_products = {p["product_id"]: p for p in get_inventory_products()}

    for slot in slots:
        entries = _resolve_slot_ingredient_entries(slot)
        linked_ids = {e["canonical_ingredient_id"] for e in entries if e.get("canonical_ingredient_id")}
        if not linked_ids:
            continue
        debited = False
        for cid in linked_ids:
            for link in links_by_canonical.get(cid, []):
                product = live_products.get(link["inventory_product_id"])
                name = product["name"] if product else link["inventory_product_name"]
                domain = product["domain"] if product else link["domain"]
                history = get_item_history(name, domain)
                if any(
                    ev.get("action") == "item.consume" and str(ev.get("created_at", "")) >= yesterday_iso
                    for ev in history.get("events", [])
                ):
                    debited = True
                    break
            if debited:
                break
        if not debited:
            enqueue_notification("Système", "inventory.reconciliation", {
                "slot_date": slot["slot_date"],
                "recipe_name": slot["recipe_name"],
            })


def _run_inventory_reconciliation_if_due() -> None:
    today_iso = date.today().isoformat()
    if get_meta_value(_RECONCILIATION_META_KEY) == today_iso:
        return
    set_meta_value(_RECONCILIATION_META_KEY, today_iso)
    _check_inventory_reconciliation()


def _reconciliation_loop() -> None:
    while True:
        try:
            _run_inventory_reconciliation_if_due()
        except Exception:
            logger.warning("Échec de la réconciliation d'inventaire", exc_info=True)
        time.sleep(3600)


def _start_reconciliation_worker() -> None:
    global _reconciliation_thread
    if _reconciliation_thread and _reconciliation_thread.is_alive():
        return
    _reconciliation_thread = threading.Thread(target=_reconciliation_loop, daemon=True)
    _reconciliation_thread.start()


def _build_recipe_list(include_hidden: bool) -> list[dict[str, Any]]:
    availability = _canonical_availability()
    local = list_local_recipes()
    usage = recipe_usage_stats()
    results: list[dict[str, Any]] = []

    for r in local:
        score_data = score_ingredients(r.get("ingredients", []), availability)
        stats = usage.get(r["name"], {})
        results.append({
            "source": "local",
            "id": r["id"],
            "name": r["name"],
            "tags": r.get("tags", []),
            "tag_ids": r.get("tag_ids", []),
            "liked_by": r.get("liked_by", []),
            "is_weekend": bool(r.get("is_weekend")),
            "makes_lunch": bool(r.get("makes_lunch")),
            "is_hidden": False,
            "prep_minutes": r.get("prep_minutes"),
            "notes": r.get("notes", ""),
            "ingredients": r.get("ingredients", []),
            "inventory_score": score_data,
            "total_count": stats.get("count", 0),
            "last_used": stats.get("last_date"),
        })

    if mealie_ok():
        try:
            mealie_recipes = get_recipes()
            tag_ctx = _mealie_tag_mapping_context()
            ingredient_mapping = {
                m["mealie_ingredient_text"]: m["canonical_ingredient_id"]
                for m in list_mealie_ingredient_mappings(status="confirmed")
                if m.get("canonical_ingredient_id")
            }
            mealie_rows: list[tuple[dict[str, Any], str, dict[str, Any], list[dict[str, Any]]]] = []
            for r in mealie_recipes:
                slug = r.get("slug", "")
                if not slug:
                    continue
                meta = get_recipe_meta(slug)
                if meta.get("is_hidden") and not include_hidden:
                    continue
                tags = (
                    _canonical_tags_for_mealie_recipe(r, *tag_ctx) if tag_ctx else []
                )
                mealie_rows.append((r, slug, meta, tags))

            details_by_slug = _mealie_details_by_slug([slug for _, slug, _, _ in mealie_rows])
            for r, slug, meta, tags in mealie_rows:
                entries = _mealie_ingredient_entries(details_by_slug.get(slug), ingredient_mapping)
                score_data = score_ingredients(entries, availability)
                name = r.get("name", slug)
                stats = usage.get(name, {})
                results.append({
                    "source": "mealie",
                    "slug": slug,
                    "name": name,
                    "tags": tags,
                    "liked_by": meta.get("liked_by", []),
                    "is_weekend": bool(meta.get("is_weekend")),
                    "makes_lunch": bool(meta.get("makes_lunch")),
                    "is_hidden": bool(meta.get("is_hidden")),
                    "prep_minutes": _extract_prep(r),
                    "notes": meta.get("notes", ""),
                    "image": r.get("image"),
                    "inventory_score": score_data,
                    "total_count": stats.get("count", 0),
                    "last_used": stats.get("last_date"),
                })
        except Exception:
            logger.warning("Mealie: échec de construction de la liste de recettes", exc_info=True)

    return results


def _cached_recipe_list(include_hidden: bool) -> list[dict[str, Any]]:
    now = time.time()
    with _recipe_list_cache_lock:
        cached = _recipe_list_cache.get(include_hidden)
        if cached and (now - cached[0]) < _recipe_list_cache_ttl:
            return cached[1]
    started_at = time.perf_counter()
    recipes = _build_recipe_list(include_hidden)
    _log_slow_recipe_build(include_hidden, time.perf_counter() - started_at, recipes)
    with _recipe_list_cache_lock:
        _recipe_list_cache[include_hidden] = (time.time(), recipes)
    return recipes


@app.get("/api/recipes")
def api_recipes(
    include_hidden: bool = False,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    return _cached_recipe_list(include_hidden)


def _favorite_boost_group_for_date(iso_date: str | None) -> set[str]:
    """Qui privilégier pour les favoris du jour : les enfants présents s'il y en
    a (garde partagée, via calendrier_familiale) sinon les parents — ce sont eux
    qui mangent quand la maison est vide d'enfants (ou si le calendrier est
    indisponible/non configuré, faute de mieux). Aucune date fournie -> pas de
    boost du tout (utilisé par les appelants qui ne se soucient pas du jour)."""
    if not iso_date:
        return set()
    if calendar_client.is_configured():
        presence = calendar_client.get_presence(iso_date)
        calendar_present = set(presence.get("presentChildren", [])) if presence else set()
        if calendar_present:
            return calendar_present
    return {m["id"] for m in list_family_members()}


def _recipe_key(r: dict[str, Any]) -> tuple[str, str | None]:
    return (r["source"], r.get("slug") or r.get("id"))


def _score_boost_key(r: dict[str, Any]) -> float:
    """Clé de tri stable pour booster les recettes selon leur disponibilité
    d'inventaire : plus le score est haut, plus la clé est négative (remonte
    en premier). Une recette sans score connu (ingrédients non liés/déclarés)
    obtient la même clé qu'une recette à 0% — jamais pire, jamais de malus
    pour un ingrédient simplement non suivi."""
    score = (r.get("inventory_score") or {}).get("score")
    return -score if score is not None else 0.0


@app.get("/api/recipes/favorites")
def api_recipe_favorites(
    limit: int = 8,
    date: str | None = None,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    """Recettes les plus fréquemment planifiées (12 dernières semaines), boostées
    par disponibilité d'inventaire (recettes avec ingrédients dispo remontées,
    sans jamais pénaliser un ingrédient simplement non suivi).

    Si `date` est fourni, les recettes aimées par le groupe à privilégier ce
    jour-là (enfants présents, sinon parents) remontent en tête par-dessus ce
    boost, sans changer l'ordre relatif issu de la fréquence/disponibilité."""
    freq = recipe_frequency(weeks=12)
    order = {f["recipe_name"]: i for i, f in enumerate(freq)}
    all_recipes = _cached_recipe_list(include_hidden=False)
    favorites = [r for r in all_recipes if r["name"] in order]
    favorites.sort(key=lambda r: order[r["name"]])
    favorites.sort(key=_score_boost_key)

    boost_group = _favorite_boost_group_for_date(date)
    if boost_group:
        liked_keys = {
            _recipe_key(r) for r in favorites if set(r.get("liked_by", [])) & boost_group
        }
        favorites.sort(key=lambda r: 0 if _recipe_key(r) in liked_keys else 1)

    return favorites[:limit]


@app.get("/api/recipes/mealie/{slug}")
def api_mealie_recipe_detail(
    slug: str,
    actor: Actor = Depends(require_permission("menu.read")),
) -> dict[str, Any]:
    recipe = get_recipe(slug)
    if not recipe:
        raise HTTPException(status_code=404, detail="Recette Mealie introuvable")
    meta = get_recipe_meta(slug)
    ingredient_mapping = {
        m["mealie_ingredient_text"]: m["canonical_ingredient_id"]
        for m in list_mealie_ingredient_mappings(status="confirmed")
        if m.get("canonical_ingredient_id")
    }
    entries = _mealie_ingredient_entries(recipe, ingredient_mapping)
    score_data = score_ingredients(entries, _canonical_availability())
    return {**recipe, "meta": meta, "inventory_score": score_data}


@app.patch("/api/recipes/mealie/{slug}/meta")
def api_update_mealie_meta(
    slug: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    meta = upsert_recipe_meta(
        slug,
        is_weekend=body.get("is_weekend"),
        makes_lunch=body.get("makes_lunch"),
        is_hidden=body.get("is_hidden"),
        notes=body.get("notes"),
        liked_by=body.get("liked_by"),
    )
    _invalidate_recipe_list_cache()
    return meta


def _extract_prep(recipe: dict) -> int | None:
    val = recipe.get("prepTime") or recipe.get("totalTime")
    if not val:
        return None
    try:
        import re
        m = re.search(r"(\d+)", str(val))
        return int(m.group(1)) if m else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Tags canoniques
# ---------------------------------------------------------------------------

@app.get("/api/tags")
def api_list_tags(actor: Actor = Depends(require_permission("menu.read"))) -> list[dict]:
    return list_canonical_tags()


@app.post("/api/tags")
def api_create_tag(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    tag = create_canonical_tag(
        name, body.get("description", ""), body.get("color", ""), body.get("is_filter", False)
    )
    _invalidate_recipe_list_cache()
    return tag


@app.patch("/api/tags/{tag_id}")
def api_update_tag(
    tag_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    try:
        tag = update_canonical_tag(
            tag_id, name=body.get("name"), color=body.get("color"), is_filter=body.get("is_filter")
        )
        _invalidate_recipe_list_cache()
        return tag
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/tags/{tag_id}")
def api_delete_tag(
    tag_id: str,
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    delete_canonical_tag(tag_id)
    _invalidate_recipe_list_cache()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Mappings tags Mealie
# ---------------------------------------------------------------------------

@app.get("/api/tag-mappings")
def api_list_tag_mappings(
    status: str | None = None,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return list_tag_mappings(status)


@app.put("/api/tag-mappings/{mealie_tag_name}")
def api_confirm_tag_mapping(
    mealie_tag_name: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    mapping = upsert_tag_mapping(
        mealie_tag_name,
        canonical_tag_id=body.get("canonical_tag_id"),
        status=body.get("status", "confirmed"),
        confirmed_by=actor.name,
    )
    _invalidate_recipe_list_cache()
    return mapping


@app.post("/api/sync/refresh")
def api_sync_refresh(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    """Force immédiatement le rafraîchissement des caches Mealie (recettes) et
    calendrier (présence), sans attendre le prochain cycle du worker périodique."""
    return _refresh_external_caches(refresh_mealie=True)


@app.post("/api/tag-mappings/sync")
def api_sync_mealie_tags(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    tags = get_mealie_tags()
    import_mealie_tags(tags)
    _invalidate_recipe_list_cache()
    return {"imported": len(tags)}


# ---------------------------------------------------------------------------
# Ingrédients canoniques / liens inventaire / mappings Mealie
# ---------------------------------------------------------------------------

def _mealie_ingredient_text(ingredient: dict[str, Any]) -> str:
    """Meilleur identifiant texte pour un ingrédient Mealie : le nom structuré de
    l'aliment (food.name) si disponible, sinon le texte libre affiché."""
    food = ingredient.get("food")
    if isinstance(food, dict) and food.get("name"):
        return str(food["name"]).strip()
    for key in ("display", "note", "originalText"):
        val = ingredient.get(key)
        if val:
            return str(val).strip()
    return ""


@app.get("/api/canonical-ingredients")
def api_list_canonical_ingredients(
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return list_canonical_ingredients()


@app.post("/api/canonical-ingredients")
def api_create_canonical_ingredient(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    ingredient = create_canonical_ingredient(name)
    _invalidate_recipe_list_cache()
    return ingredient


@app.patch("/api/canonical-ingredients/{ingredient_id}")
def api_update_canonical_ingredient(
    ingredient_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    try:
        ingredient = update_canonical_ingredient(ingredient_id, name)
        _invalidate_recipe_list_cache()
        return ingredient
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/canonical-ingredients/{ingredient_id}")
def api_delete_canonical_ingredient(
    ingredient_id: str,
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    delete_canonical_ingredient(ingredient_id)
    _invalidate_recipe_list_cache()
    return {"ok": True}


@app.get("/api/ingredient-inventory-links")
def api_list_ingredient_inventory_links(
    canonical_ingredient_id: str | None = None,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    links = list_ingredient_inventory_links(canonical_ingredient_id)
    live_product_ids: set[str] = set()
    for product in get_inventory_products():
        live_product_ids.add(product["product_id"])
        live_product_ids.update(product.get("source_product_ids", []))
    for link in links:
        link["is_live"] = link["inventory_product_id"] in live_product_ids
    return links


@app.post("/api/ingredient-inventory-links")
def api_create_ingredient_inventory_link(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    canonical_ingredient_id = body.get("canonical_ingredient_id", "")
    inventory_product_id = body.get("inventory_product_id", "")
    if not canonical_ingredient_id or not inventory_product_id:
        raise HTTPException(status_code=422, detail="canonical_ingredient_id et inventory_product_id requis")
    link = create_ingredient_inventory_link(
        canonical_ingredient_id,
        inventory_product_id,
        body.get("inventory_product_name", ""),
        body.get("domain", "frozen"),
    )
    _invalidate_recipe_list_cache()
    return link


@app.delete("/api/ingredient-inventory-links/{link_id}")
def api_delete_ingredient_inventory_link(
    link_id: str,
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    delete_ingredient_inventory_link(link_id)
    _invalidate_recipe_list_cache()
    return {"ok": True}


@app.get("/api/inventory-products")
def api_list_inventory_products(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> list[dict]:
    """Catalogue des produits d'inventaire distincts, pour la recherche lors du
    lien avec un ingrédient canonique."""
    return get_inventory_products()


@app.post("/api/inventory-products/refresh")
def api_refresh_inventory_products(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> list[dict]:
    """Force la relecture des produits actifs depuis inventaire_familial."""
    return get_inventory_products(force=True)


@app.get("/api/ingredient-mappings")
def api_list_ingredient_mappings(
    status: str | None = None,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return list_mealie_ingredient_mappings(status)


@app.put("/api/ingredient-mappings/{mealie_ingredient_text}")
def api_confirm_ingredient_mapping(
    mealie_ingredient_text: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    mapping = upsert_ingredient_mapping(
        mealie_ingredient_text,
        canonical_ingredient_id=body.get("canonical_ingredient_id"),
        status=body.get("status", "confirmed"),
        confirmed_by=actor.name,
    )
    _invalidate_recipe_list_cache()
    return mapping


@app.post("/api/ingredient-mappings/sync")
def api_sync_mealie_ingredients(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    if not mealie_ok():
        return {"imported": 0}
    texts: set[str] = set()
    for r in get_recipes(force=True):
        detail = get_recipe(r.get("slug", ""))
        if not detail:
            continue
        for ing in detail.get("recipeIngredient", []):
            text = _mealie_ingredient_text(ing)
            if text:
                texts.add(text)
    import_mealie_ingredients(sorted(texts))
    _invalidate_recipe_list_cache()
    return {"imported": len(texts)}


# ---------------------------------------------------------------------------
# Stats / historique
# ---------------------------------------------------------------------------

@app.get("/api/stats/history")
def api_search_history(
    q: str = "",
    limit: int = 50,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    if not q:
        return []
    return search_history(q, limit)


@app.get("/api/stats/frequency")
def api_frequency(
    weeks: int = 12,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return recipe_frequency(weeks)


@app.get("/api/stats/recipe-history")
def api_recipe_history(
    recipe_name: str,
    weeks: int = 12,
    limit: int = 50,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return recipe_history(recipe_name, weeks, limit)


@app.get("/api/stats/sides-frequency")
def api_sides_frequency(
    weeks: int = 12,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return side_frequency(weeks)


@app.get("/api/stats/side-history")
def api_side_history(
    side_name: str,
    side_id: str | None = None,
    weeks: int = 12,
    limit: int = 50,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return side_history(side_name, side_id, weeks, limit)


@app.get("/api/stats/meal-side-associations")
def api_meal_side_associations(
    weeks: int = 12,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return meal_side_associations(weeks)


@app.get("/api/stats/contexts")
def api_context_stats(
    weeks: int = 12,
    actor: Actor = Depends(require_permission("menu.read")),
) -> dict[str, Any]:
    return meal_context_stats(weeks)


@app.get("/api/stats/context-history")
def api_context_history(
    kind: str,
    context_name: str,
    context_id: str | None = None,
    weeks: int = 12,
    limit: int = 50,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return meal_context_history(kind, context_name, context_id, weeks, limit)


@app.get("/api/plans")
def api_list_plans(
    limit: int = 52,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict]:
    return list_plans(limit)


# ---------------------------------------------------------------------------
# Push notifications
# ---------------------------------------------------------------------------

@app.get("/api/notifications/config")
def api_notif_config(actor: Actor = Depends(require_permission("notifications.subscribe"))) -> dict:
    return {"vapid_public_key": get_vapid_public_key(), "enabled": bool(get_vapid_public_key())}


@app.post("/api/notifications/subscriptions")
def api_save_subscription(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("notifications.subscribe")),
) -> dict:
    endpoint = body.get("endpoint", "")
    if not endpoint:
        raise HTTPException(status_code=422, detail="endpoint requis")
    save_push_subscription(endpoint, actor.name, body)
    return {"ok": True}


@app.delete("/api/notifications/subscriptions")
def api_delete_subscription(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("notifications.subscribe")),
) -> dict:
    endpoint = body.get("endpoint", "")
    if endpoint:
        delete_push_subscription(endpoint)
    return {"ok": True}


@app.post("/api/notifications/flush")
def api_flush_notifications(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    return flush_notifications(force=True)


# ---------------------------------------------------------------------------
# Frontend statique
# ---------------------------------------------------------------------------

if os.path.isdir(_FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="frontend")
