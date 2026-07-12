# menu_hebdo — CLAUDE.md

PWA familiale de planification des soupers de la semaine. Recettes importées de Mealie, présence des enfants via le calendrier familial, liens avec l'inventaire.

## Règle n°1 — iPhone d'abord
L'app est utilisée sur iPhone (PWA installée). Toute UI se valide sur viewport mobile en premier : touch/drag-and-drop, tailles de cartes et modales, comportement à la fermeture. Le desktop est secondaire.

## Stack
- Backend : FastAPI (`backend/`, entrée `backend/main.py`), SQLite dans `data/menu.db`
- Frontend : React/Vite/TypeScript (`frontend/`), buildé dans `frontend/dist`, servi par le backend
- Auth : oauth2-proxy (port hôte 4191) + PocketID (`auth.kb87.net`) devant le backend (port interne 8000, hôte 8091)
- Notifications : web push VAPID (`pywebpush`)
- Backup : `scripts/backup_menu.py` → rclone `gdrive-crypt:`

## Intégrations (voir compose.yaml)
- Mealie : `https://mealie.kb87.net`, `MEALIE_API_KEY`
- Inventaire familial : `http://inventaire-familial:8000` avec `SERVICE_API_KEY` (clé service-to-service **partagée** avec le projet inventaire_familial — même valeur des deux côtés, dans les `.env`)
- Calendrier familial : `https://calendrier.kb87.net`, `CALENDAR_API_TOKEN`

## Dev local (Mac)
- ⚠️ Python : **`/opt/homebrew/bin/python3.12 -m venv .venv`** — jamais le python3 système (3.9) : FastAPI/Pydantic plantent au runtime sur la syntaxe `str | None`
- Backend : `.venv/bin/uvicorn backend.main:app --reload`
- Frontend : `cd frontend && npm run dev` (build : `npm run build`)
- Alternative sans venv : tester dans le conteneur prod via `docker exec` (code copié dans `/tmp` du conteneur)

## Déploiement
1. Commit + push sur `main` → GitHub Actions (`publish-ghcr.yml`) publie `ghcr.io/kebel87/menu_hebdo:latest`
2. Attendre la fin du build GH Actions avant de redéployer
3. Redéployer : `~/.claude/tools/komodo.sh deploy menu_hebdo` (stack sur **docker2** — 10.87.0.164)
4. Vérifier : `curl -sk -o /dev/null -w "%{http_code}" https://menu.kb87.net` (302 vers auth = OK)

## Gotchas connus (déjà vécus)
- oauth2-proxy : garder `OAUTH2_PROXY_HTTP_ADDRESS: "0.0.0.0:4180"` (sinon Bad Gateway silencieux)
- PocketID : si « You're not allowed to use this service » → configurer "Allowed Users" du client OIDC dans l'UI PocketID
- Les routes PWA (`manifest.webmanifest`, `sw.js`, `icons/`) bypassent l'auth via `OAUTH2_PROXY_SKIP_AUTH_ROUTES`
- Secrets : `.env` local (jamais commité) ; les valeurs sont aussi dans HashiVault/1Password

## Mémoire homelab
Contexte infra global : `~/.claude/global-memory/` (carte : `shared/reference_infra_map.md`, diagnostic pannes : skill `homelab-diagnose`).
