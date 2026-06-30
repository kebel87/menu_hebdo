from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, List

from fastapi import Depends, HTTPException, Request

from .access_control import (
    load_access_control,
    permissions_for_roles,
    resolve_display_name,
    resolve_roles,
    split_groups,
)


@dataclass(frozen=True)
class Actor:
    subject: str
    email: str
    name: str
    groups: List[str]
    roles: list[str]
    permissions: list[str]

    def serialize(self) -> dict:
        return {
            "subject": self.subject,
            "email": self.email,
            "name": self.name,
            "groups": self.groups,
            "roles": self.roles,
            "permissions": self.permissions,
        }


def current_actor(request: Request) -> Actor:
    config = load_access_control()
    mode = os.getenv("AUTH_MODE", "development").lower()
    if mode == "development":
        identity = {
            "subject": os.getenv("LOCAL_AUTH_SUBJECT", "local-dev"),
            "email": os.getenv("LOCAL_AUTH_EMAIL", "local@example.test"),
            "name": os.getenv("LOCAL_AUTH_NAME", "Développement local"),
            "groups": split_groups(os.getenv("LOCAL_AUTH_GROUPS", "")),
        }
    elif mode == "proxy":
        proxy = config.get("proxy_headers", {})
        identity = {
            "subject": header(request, proxy.get("subject", "X-Forwarded-User")),
            "email": header(request, proxy.get("email", "X-Forwarded-Email")),
            "name": header(request, proxy.get("name", "X-Forwarded-Preferred-Username")),
            "groups": split_groups(header(request, proxy.get("groups", "X-Forwarded-Groups"))),
        }
        if not identity["subject"] and not identity["email"]:
            raise HTTPException(status_code=401, detail="Authentication required")
    else:
        raise HTTPException(status_code=500, detail="Invalid AUTH_MODE")

    roles = resolve_roles(identity["subject"], identity["email"], identity["groups"], config)
    permissions = permissions_for_roles(roles, config)
    display_name = resolve_display_name(
        identity["subject"],
        identity["email"],
        identity["name"],
        config,
    )
    return Actor(
        subject=identity["subject"],
        email=identity["email"],
        name=display_name,
        groups=identity["groups"],
        roles=sorted(roles),
        permissions=sorted(permissions),
    )


def require_permission(permission: str) -> Callable:
    def dependency(actor: Actor = Depends(current_actor)) -> Actor:
        if permission not in actor.permissions:
            raise HTTPException(status_code=403, detail="Permission refusée")
        return actor

    return dependency


def header(request: Request, name: str) -> str:
    return request.headers.get(name, "").strip()
