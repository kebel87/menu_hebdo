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
DEFAULT_RECIPE_CATEGORY_TAGS = ("Boeuf", "Pâtes", "Poulet", "Porc", "Poisson", "Végé")


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
        _seed_default_recipe_category_tags(db)


def get_meta_value(key: str) -> str | None:
    with connect() as db:
        row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None


def set_meta_value(key: str, value: str) -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


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
    local_cols = {row[1] for row in db.execute("PRAGMA table_info(local_recipes)").fetchall()}
    if "liked_by_json" not in local_cols:
        db.execute("ALTER TABLE local_recipes ADD COLUMN liked_by_json TEXT NOT NULL DEFAULT '[]'")
    meta_cols = {row[1] for row in db.execute("PRAGMA table_info(recipe_meta)").fetchall()}
    if "liked_by_json" not in meta_cols:
        db.execute("ALTER TABLE recipe_meta ADD COLUMN liked_by_json TEXT NOT NULL DEFAULT '[]'")
    side_cols = {row[1] for row in db.execute("PRAGMA table_info(sides)").fetchall()}
    if "is_active" not in side_cols:
        db.execute("ALTER TABLE sides ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
    if "category" in side_cols:
        db.execute("ALTER TABLE sides DROP COLUMN category")
    db.execute("""
        CREATE TABLE IF NOT EXISTS child_colors (
            child_id TEXT PRIMARY KEY,
            color TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )
    """)
    existing_tables = {
        row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    if "family_members" not in existing_tables:
        db.execute("""
            CREATE TABLE family_members (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                short_label TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        now = now_iso()
        # Amélie et Kevin ne sont pas suivis par calendrier_familiale (pas de garde
        # partagée à gérer pour les parents) mais ont des préférences de repas au
        # même titre que les enfants.
        for member_id, name, short_label in (("kevin", "Kevin", "K"), ("amelie", "Amélie", "A")):
            db.execute(
                "INSERT INTO family_members (id, name, short_label, color, created_at) VALUES (?,?,?,?,?)",
                (member_id, name, short_label, "", now),
            )
    db.execute("""
        CREATE TABLE IF NOT EXISTS meal_contexts (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_meal_contexts_kind ON meal_contexts(kind, is_active, name)")
    context_cols = {row[1] for row in db.execute("PRAGMA table_info(meal_contexts)").fetchall()}
    for obsolete_col in ("cuisine", "address", "phone", "website", "notes"):
        if obsolete_col in context_cols:
            db.execute(f"ALTER TABLE meal_contexts DROP COLUMN {obsolete_col}")
    db.execute("UPDATE meal_contexts SET kind='people' WHERE kind IN ('away', 'hosting')")
    _merge_duplicate_meal_contexts(db)
    slot_cols = {row[1] for row in db.execute("PRAGMA table_info(meal_slots)").fetchall()}
    if "slot_kind" not in slot_cols:
        db.execute("ALTER TABLE meal_slots ADD COLUMN slot_kind TEXT NOT NULL DEFAULT 'recipe'")
    if "context_id" not in slot_cols:
        db.execute("ALTER TABLE meal_slots ADD COLUMN context_id TEXT")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS canonical_ingredients (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS canonical_ingredient_inventory_links (
            id TEXT PRIMARY KEY,
            canonical_ingredient_id TEXT NOT NULL REFERENCES canonical_ingredients(id) ON DELETE CASCADE,
            inventory_product_id TEXT NOT NULL,
            inventory_product_name TEXT NOT NULL DEFAULT '',
            domain TEXT NOT NULL DEFAULT 'frozen',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ingredient_links_canonical
            ON canonical_ingredient_inventory_links(canonical_ingredient_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredient_links_product
            ON canonical_ingredient_inventory_links(inventory_product_id);

        CREATE TABLE IF NOT EXISTS mealie_ingredient_mappings (
            mealie_ingredient_text TEXT PRIMARY KEY,
            canonical_ingredient_id TEXT REFERENCES canonical_ingredients(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            confirmed_at TEXT NOT NULL DEFAULT '',
            confirmed_by TEXT NOT NULL DEFAULT ''
        );
    """)


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


def _merge_duplicate_meal_contexts(db: sqlite3.Connection) -> None:
    rows = db.execute(
        """SELECT kind, lower(trim(name)) as normalized_name, GROUP_CONCAT(id) as ids
           FROM meal_contexts
           GROUP BY kind, lower(trim(name))
           HAVING COUNT(*) > 1"""
    ).fetchall()
    for row in rows:
        ids = [context_id for context_id in row["ids"].split(",") if context_id]
        if len(ids) < 2:
            continue
        keeper = ids[0]
        for duplicate_id in ids[1:]:
            db.execute("UPDATE meal_slots SET context_id=? WHERE context_id=?", (keeper, duplicate_id))
            db.execute("DELETE FROM meal_contexts WHERE id=?", (duplicate_id,))


def _create_tables(db: sqlite3.Connection) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS meal_contexts (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_meal_contexts_kind ON meal_contexts(kind, is_active, name)")
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
            slot_kind TEXT NOT NULL DEFAULT 'recipe',
            context_id TEXT REFERENCES meal_contexts(id) ON DELETE SET NULL,
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

        CREATE TABLE IF NOT EXISTS meal_contexts (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_meal_contexts_kind ON meal_contexts(kind, is_active, name);

        CREATE TABLE IF NOT EXISTS sides (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
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

        CREATE TABLE IF NOT EXISTS child_colors (
            child_id TEXT PRIMARY KEY,
            color TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
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


def _seed_default_recipe_category_tags(db: sqlite3.Connection) -> None:
    now = now_iso()
    for tag_name in DEFAULT_RECIPE_CATEGORY_TAGS:
        exists = db.execute(
            "SELECT 1 FROM canonical_tags WHERE lower(name)=lower(?)",
            (tag_name,),
        ).fetchone()
        if exists:
            continue
        db.execute(
            """INSERT INTO canonical_tags (id, name, description, color, is_filter, created_at)
               VALUES (?, ?, '', '', 1, ?)""",
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
    slot["slot_kind"] = slot.get("slot_kind") or "recipe"
    return slot


def _boolify_context(context: dict[str, Any]) -> dict[str, Any]:
    context["is_active"] = bool(context.get("is_active", 1))
    return context


def _context_for_slot(db: sqlite3.Connection, context_id: str | None) -> dict[str, Any] | None:
    if not context_id:
        return None
    row = db.execute("SELECT * FROM meal_contexts WHERE id=?", (context_id,)).fetchone()
    return _boolify_context(dict(row)) if row else None


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
            slot["context"] = _context_for_slot(db, slot.get("context_id"))
        return slots


def get_slot(slot_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM meal_slots WHERE id = ?", (slot_id,)).fetchone()
        if not row:
            return None
        slot = _boolify_slot(dict(row))
        slot["sides"] = _get_sides_for_slot(db, slot_id)
        slot["tags"] = _tags_for_slot(db, slot, _canonical_tags_map(db))
        slot["context"] = _context_for_slot(db, slot.get("context_id"))
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
            slot["context"] = _context_for_slot(db, slot.get("context_id"))
        return slots


def upsert_slot(
    plan_id: str,
    slot_date: str,
    recipe_source: str,
    recipe_name: str,
    actor_name: str,
    slot_kind: str = "recipe",
    context_id: str | None = None,
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
                """UPDATE meal_slots SET slot_kind=?, context_id=?, recipe_source=?, mealie_slug=?, local_recipe_id=?,
                   free_text=?, recipe_name=?, makes_lunch=?, notes=?, updated_at=?
                   WHERE id=?""",
                (slot_kind, context_id, recipe_source, mealie_slug, local_recipe_id, free_text,
                 recipe_name, int(makes_lunch), notes, now, slot_id),
            )
        else:
            slot_id = new_id()
            db.execute(
                """INSERT INTO meal_slots
                   (id, plan_id, slot_date, slot_kind, context_id, recipe_source, mealie_slug, local_recipe_id,
                    free_text, recipe_name, makes_lunch, notes, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (slot_id, plan_id, slot_date, slot_kind, context_id, recipe_source, mealie_slug, local_recipe_id,
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
        slot["context"] = _context_for_slot(db, slot.get("context_id"))
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
        slot["context"] = _context_for_slot(db, slot.get("context_id"))
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
        updated_a["context"] = _context_for_slot(db, updated_a.get("context_id"))
        updated_b["context"] = _context_for_slot(db, updated_b.get("context_id"))
        return updated_a, updated_b


# ---------------------------------------------------------------------------
# meal_contexts (famille, invitations, restaurants)
# ---------------------------------------------------------------------------

def list_meal_contexts(kind: str | None = None, include_inactive: bool = False) -> list[dict[str, Any]]:
    with connect() as db:
        clauses = []
        params: list[Any] = []
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        if not include_inactive:
            clauses.append("is_active=1")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = db.execute(
            f"SELECT * FROM meal_contexts {where} ORDER BY kind, name",
            params,
        ).fetchall()
        return [_boolify_context(dict(r)) for r in rows]


def get_meal_context(context_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute("SELECT * FROM meal_contexts WHERE id=?", (context_id,)).fetchone()
        return _boolify_context(dict(row)) if row else None


def create_meal_context(
    kind: str,
    name: str,
) -> dict[str, Any]:
    with connect() as db:
        normalized_name = name.strip()
        existing = db.execute(
            "SELECT * FROM meal_contexts WHERE kind=? AND lower(name)=lower(?)",
            (kind, normalized_name),
        ).fetchone()
        if existing:
            db.execute(
                "UPDATE meal_contexts SET is_active=1, updated_at=? WHERE id=?",
                (now_iso(), existing["id"]),
            )
            row = db.execute("SELECT * FROM meal_contexts WHERE id=?", (existing["id"],)).fetchone()
            return _boolify_context(dict(row))
        context_id = new_id()
        now = now_iso()
        db.execute(
            """INSERT INTO meal_contexts
               (id, kind, name, is_active, created_at, updated_at)
               VALUES (?,?,?,?,?,?)""",
            (context_id, kind, name.strip(), 1, now, now),
        )
        row = db.execute("SELECT * FROM meal_contexts WHERE id=?", (context_id,)).fetchone()
        return _boolify_context(dict(row))


def update_meal_context(context_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    allowed = {"kind", "name", "is_active"}
    with connect() as db:
        updates: list[tuple[str, Any]] = []
        for key, value in payload.items():
            if key not in allowed:
                continue
            if key == "is_active":
                updates.append((key, int(bool(value))))
            elif value is not None:
                updates.append((key, str(value).strip()))
        if updates:
            set_clause = ", ".join(f"{k}=?" for k, _ in updates)
            values = [v for _, v in updates] + [now_iso(), context_id]
            db.execute(f"UPDATE meal_contexts SET {set_clause}, updated_at=? WHERE id=?", values)
        row = db.execute("SELECT * FROM meal_contexts WHERE id=?", (context_id,)).fetchone()
        if not row:
            raise ValueError("Contexte introuvable")
        row_data = dict(row)
        _merge_duplicate_meal_contexts(db)
        row = db.execute("SELECT * FROM meal_contexts WHERE id=?", (context_id,)).fetchone()
        if not row:
            row = db.execute(
                "SELECT * FROM meal_contexts WHERE kind=? AND lower(name)=lower(?) LIMIT 1",
                (row_data["kind"], row_data["name"]),
            ).fetchone()
        return _boolify_context(dict(row))


def delete_meal_context(context_id: str) -> None:
    with connect() as db:
        db.execute("UPDATE meal_contexts SET is_active=0, updated_at=? WHERE id=?", (now_iso(), context_id))


# ---------------------------------------------------------------------------
# sides (bibliothèque)
# ---------------------------------------------------------------------------

def _boolify_side(side: dict[str, Any]) -> dict[str, Any]:
    side["is_active"] = bool(side.get("is_active", 1))
    return side


def list_sides(include_inactive: bool = False) -> list[dict[str, Any]]:
    with connect() as db:
        if include_inactive:
            rows = db.execute("SELECT * FROM sides ORDER BY name").fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM sides WHERE is_active=1 ORDER BY name"
            ).fetchall()
        return [_boolify_side(dict(r)) for r in rows]


def create_side(name: str) -> dict[str, Any]:
    with connect() as db:
        side_id = new_id()
        now = now_iso()
        db.execute(
            "INSERT INTO sides (id, name, is_active, created_at) VALUES (?,?,?,?)",
            (side_id, name.strip(), 1, now),
        )
        row = db.execute("SELECT * FROM sides WHERE id=?", (side_id,)).fetchone()
        return _boolify_side(dict(row))


def update_side(
    side_id: str,
    name: str | None = None,
    is_active: bool | None = None,
) -> dict[str, Any]:
    with connect() as db:
        if name is not None:
            db.execute("UPDATE sides SET name=? WHERE id=?", (name.strip(), side_id))
        if is_active is not None:
            db.execute("UPDATE sides SET is_active=? WHERE id=?", (int(is_active), side_id))
        row = db.execute("SELECT * FROM sides WHERE id=?", (side_id,)).fetchone()
        if not row:
            raise ValueError("Side introuvable")
        return _boolify_side(dict(row))


def delete_side(side_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM sides WHERE id=?", (side_id,))


def side_usage_stats() -> list[dict[str, Any]]:
    """Statistiques d'usage par accompagnement de la bibliothèque : nombre de
    fois utilisé et date de dernière consommation (toutes périodes confondues)."""
    with connect() as db:
        rows = db.execute(
            """SELECT s.id, s.name, s.is_active, s.created_at,
                      COUNT(ss.id) as total_count,
                      MAX(ms.slot_date) as last_used
               FROM sides s
               LEFT JOIN meal_slot_sides ss ON ss.side_id = s.id
               LEFT JOIN meal_slots ms ON ms.id = ss.slot_id
               GROUP BY s.id
               ORDER BY s.name"""
        ).fetchall()
        return [_boolify_side(dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# child_colors (couleur des tags de présence par enfant, enfants gérés par
# calendrier_familiale — menu_hebdo ne connaît que leur id/couleur locale)
# ---------------------------------------------------------------------------

def list_child_colors() -> dict[str, str]:
    with connect() as db:
        rows = db.execute("SELECT child_id, color FROM child_colors").fetchall()
        return {r["child_id"]: r["color"] for r in rows}


def set_child_color(child_id: str, color: str) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        db.execute(
            """INSERT INTO child_colors (child_id, color, updated_at) VALUES (?,?,?)
               ON CONFLICT(child_id) DO UPDATE SET color=excluded.color, updated_at=excluded.updated_at""",
            (child_id, color.strip(), now),
        )
        return {"child_id": child_id, "color": color.strip()}


# ---------------------------------------------------------------------------
# family_members (parents et autres adultes hors calendrier_familiale, mais
# dont les préférences de repas comptent pour "aimé par")
# ---------------------------------------------------------------------------

def list_family_members() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM family_members ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def create_family_member(name: str, short_label: str, color: str = "") -> dict[str, Any]:
    with connect() as db:
        member_id = new_id()
        now = now_iso()
        db.execute(
            "INSERT INTO family_members (id, name, short_label, color, created_at) VALUES (?,?,?,?,?)",
            (member_id, name.strip(), short_label.strip()[:2] or name.strip()[:1].upper(), color.strip(), now),
        )
        row = db.execute("SELECT * FROM family_members WHERE id=?", (member_id,)).fetchone()
        return dict(row)


def update_family_member(
    member_id: str,
    name: str | None = None,
    short_label: str | None = None,
    color: str | None = None,
) -> dict[str, Any]:
    with connect() as db:
        updates: list[tuple[str, Any]] = []
        if name is not None and name.strip():
            updates.append(("name", name.strip()))
        if short_label is not None and short_label.strip():
            updates.append(("short_label", short_label.strip()[:2]))
        if color is not None:
            updates.append(("color", color.strip()))
        if updates:
            set_clause = ", ".join(f"{k}=?" for k, _ in updates)
            values = [v for _, v in updates] + [member_id]
            db.execute(f"UPDATE family_members SET {set_clause} WHERE id=?", values)
        row = db.execute("SELECT * FROM family_members WHERE id=?", (member_id,)).fetchone()
        if not row:
            raise ValueError("Membre introuvable")
        return dict(row)


def delete_family_member(member_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM family_members WHERE id=?", (member_id,))


def _get_sides_for_slot(db: sqlite3.Connection, slot_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        """SELECT ss.id, ss.side_id, ss.free_text, ss.sort_order,
                  s.name as side_name
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
    liked_by: list[str] | None = None,
    is_weekend: bool = False,
    makes_lunch: bool = False,
    prep_minutes: int | None = None,
    notes: str = "",
) -> dict[str, Any]:
    with connect() as db:
        recipe_id = new_id()
        now = now_iso()
        normalized_tag_ids = _local_recipe_tag_ids(db, tag_ids, is_weekend, makes_lunch)
        db.execute(
            """INSERT INTO local_recipes
               (id, name, ingredients_json, tags_json, liked_by_json, is_weekend, makes_lunch,
                prep_minutes, notes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (recipe_id, name.strip(),
             json.dumps(ingredients or []),
             json.dumps(normalized_tag_ids),
             json.dumps(liked_by or []),
             int(is_weekend), int(makes_lunch),
             prep_minutes, notes, now, now),
        )
        row = db.execute("SELECT * FROM local_recipes WHERE id=?", (recipe_id,)).fetchone()
        return _parse_local_recipe(dict(row), _canonical_tags_map(db))


def update_local_recipe(recipe_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        existing = db.execute("SELECT * FROM local_recipes WHERE id=?", (recipe_id,)).fetchone()
        if not existing:
            raise ValueError("Recette introuvable")
        normalized_tag_ids: list[str] | None = None
        if "tag_ids" in payload or "is_weekend" in payload or "makes_lunch" in payload:
            current_tag_ids = json.loads(existing["tags_json"] or "[]")
            supplied_tag_ids = payload.get("tag_ids")
            next_tag_ids = supplied_tag_ids if isinstance(supplied_tag_ids, list) else current_tag_ids
            next_is_weekend = bool(payload.get("is_weekend", existing["is_weekend"]))
            next_makes_lunch = bool(payload.get("makes_lunch", existing["makes_lunch"]))
            normalized_tag_ids = _local_recipe_tag_ids(db, next_tag_ids, next_is_weekend, next_makes_lunch)
        allowed = {"name", "ingredients_json", "tags_json", "liked_by_json", "is_weekend",
                   "makes_lunch", "prep_minutes", "notes"}
        updates: list[tuple[str, Any]] = []
        for key, val in payload.items():
            if key == "ingredients" and isinstance(val, list):
                updates.append(("ingredients_json", json.dumps(val)))
            elif key == "tag_ids" and isinstance(val, list):
                continue
            elif key == "liked_by" and isinstance(val, list):
                updates.append(("liked_by_json", json.dumps(val)))
            elif key in allowed:
                updates.append((key, val))
        if normalized_tag_ids is not None:
            updates.append(("tags_json", json.dumps(normalized_tag_ids)))
        if updates:
            set_clause = ", ".join(f"{k}=?" for k, _ in updates)
            values = [v for _, v in updates] + [now, recipe_id]
            db.execute(f"UPDATE local_recipes SET {set_clause}, updated_at=? WHERE id=?", values)
        row = db.execute("SELECT * FROM local_recipes WHERE id=?", (recipe_id,)).fetchone()
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
    r["liked_by"] = json.loads(r.get("liked_by_json") or "[]")
    r["is_weekend"] = bool(r.get("is_weekend"))
    r["makes_lunch"] = bool(r.get("makes_lunch"))
    return r


def _local_recipe_tag_ids(
    db: sqlite3.Connection,
    tag_ids: list[str] | None,
    is_weekend: bool,
    makes_lunch: bool,
) -> list[str]:
    tech_tags = {
        r["name"].lower(): r["id"]
        for r in db.execute("SELECT id, name FROM canonical_tags WHERE name IN ('weekend', 'lunchs')").fetchall()
    }
    tech_ids = set(tech_tags.values())
    result: list[str] = []
    seen: set[str] = set()
    for tag_id in tag_ids or []:
        if tag_id in tech_ids or tag_id in seen:
            continue
        result.append(tag_id)
        seen.add(tag_id)
    if is_weekend and tech_tags.get("weekend") and tech_tags["weekend"] not in seen:
        result.append(tech_tags["weekend"])
        seen.add(tech_tags["weekend"])
    if makes_lunch and tech_tags.get("lunchs") and tech_tags["lunchs"] not in seen:
        result.append(tech_tags["lunchs"])
    return result


# ---------------------------------------------------------------------------
# recipe_meta (métadonnées famille sur les recettes Mealie)
# ---------------------------------------------------------------------------

def _parse_recipe_meta(r: dict) -> dict:
    r["liked_by"] = json.loads(r.get("liked_by_json") or "[]")
    r["is_weekend"] = bool(r.get("is_weekend"))
    r["makes_lunch"] = bool(r.get("makes_lunch"))
    r["is_hidden"] = bool(r.get("is_hidden"))
    return r


def get_recipe_meta(mealie_slug: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute(
            "SELECT * FROM recipe_meta WHERE mealie_slug=?", (mealie_slug,)
        ).fetchone()
        if row:
            return _parse_recipe_meta(dict(row))
        return {"mealie_slug": mealie_slug, "is_weekend": 0, "makes_lunch": 0, "is_hidden": 0,
                "notes": "", "liked_by": []}


def upsert_recipe_meta(
    mealie_slug: str,
    is_weekend: bool | None = None,
    makes_lunch: bool | None = None,
    is_hidden: bool | None = None,
    notes: str | None = None,
    liked_by: list[str] | None = None,
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
            if liked_by is not None:
                updates.append(("liked_by_json", json.dumps(liked_by)))
            if updates:
                set_clause = ", ".join(f"{k}=?" for k, _ in updates)
                values = [v for _, v in updates] + [now, mealie_slug]
                db.execute(
                    f"UPDATE recipe_meta SET {set_clause}, updated_at=? WHERE mealie_slug=?", values
                )
        else:
            db.execute(
                """INSERT INTO recipe_meta
                   (mealie_slug, is_weekend, makes_lunch, is_hidden, notes, liked_by_json, updated_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    mealie_slug,
                    int(is_weekend or False),
                    int(makes_lunch or False),
                    int(is_hidden or False),
                    notes or "",
                    json.dumps(liked_by or []),
                    now,
                ),
            )
        row = db.execute("SELECT * FROM recipe_meta WHERE mealie_slug=?", (mealie_slug,)).fetchone()
        return _parse_recipe_meta(dict(row))


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


def _import_mealie_mappings(
    db: sqlite3.Connection,
    mapping_table: str,
    name_column: str,
    canonical_table: str,
    canonical_id_column: str,
    values: list[str],
) -> None:
    """Crée les entrées 'pending' absentes du mapping pour les valeurs (noms Mealie)
    données, avec auto-suggestion si le nom matche un concept canonique existant.
    Généralise le pattern partagé par les tags et les ingrédients Mealie."""
    canonical = {
        r["name"].lower(): r["id"]
        for r in db.execute(f"SELECT id, name FROM {canonical_table}").fetchall()
    }
    for value in values:
        existing = db.execute(
            f"SELECT status FROM {mapping_table} WHERE {name_column}=?", (value,)
        ).fetchone()
        if existing:
            continue
        suggested_id = canonical.get(value.lower().strip())
        db.execute(
            f"""INSERT OR IGNORE INTO {mapping_table}
                ({name_column}, {canonical_id_column}, status, confirmed_at, confirmed_by)
                VALUES (?,?,?,?,?)""",
            (value, suggested_id, "pending", "", ""),
        )


def import_mealie_tags(mealie_tags: list[str]) -> None:
    """Importe les tags Mealie. Crée les entrées pending absentes, auto-suggère si nom ≈ canonique."""
    with connect() as db:
        _import_mealie_mappings(
            db, "mealie_tag_mappings", "mealie_tag_name",
            "canonical_tags", "canonical_tag_id", mealie_tags,
        )


# ---------------------------------------------------------------------------
# canonical_ingredients / mealie_ingredient_mappings / liens inventaire
# ---------------------------------------------------------------------------

def list_canonical_ingredients() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM canonical_ingredients ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def create_canonical_ingredient(name: str) -> dict[str, Any]:
    with connect() as db:
        ingredient_id = new_id()
        now = now_iso()
        db.execute(
            "INSERT INTO canonical_ingredients (id, name, created_at) VALUES (?,?,?)",
            (ingredient_id, name.strip(), now),
        )
        row = db.execute("SELECT * FROM canonical_ingredients WHERE id=?", (ingredient_id,)).fetchone()
        return dict(row)


def update_canonical_ingredient(ingredient_id: str, name: str) -> dict[str, Any]:
    with connect() as db:
        db.execute(
            "UPDATE canonical_ingredients SET name=? WHERE id=?", (name.strip(), ingredient_id)
        )
        row = db.execute("SELECT * FROM canonical_ingredients WHERE id=?", (ingredient_id,)).fetchone()
        if not row:
            raise ValueError("Ingrédient introuvable")
        return dict(row)


def delete_canonical_ingredient(ingredient_id: str) -> None:
    """Supprime l'ingrédient canonique et purge les références orphelines dans les
    ingredients_json des recettes locales (pas de FK SQL possible sur du JSON)."""
    with connect() as db:
        db.execute(
            """UPDATE mealie_ingredient_mappings
               SET canonical_ingredient_id=NULL, status='pending', confirmed_at='', confirmed_by=''
               WHERE canonical_ingredient_id=?""",
            (ingredient_id,),
        )
        db.execute("DELETE FROM canonical_ingredients WHERE id=?", (ingredient_id,))
        for row in db.execute("SELECT id, ingredients_json FROM local_recipes").fetchall():
            ingredients = json.loads(row["ingredients_json"] or "[]")
            changed = False
            for ing in ingredients:
                if ing.get("canonical_ingredient_id") == ingredient_id:
                    ing["canonical_ingredient_id"] = None
                    changed = True
            if changed:
                db.execute(
                    "UPDATE local_recipes SET ingredients_json=? WHERE id=?",
                    (json.dumps(ingredients), row["id"]),
                )


def list_ingredient_inventory_links(canonical_ingredient_id: str | None = None) -> list[dict[str, Any]]:
    with connect() as db:
        if canonical_ingredient_id:
            rows = db.execute(
                "SELECT * FROM canonical_ingredient_inventory_links WHERE canonical_ingredient_id=? ORDER BY inventory_product_name",
                (canonical_ingredient_id,),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM canonical_ingredient_inventory_links ORDER BY inventory_product_name"
            ).fetchall()
        return [dict(r) for r in rows]


def create_ingredient_inventory_link(
    canonical_ingredient_id: str,
    inventory_product_id: str,
    inventory_product_name: str,
    domain: str,
) -> dict[str, Any]:
    with connect() as db:
        link_id = new_id()
        now = now_iso()
        db.execute(
            """INSERT INTO canonical_ingredient_inventory_links
               (id, canonical_ingredient_id, inventory_product_id, inventory_product_name, domain, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(inventory_product_id) DO UPDATE SET
               canonical_ingredient_id=excluded.canonical_ingredient_id,
               inventory_product_name=excluded.inventory_product_name,
               domain=excluded.domain,
               updated_at=excluded.updated_at""",
            (link_id, canonical_ingredient_id, inventory_product_id, inventory_product_name, domain, now, now),
        )
        row = db.execute(
            "SELECT * FROM canonical_ingredient_inventory_links WHERE inventory_product_id=?",
            (inventory_product_id,),
        ).fetchone()
        return dict(row)


def delete_ingredient_inventory_link(link_id: str) -> None:
    with connect() as db:
        db.execute("DELETE FROM canonical_ingredient_inventory_links WHERE id=?", (link_id,))


def list_mealie_ingredient_mappings(status: str | None = None) -> list[dict[str, Any]]:
    with connect() as db:
        if status:
            rows = db.execute(
                """SELECT m.*, c.name as canonical_ingredient_name
                   FROM mealie_ingredient_mappings m
                   LEFT JOIN canonical_ingredients c ON c.id = m.canonical_ingredient_id
                   WHERE m.status = ? ORDER BY m.mealie_ingredient_text""",
                (status,),
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT m.*, c.name as canonical_ingredient_name
                   FROM mealie_ingredient_mappings m
                   LEFT JOIN canonical_ingredients c ON c.id = m.canonical_ingredient_id
                   ORDER BY m.mealie_ingredient_text""",
            ).fetchall()
        return [dict(r) for r in rows]


def upsert_ingredient_mapping(
    mealie_ingredient_text: str,
    canonical_ingredient_id: str | None,
    status: str,
    confirmed_by: str = "",
) -> dict[str, Any]:
    with connect() as db:
        now = now_iso()
        db.execute(
            """INSERT INTO mealie_ingredient_mappings
               (mealie_ingredient_text, canonical_ingredient_id, status, confirmed_at, confirmed_by)
               VALUES (?,?,?,?,?)
               ON CONFLICT(mealie_ingredient_text) DO UPDATE SET
               canonical_ingredient_id=excluded.canonical_ingredient_id,
               status=excluded.status,
               confirmed_at=excluded.confirmed_at,
               confirmed_by=excluded.confirmed_by""",
            (mealie_ingredient_text, canonical_ingredient_id, status,
             now if status == "confirmed" else "", confirmed_by),
        )
        row = db.execute(
            "SELECT * FROM mealie_ingredient_mappings WHERE mealie_ingredient_text=?",
            (mealie_ingredient_text,),
        ).fetchone()
        return dict(row)


def import_mealie_ingredients(mealie_ingredient_texts: list[str]) -> None:
    """Importe les textes d'ingrédients Mealie. Crée les entrées pending absentes,
    auto-suggère si le texte ≈ ingrédient canonique existant."""
    with connect() as db:
        _import_mealie_mappings(
            db, "mealie_ingredient_mappings", "mealie_ingredient_text",
            "canonical_ingredients", "canonical_ingredient_id", mealie_ingredient_texts,
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


def recipe_history(recipe_name: str, weeks: int = 12, limit: int = 50) -> list[dict[str, Any]]:
    """Historique détaillé d'un repas, avec contexte et accompagnements."""
    with connect() as db:
        rows = db.execute(
            """SELECT ms.id, ms.slot_date, ms.slot_kind, ms.recipe_name,
                      ms.context_id, mc.name as context_name
               FROM meal_slots ms
               LEFT JOIN meal_contexts mc ON mc.id = ms.context_id
               WHERE ms.recipe_name = ?
                 AND ms.slot_date >= date('now', ? || ' days')
                 AND ms.slot_kind IN ('recipe', 'hosting')
               ORDER BY ms.slot_date DESC
               LIMIT ?""",
            (recipe_name.strip(), f"-{weeks * 7}", limit),
        ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["sides"] = _get_sides_for_slot(db, item["id"])
            result.append(item)
        return result


def recipe_usage_stats() -> dict[str, dict[str, Any]]:
    """Nombre total de fois et dernière consommation par recette (nom), toutes périodes
    confondues (contrairement à recipe_frequency, qui se limite à une fenêtre récente)."""
    with connect() as db:
        rows = db.execute(
            "SELECT recipe_name, COUNT(*) as count, MAX(slot_date) as last_date "
            "FROM meal_slots WHERE slot_kind IN ('recipe', 'hosting') GROUP BY recipe_name"
        ).fetchall()
        return {r["recipe_name"]: {"count": r["count"], "last_date": r["last_date"]} for r in rows}


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
                 AND slot_kind IN ('recipe', 'hosting')
               GROUP BY recipe_name
               ORDER BY count DESC""",
            (f"-{weeks * 7}",),
        ).fetchall()
        return [dict(r) for r in rows]


def meal_context_stats(weeks: int = 12) -> dict[str, Any]:
    """Occurrences par contexte : chez qui on mange, qui on reçoit, restos."""
    with connect() as db:
        rows = db.execute(
            """SELECT ms.slot_kind as kind,
                      ms.context_id,
                      COALESCE(mc.name, ms.recipe_name) as name,
                      COUNT(*) as count,
                      MAX(ms.slot_date) as last_date
               FROM meal_slots ms
               LEFT JOIN meal_contexts mc ON mc.id = ms.context_id
               WHERE ms.slot_date >= date('now', ? || ' days')
                 AND ms.slot_kind IN ('away', 'hosting', 'restaurant')
               GROUP BY ms.slot_kind, ms.context_id, COALESCE(mc.name, ms.recipe_name)
               ORDER BY count DESC, name""",
            (f"-{weeks * 7}",),
        ).fetchall()
        summary = {"away": 0, "hosting": 0, "restaurant": 0}
        by_kind: dict[str, list[dict[str, Any]]] = {"away": [], "hosting": [], "restaurant": []}
        for row in rows:
            item = dict(row)
            kind = item["kind"]
            summary[kind] = summary.get(kind, 0) + item["count"]
            by_kind.setdefault(kind, []).append(item)
        return {"summary": summary, "by_kind": by_kind}


def side_frequency(weeks: int = 12) -> list[dict[str, Any]]:
    """Fréquence des accompagnements sur N semaines passées."""
    with connect() as db:
        rows = db.execute(
            """SELECT COALESCE(sd.name, ss.free_text) as name, ss.side_id as side_id,
                      COUNT(*) as count,
                      MAX(ms.slot_date) as last_date
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


def side_history(side_name: str, side_id: str | None = None, weeks: int = 12, limit: int = 50) -> list[dict[str, Any]]:
    """Historique détaillé d'un accompagnement, avec repas et contexte."""
    where_clause = "ss.side_id = ?" if side_id else "COALESCE(sd.name, ss.free_text) = ?"
    side_key = side_id if side_id else side_name.strip()
    with connect() as db:
        rows = db.execute(
            f"""SELECT ms.id, ms.slot_date, ms.slot_kind, ms.recipe_name,
                       ms.context_id, mc.name as context_name,
                       COALESCE(sd.name, ss.free_text) as side_name,
                       ss.side_id as side_id
                FROM meal_slot_sides ss
                JOIN meal_slots ms ON ms.id = ss.slot_id
                LEFT JOIN meal_contexts mc ON mc.id = ms.context_id
                LEFT JOIN sides sd ON sd.id = ss.side_id
                WHERE ms.slot_date >= date('now', ? || ' days')
                  AND ms.slot_kind IN ('recipe', 'hosting')
                  AND {where_clause}
                ORDER BY ms.slot_date DESC
                LIMIT ?""",
            (f"-{weeks * 7}", side_key, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def meal_side_associations(weeks: int = 12) -> list[dict[str, Any]]:
    """Associations fréquentes entre repas et accompagnements sur N semaines passées."""
    with connect() as db:
        rows = db.execute(
            """SELECT ms.recipe_name,
                      COALESCE(sd.name, ss.free_text) as side_name,
                      ss.side_id as side_id,
                      COUNT(*) as count,
                      MAX(ms.slot_date) as last_date
               FROM meal_slot_sides ss
               JOIN meal_slots ms ON ms.id = ss.slot_id
               LEFT JOIN sides sd ON sd.id = ss.side_id
               WHERE ms.slot_date >= date('now', ? || ' days')
                 AND ms.slot_kind IN ('recipe', 'hosting')
                 AND COALESCE(sd.name, ss.free_text) != ''
               GROUP BY ms.recipe_name, COALESCE(ss.side_id, ss.free_text), COALESCE(sd.name, ss.free_text)
               ORDER BY count DESC, ms.recipe_name, side_name""",
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


def enqueue_notification(actor_name: str, action: str, payload: dict[str, Any]) -> None:
    """Point d'entrée public pour enqueue un événement de notification hors du
    contexte d'une mutation de slot (ex. job de réconciliation d'inventaire)."""
    with connect() as db:
        _record_notification_event(db, actor_name, action, payload)
