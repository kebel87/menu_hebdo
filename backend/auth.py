from __future__ import annotations

import os
import secrets
import socket
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
        client_ip = request.client.host if request.client else ""
        if client_ip not in _trusted_proxy_ips():
            # Le port publié sur le LAN permettrait sinon à n'importe qui de
            # forger les en-têtes X-Forwarded-* et d'usurper une identité,
            # oauth2-proxy/PocketID inclus. Correctif porté depuis kb87_nexus
            # (2026-09-06/07).
            raise HTTPException(status_code=401, detail="Authentication required")
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


def _trusted_proxy_ips() -> set[str]:
    """Résout, à chaque appel, les IP actuelles des hôtes de confiance
    (TRUSTED_PROXY_HOSTS, défaut 'oauth2-proxy' — le nom de service Docker).
    Pas de cache : une résolution DNS interne coûte <1ms et reste correcte
    si le conteneur oauth2-proxy est recréé avec une IP différente."""
    hosts = [h.strip() for h in os.getenv("TRUSTED_PROXY_HOSTS", "oauth2-proxy").split(",") if h.strip()]
    ips: set[str] = set()
    for host in hosts:
        try:
            ips.add(socket.gethostbyname(host))
        except OSError:
            continue
    return ips


def require_backup_read_access(permission: str) -> Callable:
    """Accepte soit un humain avec la permission donnée, soit un appel
    machine-à-machine via X-Service-Key (FLEET_SERVICE_API_KEY) — pour
    l'agrégateur de santé fleet-wide de kb87_nexus."""

    def dependency(request: Request) -> Actor:
        expected = os.getenv("FLEET_SERVICE_API_KEY", "")
        provided = header(request, "X-Service-Key")
        if expected and provided and secrets.compare_digest(provided, expected):
            return Actor(subject="kb87-nexus-fleet", email="", name="kb87-nexus (fleet)", groups=[], roles=[], permissions=[])
        actor = current_actor(request)
        if permission not in actor.permissions:
            raise HTTPException(status_code=403, detail="Permission refusée")
        return actor

    return dependency
