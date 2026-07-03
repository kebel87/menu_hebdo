from __future__ import annotations

import logging
import os
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
    create_canonical_tag,
    create_local_recipe,
    create_side,
    delete_canonical_tag,
    delete_local_recipe,
    delete_push_subscription,
    delete_side,
    get_local_recipe,
    get_or_create_plan,
    get_recipe_meta,
    get_slot,
    create_family_member,
    delete_family_member,
    import_mealie_tags,
    list_canonical_tags,
    list_child_colors,
    list_family_members,
    list_local_recipes,
    list_plans,
    list_sides,
    list_slots_for_plan,
    list_slots_for_range,
    list_tag_mappings,
    move_slot,
    recipe_frequency,
    recipe_usage_stats,
    set_child_color,
    side_frequency,
    update_family_member,
    side_usage_stats,
    update_canonical_tag,
    save_push_subscription,
    search_history,
    set_slot_sides,
    swap_slots,
    update_local_recipe,
    update_side,
    upsert_recipe_meta,
    upsert_slot,
    upsert_tag_mapping,
    initialize_database,
)
from .access_control import ACCESS_CONTROL_PATH
from .auth import Actor, current_actor, require_permission
from .mealie_client import get_recipes, get_recipe, get_mealie_tags, is_configured as mealie_ok
from .inventory_client import get_inventory, inventory_score, is_configured as inv_ok
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


def _sync_mealie_tags() -> None:
    if mealie_ok():
        try:
            tags = get_mealie_tags()
            if tags:
                import_mealie_tags(tags)
        except Exception:
            logger.warning("Échec de synchronisation des tags Mealie au démarrage", exc_info=True)


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
    natifs Mealie de la recette vers les tags canoniques confirmés (mealie_tag_mappings)."""
    mealie_slots = [s for s in slots if s.get("recipe_source") == "mealie" and s.get("mealie_slug")]
    if not mealie_slots or not mealie_ok():
        return
    ctx = _mealie_tag_mapping_context()
    if ctx is None:
        return
    canonical_by_id, canonical_id_by_mealie_name = ctx
    for slot in mealie_slots:
        try:
            recipe = get_recipe(slot["mealie_slug"])
        except Exception:
            logger.warning("Mealie: échec de récupération de la recette %s", slot["mealie_slug"], exc_info=True)
            recipe = None
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
    presence: dict[str, Any] = {}
    for i in range(7):
        iso_day = (start + timedelta(days=i)).isoformat()
        day_presence = calendar_client.get_presence(iso_day)
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
    source = body.get("recipe_source", "free")
    recipe_name = body.get("recipe_name", "").strip()
    if not recipe_name:
        raise HTTPException(status_code=422, detail="recipe_name requis")
    return upsert_slot(
        plan_id=plan["id"],
        slot_date=slot_date,
        recipe_source=source,
        recipe_name=recipe_name,
        actor_name=actor.name,
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
    return create_local_recipe(
        name=name,
        ingredients=body.get("ingredients"),
        tag_ids=body.get("tag_ids"),
        liked_by=body.get("liked_by"),
        is_weekend=body.get("is_weekend", False),
        makes_lunch=body.get("makes_lunch", False),
        prep_minutes=body.get("prep_minutes"),
        notes=body.get("notes", ""),
    )


@app.patch("/api/local-recipes/{recipe_id}")
def api_update_local_recipe(
    recipe_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    try:
        return update_local_recipe(recipe_id, body)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/local-recipes/{recipe_id}")
def api_delete_local_recipe(
    recipe_id: str,
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    delete_local_recipe(recipe_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Mealie proxy + recettes unifiées
# ---------------------------------------------------------------------------

def _build_recipe_list(include_hidden: bool) -> list[dict[str, Any]]:
    inventory = get_inventory()
    local = list_local_recipes()
    usage = recipe_usage_stats()
    results: list[dict[str, Any]] = []

    for r in local:
        score_data = inventory_score(r.get("ingredients", []), inventory)
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
            "inventory_score": score_data,
            "total_count": stats.get("count", 0),
            "last_used": stats.get("last_date"),
        })

    if mealie_ok():
        try:
            mealie_recipes = get_recipes()
            tag_ctx = _mealie_tag_mapping_context()
            for r in mealie_recipes:
                slug = r.get("slug", "")
                meta = get_recipe_meta(slug)
                if meta.get("is_hidden") and not include_hidden:
                    continue
                tags = (
                    _canonical_tags_for_mealie_recipe(r, *tag_ctx) if tag_ctx else []
                )
                ingredients = r.get("recipeIngredient", [])
                score_data = inventory_score(ingredients, inventory)
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


@app.get("/api/recipes")
def api_recipes(
    include_hidden: bool = False,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    return _build_recipe_list(include_hidden)


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


@app.get("/api/recipes/favorites")
def api_recipe_favorites(
    limit: int = 8,
    date: str | None = None,
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    """Recettes les plus fréquemment planifiées (12 dernières semaines).

    Si `date` est fourni, les recettes aimées par le groupe à privilégier ce
    jour-là (enfants présents, sinon parents) remontent en tête, sans changer
    l'ordre relatif issu de la fréquence."""
    freq = recipe_frequency(weeks=12)
    order = {f["recipe_name"]: i for i, f in enumerate(freq)}
    all_recipes = _build_recipe_list(include_hidden=False)
    favorites = [r for r in all_recipes if r["name"] in order]
    favorites.sort(key=lambda r: order[r["name"]])

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
    inventory = get_inventory()
    ingredients = recipe.get("recipeIngredient", [])
    score_data = inventory_score(ingredients, inventory)
    return {**recipe, "meta": meta, "inventory_score": score_data}


@app.patch("/api/recipes/mealie/{slug}/meta")
def api_update_mealie_meta(
    slug: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    return upsert_recipe_meta(
        slug,
        is_weekend=body.get("is_weekend"),
        makes_lunch=body.get("makes_lunch"),
        is_hidden=body.get("is_hidden"),
        notes=body.get("notes"),
        liked_by=body.get("liked_by"),
    )


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
    return create_canonical_tag(
        name, body.get("description", ""), body.get("color", ""), body.get("is_filter", False)
    )


@app.patch("/api/tags/{tag_id}")
def api_update_tag(
    tag_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    try:
        return update_canonical_tag(
            tag_id, name=body.get("name"), color=body.get("color"), is_filter=body.get("is_filter")
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.delete("/api/tags/{tag_id}")
def api_delete_tag(
    tag_id: str,
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    delete_canonical_tag(tag_id)
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
    return upsert_tag_mapping(
        mealie_tag_name,
        canonical_tag_id=body.get("canonical_tag_id"),
        status=body.get("status", "confirmed"),
        confirmed_by=actor.name,
    )


@app.post("/api/tag-mappings/sync")
def api_sync_mealie_tags(
    actor: Actor = Depends(require_permission("settings.manage")),
) -> dict:
    tags = get_mealie_tags()
    import_mealie_tags(tags)
    return {"imported": len(tags)}


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
