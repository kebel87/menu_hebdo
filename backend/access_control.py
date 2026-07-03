from __future__ import annotations

from pathlib import Path
from typing import List, Set

from menu_app.simple_yaml import load_yaml

ROOT = Path(__file__).resolve().parents[1]
ACCESS_CONTROL_PATH = ROOT / "data" / "access-control.yaml"


def load_access_control() -> dict:
    return load_yaml(ACCESS_CONTROL_PATH)


def resolve_roles(subject: str, email: str, groups: List[str], config: dict) -> Set[str]:
    roles: Set[str] = set(config.get("defaults", {}).get("roles", []))
    for user in config.get("users", []):
        if user.get("subject") == subject or (
            email and user.get("email", "").lower() == email.lower()
        ):
            roles.update(user.get("roles", []))
    identity_groups = set(groups)
    for group in config.get("groups", []):
        if group.get("id") in identity_groups:
            roles.update(group.get("roles", []))
    return roles


def roles_for_display_name(display_name: str, config: dict) -> Set[str]:
    """Variante de resolve_roles qui matche sur le nom d'affichage plutôt que
    sujet/email — utile pour cibler les abonnés push par rôle, puisque
    push_subscriptions ne stocke que actor_name (= Actor.name =
    resolve_display_name(...)). Résolu à la volée (config non caché) pour
    qu'un changement de rôle soit reflété immédiatement, sans attendre un
    nouvel abonnement push."""
    roles: Set[str] = set(config.get("defaults", {}).get("roles", []))
    for user in config.get("users", []):
        if user.get("display_name") == display_name:
            roles.update(user.get("roles", []))
    return roles


def resolve_display_name(subject: str, email: str, fallback: str, config: dict) -> str:
    for user in config.get("users", []):
        if user.get("subject") == subject or (
            email and user.get("email", "").lower() == email.lower()
        ):
            return str(user.get("display_name") or fallback or email or subject)
    return fallback or email or subject


def permissions_for_roles(roles: Set[str], config: dict) -> Set[str]:
    permissions: Set[str] = set()
    configured_roles = config.get("roles", {})
    for role in roles:
        permissions.update(configured_roles.get(role, {}).get("permissions", []))
    return permissions


def split_groups(value: str) -> List[str]:
    return sorted({group.strip() for group in value.split(",") if group.strip()})
