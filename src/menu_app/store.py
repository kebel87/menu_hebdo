from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DATA_DIR = Path(os.getenv("MENU_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
DB_PATH = DATA_DIR / "menu.db"
SCHEMA_VERSION = "menu_hebdo_v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def initialize_database() -> None:
    with connect() as db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        db.commit()
        version = db.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
        if version is None or version["value"] != SCHEMA_VERSION:
            _create_tables(db)
            db.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                (SCHEMA_VERSION,),
            )
            _seed(db)
        _apply_migrations(db)


def _apply_migrations(db: sqlite3.Connection) -> None:
    existing = {row[1] for row in db.execute("PRAGMA table_info(recipe_meta)").fetchall()}
    if "is_hidden" not in existing:
        db.execute("ALTER TABLE recipe_meta ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")
    tag_cols = {row[1] for row in db.execute("PRAGMA table_info(canonical_tags)").fetchall()}
    if "color" not in tag_cols:
        db.execute("ALTER TABLE canonical_tags ADD COLUMN color TEXT NOT NULL DEFAULT ''")
    tag_cols = {row[1] for row in db.execute("PRAGMA table_info(canonical_tags)").fetchall()}
    if "is_filter" not in tag_cols:
        db.execute("ALTER TABLE canonical_tags ADD COLUMN is_filter INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE canonical_tags SET is_filter=1 WHERE name IN ('weekend', 'lunchs')")
        _backfill_weekend_lunch_tags(db)


def _backfill_weekend_lunch_tags(db: sqlite3.Connection) -> None:
    """Recettes locales déjà marquées via les cases is_weekend/makes_lunch : on
    leur ajoute le tag canonique correspondant pour qu'elles ne disparaissent
    pas des filtres (désormais basés sur les tags, plus sur ces booléens)."""
    tag_id_by_name = {
        r["name"]: r["id"]
        for r in db.execute("SELECT id, name FROM canonical_tags WHERE name IN ('weekend', 'lunchs')").fetchall()
    }
    weekend_id = tag_id_by_name.get("weekend")
    lunchs_id = tag_id_by_name.get("lunchs")
    if not weekend_id and not lunchs_id:
        return
    for r in db.execute("SELECT id, tags_json, is_weekend, makes_lunch FROM local_recipes").fetchall():
        ids = set(json.loads(r["tags_json"] or "[]"))
        changed = False
        if weekend_id and r["is_weekend"] and weekend_id not in ids:
            ids.add(weekend_id)
            changed = True
        if lunchs_id and r["makes_lunch"] and lunchs_id not in ids:
            ids.add(lunchs_id)
            changed = True
        if changed:
            db.execute("UPDATE local_recipes SET tags_json=? WHERE id=?", (json.dumps(list(ids)), r["id"]))


def _create_tables(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS meal_plans (
            id TEXT PRIMARY KEY,
            week_start TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meal_slots (
            id TEXT PRIMARY KEY,
            plan_id TEXT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
            slot_date TEXT NOT NULL,
            recipe_source TEXT NOT NULL,
            mealie_slug TEXT,
            local_recipe_id TEXT,
            free_text TEXT,
            recipe_name TEXT NOT NULL,
            makes_lunch INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meal_slots_plan ON meal_slots(plan_id);
        CREATE INDEX IF NOT EXISTS idx_meal_slots_date ON meal_slots(slot_date);

        CREATE TABLE IF NOT EXISTS meal_slot_sides (
            id TEXT PRIMARY KEY,
            slot_id TEXT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
            side_id TEXT REFERENCES sides(id) ON DELETE SET NULL,
            free_text TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_slot_sides_slot ON meal_slot_sides(slot_id);

        CREATE TABLE IF NOT EXISTS sides (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS local_recipes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            ingredients_json TEXT NOT NULL DEFAULT '[]',
            tags_json TEXT NOT NULL DEFAULT '[]',
            is_weekend INTEGER NOT NULL DEFAULT 0,
            makes_lunch INTEGER NOT NULL DEFAULT 0,
            prep_minutes INTEGER,
            notes TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recipe_meta (
            mealie_slug TEXT PRIMARY KEY,
            is_weekend INTEGER NOT NULL DEFAULT 0,
            makes_lunch INTEGER NOT NULL DEFAULT 0,
            is_hidden INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS canonical_tags (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mealie_tag_mappings (
            mealie_tag_name TEXT PRIMARY KEY,
            canonical_tag_id TEXT REFERENCES canonical_tags(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            confirmed_at TEXT NOT NULL DEFAULT '',
            confirmed_by TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            actor_name TEXT NOT NULL,
            subscription_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_push_actor ON push_subscriptions(actor_name);

        CREATE TABLE IF NOT EXISTS notification_events (
            id TEXT PRIMARY KEY,
            dedupe_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            actor_name TEXT NOT NULL,
            event_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            sent_at TEXT NOT NULL DEFAULT '',
            delivery_results_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_events(status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe
            ON notification_events(dedupe_key) WHERE status = 'pending';
    """)


def _seed(db: sqlite3.Connection) -> None:
    now = now_iso()
    for tag_name in ("weekend", "lunchs"):
        db.execute(
            "INSERT OR IGNORE INTO canonical_tags (id, name, created_at) VALUES (?, ?, ?)",
            (new_id(), tag_name, now),
        )


# ---------------------------------------------------------------------------
# meal_plans
# ---------------------------------------------------------------------------

def get_or_create_plan(week_start: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            "SELECT * FROM meal_plans WHERE week_start = ?", (week_start,)
        ).fetchone()
        if row:
            return dict(row)
        plan_id = new_id()
        now = now_iso()
        db.execute(
            "INSERT INTO meal_plans (id, week_start, created_at, updated_at) VALUES (?,?,?,?)",
            (plan_id, week_start, now, now),
        )
        return {"id": plan_id, "week_start": week_start, "created_at": now, "updated_at": now}


def list_plans(limit: int = 52) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM meal_plans ORDER BY week_start DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# meal_slots
# ---------------------------------------------------------------------------

def _boolify_slot(slot: dict[str, Any]) -> dict[str, Any]:
    slot["makes_lunch"] = bool(slot.get("makes_lunch"))
    return slot


def _tags_for_slot(db: sqlite3.Connection, slot: dict[str, Any],
                    tags_map: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Tags canoniques d'un slot. Seules les recettes locales sont résolues ici ;
    les recettes Mealie sont résolues côté API (via mealie_tag_mappings)."""
    if slot.get("recipe_source") == "local" and slot.get("local_recipe_id"):
        row = db.execute(
            "SELECT tags_json FROM local_recipes WHERE id=?", (slot["local_recipe_id"],)
        ).fetchone()
        if row:
            ids = json.loads(row["tags_json"] or "[]")
            return [tags_map[i] for i in ids if i in tags_map]
    return []


def list_slots_for_plan(plan_id: str) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM meal_slots WHERE plan_id = ? ORDER BY slot_date", (plan_id,)
        ).fetchall()
        slots = [_boolify_slot(dict(r)) for r in rows]
        tags_map = _canonical_tags_map(db)
        for slot in slots:
            slot["sides"] = _get_sides_for_slot(db, slot["id"])
            slot["tags"] = _tags_for_slot(db, slot, tags_map)
        return slots


def get_slot(slot_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM meal_slots WHERE id = ?", (slot_id,)).fetchone()
        if not row:
            return None
        slot = _boolify_slot(dict(row))
        slot["sides"] = _get_sides_for_slot(db, slot_id)
        slot["tags"] = _tags_for_slot(db, slot, _canonical_tags_map(db))
        return slot


def list_slots_for_range(start_date: str, end_date: str) -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM meal_slots WHERE slot_date BETWEEN ? AND ? ORDER BY slot_date",
            (start_date, end_date),
        ).fetchall()
        slots = [_boolify_slot(dict(r)) for r in rows]
        tags_map = _canonical_tags_map(db)
        for slot in slots:
            slot["sides"] = _get_sides_for_slot(db, slot["id"])
            slot["tags"] = _tags_for_slot(db, slot, tags_map)
        return slots


def upsert_slot(
    plan_id: str,
    slot_date: str,
    recipe_source: str,
    recipe_name: str,
    actor_name: str,
    mealie_slug: str | None = None,
    local_recipe_id: str | None = None,
    free_text: str | None = None,
    makes_lunch: bool = False,
    notes: str = "",
) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        existing = db.execute(
            "SELECT id FROM meal_slots WHERE plan_id = ? AND slot_date = ?",
            (plan_id, slot_date),
        ).fetchone()
        if existing:
            slot_id = existing["id"]
            db.execute(
                """UPDATE meal_slots SET recipe_source=?, mealie_slug=?, local_recipe_id=?,
                   free_text=?, recipe_name=?, makes_lunch=?, notes=?, updated_at=?
                   WHERE id=?""",
                (recipe_source, mealie_slug, local_recipe_id, free_text,
                 recipe_name, int(makes_lunch), notes, now, slot_id),
            )
        else:
            slot_id = new_id()
            db.execute(
                """INSERT INTO meal_slots
                   (id, plan_id, slot_date, recipe_source, mealie_slug, local_recipe_id,
                    free_text, recipe_name, makes_lunch, notes, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (slot_id, plan_id, slot_date, recipe_source, mealie_slug, local_recipe_id,
                 free_text, recipe_name, int(makes_lunch), notes, now, now),
            )
        _record_notification_event(
            db, actor_name,
            f"menu.slot.{'changed' if existing else 'assigned'}",
            {"slot_date": slot_date, "recipe_name": recipe_name},
        )
        slot = _boolify_slot(dict(db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id,)).fetchone()))
        slot["sides"] = _get_sides_for_slot(db, slot_id)
        slot["tags"] = _tags_for_slot(db, slot, _canonical_tags_map(db))
        return slot


def clear_slot(plan_id: str, slot_date: str, actor_name: str) -> None:
    with connect() as db:
        row = db.execute(
            "SELECT id, recipe_name FROM meal_slots WHERE plan_id=? AND slot_date=?",
            (plan_id, slot_date),
        ).fetchone()
        if row:
            db.execute("DELETE FROM meal_slots WHERE id=?", (row["id"],))
            _record_notification_event(
                db, actor_name, "menu.slot.cleared",
                {"slot_date": slot_date, "recipe_name": row["recipe_name"]},
            )


def move_slot(slot_id: str, new_date: str, actor_name: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id,)).fetchone()
        if not row:
            raise ValueError("Slot introuvable")
        existing = db.execute(
            "SELECT id FROM meal_slots WHERE plan_id=? AND slot_date=? AND id!=?",
            (row["plan_id"], new_date, slot_id),
        ).fetchone()
        if existing:
            raise ValueError("Un repas existe déjà à cette date")
        now = now_iso()
        db.execute(
            "UPDATE meal_slots SET slot_date=?, updated_at=? WHERE id=?",
            (new_date, now, slot_id),
        )
        _record_notification_event(
            db, actor_name, "menu.slot.changed",
            {"slot_date": new_date, "recipe_name": row["recipe_name"]},
        )
        slot = _boolify_slot(dict(db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id,)).fetchone()))
        slot["sides"] = _get_sides_for_slot(db, slot_id)
        slot["tags"] = _tags_for_slot(db, slot, _canonical_tags_map(db))
        return slot


def swap_slots(slot_id_a: str, slot_id_b: str, actor_name: str) -> tuple[dict, dict]:
    with connect() as db:
        a = db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id_a,)).fetchone()
        b = db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id_b,)).fetchone()
        if not a or not b:
            raise ValueError("Slot introuvable")
        now = now_iso()
        db.execute(
            """UPDATE meal_slots SET slot_date=?, updated_at=? WHERE id=?""",
            (b["slot_date"], now, slot_id_a),
        )
        db.execute(
            """UPDATE meal_slots SET slot_date=?, updated_at=? WHERE id=?""",
            (a["slot_date"], now, slot_id_b),
        )
        _record_notification_event(
            db, actor_name, "menu.slot.swapped",
            {"date_a": a["slot_date"], "recipe_a": a["recipe_name"],
             "date_b": b["slot_date"], "recipe_b": b["recipe_name"]},
        )
        updated_a = _boolify_slot(dict(db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id_a,)).fetchone()))
        updated_b = _boolify_slot(dict(db.execute("SELECT * FROM meal_slots WHERE id=?", (slot_id_b,)).fetchone()))
        updated_a["sides"] = _get_sides_for_slot(db, slot_id_a)
        updated_b["sides"] = _get_sides_for_slot(db, slot_id_b)
        tags_map = _canonical_tags_map(db)
        updated_a["tags"] = _tags_for_slot(db, updated_a, tags_map)
        updated_b["tags"] = _tags_for_slot(db, updated_b, tags_map)
        return updated_a, updated_b


# ---------------------------------------------------------------------------
# sides (bibliothèque)
# ---------------------------------------------------------------------------

def list_sides() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM sides ORDER BY category, name").fetchall()
        return [dict(r) for r in rows]


def create_side(name: str, category: str = "") -> dict[str, Any]:
    with connect() as db:
        side_id = new_id()
        now = now_iso()
        db.execute(
            "INSERT INTO sides (id, name, category, created_at) VALUES (?,?,?,?)",
            (side_id, name.strip(), category.strip(), now),
        )
        return {"id": side_id, "name": name.strip(), "category": category.strip(), "created_at": now}


def update_side(side_id: str, name: str | None = None, category: str | None = None) -> dict[str, Any]:
    with connect() as db:
        if name is not None:
            db.execute("UPDATE sides SET name=? WHERE id=?", (name.strip(), side_id))
        if category is not None:
            db.execute("UPDATE sides SET category=? WHERE id=?", (category.strip(), side_id))
        row = db.execute("SELECT * FROM sides WHERE id=?", (side_id,)).fetchone()
        if not row:
            raise ValueError("Side introuvable")
        return dict(row)


def delete_side(side_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM sides WHERE id=?", (side_id,))


def _get_sides_for_slot(db: sqlite3.Connection, slot_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        """SELECT ss.id, ss.side_id, ss.free_text, ss.sort_order,
                  s.name as side_name, s.category as side_category
           FROM meal_slot_sides ss
           LEFT JOIN sides s ON s.id = ss.side_id
           WHERE ss.slot_id = ?
           ORDER BY ss.sort_order""",
        (slot_id,),
    ).fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "side_id": r["side_id"],
            "name": r["side_name"] if r["side_id"] else r["free_text"],
            "free_text": r["free_text"],
            "category": r["side_category"] or "",
            "sort_order": r["sort_order"],
        })
    return result


def set_slot_sides(slot_id: str, sides: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remplace tous les sides d'un slot. sides = [{side_id?, free_text?}, ...]"""
    with connect() as db:
        db.execute("DELETE FROM meal_slot_sides WHERE slot_id=?", (slot_id,))
        now = now_iso()
        for i, s in enumerate(sides):
            db.execute(
                """INSERT INTO meal_slot_sides (id, slot_id, side_id, free_text, sort_order, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (new_id(), slot_id, s.get("side_id"), s.get("free_text", ""), i, now),
            )
        return _get_sides_for_slot(db, slot_id)


# ---------------------------------------------------------------------------
# local_recipes
# ---------------------------------------------------------------------------

def list_local_recipes() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM local_recipes ORDER BY name").fetchall()
        tags_map = _canonical_tags_map(db)
        return [_parse_local_recipe(dict(r), tags_map) for r in rows]


def get_local_recipe(recipe_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM local_recipes WHERE id=?", (recipe_id,)).fetchone()
        return _parse_local_recipe(dict(row), _canonical_tags_map(db)) if row else None


def create_local_recipe(
    name: str,
    ingredients: list[dict] | None = None,
    tag_ids: list[str] | None = None,
    is_weekend: bool = False,
    makes_lunch: bool = False,
    prep_minutes: int | None = None,
    notes: str = "",
) -> dict[str, Any]:
    with connect() as db:
        recipe_id = new_id()
        now = now_iso()
        db.execute(
            """INSERT INTO local_recipes
               (id, name, ingredients_json, tags_json, is_weekend, makes_lunch,
                prep_minutes, notes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (recipe_id, name.strip(),
             json.dumps(ingredients or []),
             json.dumps(tag_ids or []),
             int(is_weekend), int(makes_lunch),
             prep_minutes, notes, now, now),
        )
        row = db.execute("SELECT * FROM local_recipes WHERE id=?", (recipe_id,)).fetchone()
        return _parse_local_recipe(dict(row), _canonical_tags_map(db))


def update_local_recipe(recipe_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        allowed = {"name", "ingredients_json", "tags_json", "is_weekend",
                   "makes_lunch", "prep_minutes", "notes"}
        updates: list[tuple[str, Any]] = []
        for key, val in payload.items():
            if key == "ingredients" and isinstance(val, list):
                updates.append(("ingredients_json", json.dumps(val)))
            elif key == "tag_ids" and isinstance(val, list):
                updates.append(("tags_json", json.dumps(val)))
            elif key in allowed:
                updates.append((key, val))
        if updates:
            set_clause = ", ".join(f"{k}=?" for k, _ in updates)
            values = [v for _, v in updates] + [now, recipe_id]
            db.execute(f"UPDATE local_recipes SET {set_clause}, updated_at=? WHERE id=?", values)
        row = db.execute("SELECT * FROM local_recipes WHERE id=?", (recipe_id,)).fetchone()
        if not row:
            raise ValueError("Recette introuvable")
        return _parse_local_recipe(dict(row), _canonical_tags_map(db))


def delete_local_recipe(recipe_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM local_recipes WHERE id=?", (recipe_id,))


def _canonical_tags_map(db: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    rows = db.execute("SELECT * FROM canonical_tags").fetchall()
    return {r["id"]: dict(r) for r in rows}


def _parse_local_recipe(r: dict, tags_map: dict[str, dict[str, Any]]) -> dict:
    r["ingredients"] = json.loads(r.get("ingredients_json") or "[]")
    tag_ids = json.loads(r.get("tags_json") or "[]")
    r["tag_ids"] = tag_ids
    r["tags"] = [tags_map[i] for i in tag_ids if i in tags_map]
    return r


# ---------------------------------------------------------------------------
# recipe_meta (métadonnées famille sur les recettes Mealie)
# ---------------------------------------------------------------------------

def get_recipe_meta(mealie_slug: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            "SELECT * FROM recipe_meta WHERE mealie_slug=?", (mealie_slug,)
        ).fetchone()
        if row:
            return dict(row)
        return {"mealie_slug": mealie_slug, "is_weekend": 0, "makes_lunch": 0, "is_hidden": 0, "notes": ""}


def upsert_recipe_meta(
    mealie_slug: str,
    is_weekend: bool | None = None,
    makes_lunch: bool | None = None,
    is_hidden: bool | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        existing = db.execute(
            "SELECT * FROM recipe_meta WHERE mealie_slug=?", (mealie_slug,)
        ).fetchone()
        if existing:
            updates: list[tuple[str, Any]] = []
            if is_weekend is not None:
                updates.append(("is_weekend", int(is_weekend)))
            if makes_lunch is not None:
                updates.append(("makes_lunch", int(makes_lunch)))
            if is_hidden is not None:
                updates.append(("is_hidden", int(is_hidden)))
            if notes is not None:
                updates.append(("notes", notes))
            if updates:
                set_clause = ", ".join(f"{k}=?" for k, _ in updates)
                values = [v for _, v in updates] + [now, mealie_slug]
                db.execute(
                    f"UPDATE recipe_meta SET {set_clause}, updated_at=? WHERE mealie_slug=?", values
                )
        else:
            db.execute(
                """INSERT INTO recipe_meta (mealie_slug, is_weekend, makes_lunch, is_hidden, notes, updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    mealie_slug,
                    int(is_weekend or False),
                    int(makes_lunch or False),
                    int(is_hidden or False),
                    notes or "",
                    now,
                ),
            )
        row = db.execute("SELECT * FROM recipe_meta WHERE mealie_slug=?", (mealie_slug,)).fetchone()
        return dict(row)


# ---------------------------------------------------------------------------
# canonical_tags
# ---------------------------------------------------------------------------

def _boolify_tag(tag: dict[str, Any]) -> dict[str, Any]:
    tag["is_filter"] = bool(tag.get("is_filter"))
    return tag


def list_canonical_tags() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM canonical_tags ORDER BY name").fetchall()
        return [_boolify_tag(dict(r)) for r in rows]


def create_canonical_tag(
    name: str, description: str = "", color: str = "", is_filter: bool = False
) -> dict[str, Any]:
    with connect() as db:
        tag_id = new_id()
        now = now_iso()
        db.execute(
            """INSERT INTO canonical_tags (id, name, description, color, is_filter, created_at)
               VALUES (?,?,?,?,?,?)""",
            (tag_id, name.strip(), description.strip(), color.strip(), int(is_filter), now),
        )
        row = db.execute("SELECT * FROM canonical_tags WHERE id=?", (tag_id,)).fetchone()
        return _boolify_tag(dict(row))


def update_canonical_tag(
    tag_id: str, name: str | None = None, color: str | None = None, is_filter: bool | None = None
) -> dict[str, Any]:
    with connect() as db:
        updates: list[tuple[str, Any]] = []
        if name is not None and name.strip():
            updates.append(("name", name.strip()))
        if color is not None:
            updates.append(("color", color.strip()))
        if is_filter is not None:
            updates.append(("is_filter", int(is_filter)))
        if updates:
            set_clause = ", ".join(f"{k}=?" for k, _ in updates)
            values = [v for _, v in updates] + [tag_id]
            db.execute(f"UPDATE canonical_tags SET {set_clause} WHERE id=?", values)
        row = db.execute("SELECT * FROM canonical_tags WHERE id=?", (tag_id,)).fetchone()
        if not row:
            raise ValueError("Tag introuvable")
        return _boolify_tag(dict(row))


def delete_canonical_tag(tag_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM canonical_tags WHERE id=?", (tag_id,))


# ---------------------------------------------------------------------------
# mealie_tag_mappings
# ---------------------------------------------------------------------------

def list_tag_mappings(status: str | None = None) -> list[dict[str, Any]]:
    with connect() as db:
        if status:
            rows = db.execute(
                """SELECT m.*, t.name as canonical_tag_name
                   FROM mealie_tag_mappings m
                   LEFT JOIN canonical_tags t ON t.id = m.canonical_tag_id
                   WHERE m.status = ? ORDER BY m.mealie_tag_name""",
                (status,),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT m.*, t.name as canonical_tag_name
                   FROM mealie_tag_mappings m
                   LEFT JOIN canonical_tags t ON t.id = m.canonical_tag_id
                   ORDER BY m.mealie_tag_name""",
            ).fetchall()
        return [dict(r) for r in rows]


def upsert_tag_mapping(
    mealie_tag_name: str,
    canonical_tag_id: str | None,
    status: str,
    confirmed_by: str = "",
) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        db.execute(
            """INSERT INTO mealie_tag_mappings
               (mealie_tag_name, canonical_tag_id, status, confirmed_at, confirmed_by)
               VALUES (?,?,?,?,?)
               ON CONFLICT(mealie_tag_name) DO UPDATE SET
               canonical_tag_id=excluded.canonical_tag_id,
               status=excluded.status,
               confirmed_at=excluded.confirmed_at,
               confirmed_by=excluded.confirmed_by""",
            (mealie_tag_name, canonical_tag_id, status,
             now if status == "confirmed" else "", confirmed_by),
        )
        row = db.execute(
            "SELECT * FROM mealie_tag_mappings WHERE mealie_tag_name=?", (mealie_tag_name,)
        ).fetchone()
        return dict(row)


def import_mealie_tags(mealie_tags: list[str]) -> None:
    """Importe les tags Mealie. Crée les entrées pending absentes, auto-suggère si nom ≈ canonique."""
    with connect() as db:
        canonical = {
            r["name"].lower(): r["id"]
            for r in db.execute("SELECT id, name FROM canonical_tags").fetchall()
        }
        for tag in mealie_tags:
            existing = db.execute(
                "SELECT status FROM mealie_tag_mappings WHERE mealie_tag_name=?", (tag,)
            ).fetchone()
            if existing:
                continue
            suggested_id = canonical.get(tag.lower().strip())
            db.execute(
                """INSERT OR IGNORE INTO mealie_tag_mappings
                   (mealie_tag_name, canonical_tag_id, status, confirmed_at, confirmed_by)
                   VALUES (?,?,?,?,?)""",
                (tag, suggested_id, "pending", "", ""),
            )


# ---------------------------------------------------------------------------
# push_subscriptions
# ---------------------------------------------------------------------------

def save_push_subscription(endpoint: str, actor_name: str, subscription: dict) -> None:
    with connect() as db:
        now = now_iso()
        db.execute(
            """INSERT INTO push_subscriptions (endpoint, actor_name, subscription_json, created_at, updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(endpoint) DO UPDATE SET
               actor_name=excluded.actor_name,
               subscription_json=excluded.subscription_json,
               updated_at=excluded.updated_at""",
            (endpoint, actor_name, json.dumps(subscription), now, now),
        )


def delete_push_subscription(endpoint: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))


def list_push_subscriptions() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM push_subscriptions").fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# historique / stats
# ---------------------------------------------------------------------------

def search_history(q: str, limit: int = 50) -> list[dict[str, Any]]:
    """Recherche dans les slots passés par nom de recette."""
    with connect() as db:
        pattern = f"%{q.strip()}%"
        rows = db.execute(
            """SELECT ms.*, mp.week_start
               FROM meal_slots ms
               JOIN meal_plans mp ON mp.id = ms.plan_id
               WHERE ms.recipe_name LIKE ?
               ORDER BY ms.slot_date DESC
               LIMIT ?""",
            (pattern, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def recipe_frequency(weeks: int = 12) -> list[dict[str, Any]]:
    """Fréquence des recettes sur N semaines passées."""
    with connect() as db:
        rows = db.execute(
            """SELECT recipe_name, recipe_source, mealie_slug, local_recipe_id,
                      COUNT(*) as count,
                      MAX(slot_date) as last_date,
                      MIN(slot_date) as first_date
               FROM meal_slots
               WHERE slot_date >= date('now', ? || ' days')
               GROUP BY recipe_name
               ORDER BY count DESC""",
            (f"-{weeks * 7}",),
        ).fetchall()
        return [dict(r) for r in rows]


def side_frequency(weeks: int = 12) -> list[dict[str, Any]]:
    """Fréquence des accompagnements sur N semaines passées."""
    with connect() as db:
        rows = db.execute(
            """SELECT COALESCE(sd.name, ss.free_text) as name, ss.side_id as side_id,
                      COALESCE(sd.category, '') as category,
                      COUNT(*) as count
               FROM meal_slot_sides ss
               JOIN meal_slots ms ON ms.id = ss.slot_id
               LEFT JOIN sides sd ON sd.id = ss.side_id
               WHERE ms.slot_date >= date('now', ? || ' days')
                 AND COALESCE(sd.name, ss.free_text) != ''
               GROUP BY COALESCE(sd.name, ss.free_text)
               ORDER BY count DESC""",
            (f"-{weeks * 7}",),
        ).fetchall()
        return [dict(r) for r in rows]


def last_planned(recipe_name: str) -> dict[str, Any] | None:
    """Dernière planification d'une recette par son nom."""
    with connect() as db:
        row = db.execute(
            "SELECT * FROM meal_slots WHERE recipe_name=? ORDER BY slot_date DESC LIMIT 1",
            (recipe_name,),
        ).fetchone()
        return dict(row) if row else None


# ---------------------------------------------------------------------------
# notifications (internal helper)
# ---------------------------------------------------------------------------

def _record_notification_event(
    db: sqlite3.Connection,
    actor_name: str,
    action: str,
    payload: dict[str, Any],
) -> None:
    event_id = new_id()
    now = now_iso()
    dedupe_key = f"{action}:{payload.get('slot_date', '')}:{payload.get('recipe_name', '')}"
    try:
        db.execute(
            """INSERT INTO notification_events
               (id, dedupe_key, status, actor_name, event_json, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (event_id, dedupe_key, "pending", actor_name, json.dumps(payload), now, now),
        )
    except sqlite3.IntegrityError:
        # déjà en attente pour cette clé, on ignore
        pass
