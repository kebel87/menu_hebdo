from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any

from menu_app.store import list_push_subscriptions, connect

logger = logging.getLogger(__name__)

_VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
_VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "")
_VAPID_CLAIMS = {"sub": f"mailto:{os.getenv('VAPID_CONTACT_EMAIL', 'admin@kb87.net')}"}
_FLUSH_INTERVAL = int(os.getenv("NOTIFICATION_FLUSH_INTERVAL", "30"))

_worker_thread: threading.Thread | None = None


def start_notification_worker() -> None:
    global _worker_thread
    if not _VAPID_PRIVATE_KEY:
        return
    _worker_thread = threading.Thread(target=_worker_loop, daemon=True)
    _worker_thread.start()


def _worker_loop() -> None:
    while True:
        time.sleep(_FLUSH_INTERVAL)
        try:
            flush_notifications()
        except Exception:
            logger.warning("Échec de l'envoi des notifications push", exc_info=True)


def flush_notifications(force: bool = False) -> dict[str, Any]:
    if not _VAPID_PRIVATE_KEY:
        return {"sent": 0, "errors": 0, "skipped": "vapid_not_configured"}

    from pywebpush import webpush, WebPushException  # type: ignore

    with connect() as db:
        rows = db.execute(
            "SELECT * FROM notification_events WHERE status='pending' ORDER BY created_at LIMIT 50"
        ).fetchall()
        if not rows:
            return {"sent": 0, "errors": 0}

        subscriptions = list_push_subscriptions()
        sent = 0
        errors = 0

        for event_row in rows:
            actor_name = event_row["actor_name"]
            payload = json.loads(event_row["event_json"])
            message = _build_message(event_row["dedupe_key"].split(":")[0], actor_name, payload)
            delivery: dict[str, str] = {}

            for sub in subscriptions:
                if sub["actor_name"] == actor_name:
                    continue
                sub_data = json.loads(sub["subscription_json"])
                try:
                    webpush(
                        subscription_info=sub_data,
                        data=json.dumps(message),
                        vapid_private_key=_VAPID_PRIVATE_KEY,
                        vapid_claims=_VAPID_CLAIMS,
                    )
                    delivery[sub["endpoint"][:40]] = "ok"
                    sent += 1
                except WebPushException as e:
                    status = e.response.status_code if e.response else 0
                    delivery[sub["endpoint"][:40]] = str(status)
                    if status in (404, 410):
                        db.execute(
                            "DELETE FROM push_subscriptions WHERE endpoint=?", (sub["endpoint"],)
                        )
                    errors += 1

            now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
            db.execute(
                """UPDATE notification_events
                   SET status='sent', sent_at=?, delivery_results_json=?, updated_at=?
                   WHERE id=?""",
                (now, json.dumps(delivery), now, event_row["id"]),
            )

        return {"sent": sent, "errors": errors}


def _build_message(action: str, actor_name: str, payload: dict) -> dict:
    slot_date = payload.get("slot_date", "")
    recipe_name = payload.get("recipe_name", "")

    if action == "menu.slot.assigned":
        body = f"{actor_name} a planifié {recipe_name} pour le {_fmt_date(slot_date)}"
    elif action == "menu.slot.changed":
        body = f"{actor_name} a modifié le menu du {_fmt_date(slot_date)} — {recipe_name}"
    elif action == "menu.slot.cleared":
        body = f"{actor_name} a retiré {recipe_name} du {_fmt_date(slot_date)}"
    elif action == "menu.slot.swapped":
        body = (
            f"{actor_name} a échangé {payload.get('recipe_a','')} ({_fmt_date(payload.get('date_a',''))})"
            f" avec {payload.get('recipe_b','')} ({_fmt_date(payload.get('date_b',''))})"
        )
    else:
        body = f"{actor_name} a modifié le menu"

    return {"title": "Menus de la semaine", "body": body, "action": action}


def _fmt_date(iso_date: str) -> str:
    if not iso_date:
        return ""
    try:
        from datetime import date
        DAYS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
        d = date.fromisoformat(iso_date)
        return f"{DAYS_FR[d.weekday()]} {d.day}"
    except Exception:
        return iso_date


def get_vapid_public_key() -> str:
    return _VAPID_PUBLIC_KEY
