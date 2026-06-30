from __future__ import annotations

import os
from datetime import date, timedelta
from typing import Any

from fastapi import Body, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

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
    import_mealie_tags,
    list_canonical_tags,
    list_local_recipes,
    list_plans,
    list_sides,
    list_slots_for_plan,
    list_tag_mappings,
    recipe_frequency,
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
from .auth import Actor, current_actor, require_permission
from .mealie_client import get_recipes, get_recipe, get_mealie_tags, is_configured as mealie_ok
from .inventory_client import get_inventory, inventory_score, is_configured as inv_ok
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
            pass


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

@app.get("/api/week/{week_start}")
def get_week(
    week_start: str,
    actor: Actor = Depends(require_permission("menu.read")),
) -> dict[str, Any]:
    plan = get_or_create_plan(week_start)
    slots = list_slots_for_plan(plan["id"])
    return {"plan": plan, "slots": slots}


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
def api_list_sides(actor: Actor = Depends(require_permission("menu.read"))) -> list[dict]:
    return list_sides()


@app.post("/api/sides")
def api_create_side(
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name requis")
    return create_side(name, body.get("category", ""))


@app.patch("/api/sides/{side_id}")
def api_update_side(
    side_id: str,
    body: dict = Body(...),
    actor: Actor = Depends(require_permission("menu.edit")),
) -> dict:
    try:
        return update_side(side_id, body.get("name"), body.get("category"))
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
        tags=body.get("tags"),
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

@app.get("/api/recipes")
def api_recipes(
    actor: Actor = Depends(require_permission("menu.read")),
) -> list[dict[str, Any]]:
    inventory = get_inventory()
    local = list_local_recipes()
    results: list[dict[str, Any]] = []

    for r in local:
        score_data = inventory_score(r.get("ingredients", []), inventory)
        results.append({
            "source": "local",
            "id": r["id"],
            "name": r["name"],
            "tags": r.get("tags", []),
            "is_weekend": bool(r.get("is_weekend")),
            "makes_lunch": bool(r.get("makes_lunch")),
            "prep_minutes": r.get("prep_minutes"),
            "notes": r.get("notes", ""),
            "inventory_score": score_data,
        })

    if mealie_ok():
        try:
            mealie_recipes = get_recipes()
            for r in mealie_recipes:
                slug = r.get("slug", "")
                meta = get_recipe_meta(slug)
                tags_raw = [
                    t["name"] if isinstance(t, dict) else t
                    for t in r.get("tags", [])
                ]
                ingredients = r.get("recipeIngredient", [])
                score_data = inventory_score(ingredients, inventory)
                results.append({
                    "source": "mealie",
                    "slug": slug,
                    "name": r.get("name", slug),
                    "tags": tags_raw,
                    "is_weekend": bool(meta.get("is_weekend")),
                    "makes_lunch": bool(meta.get("makes_lunch")),
                    "prep_minutes": _extract_prep(r),
                    "notes": meta.get("notes", ""),
                    "image": r.get("image"),
                    "inventory_score": score_data,
                })
        except Exception:
            pass

    return results


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
        notes=body.get("notes"),
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
    return create_canonical_tag(name, body.get("description", ""))


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
