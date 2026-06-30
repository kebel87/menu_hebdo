# Handoff — Projet menu_hebdo

## Contexte

Nouvelle application de planification de menus hebdomadaires pour la famille.
App distincte de `inventaire_familial` mais visuellement et techniquement identique.

**GitHub repo :** `kebel87/menu_hebdo`  
**URL cible :** à confirmer (ex. `menus.kb87.net`)  
**Port local :** 8091 (inventaire tourne sur 8090)

---

## Objectif

Application qui aide Amélie et Kevin à bâtir les menus de la semaine (repas du soir,
lun–dim), en tenant compte de :
- Ce qui est disponible dans l'inventaire (congélateur + réserves)
- Ce qui a été mangé récemment (éviter la répétition)
- Les rabais à l'épicerie cette semaine
- Si le repas fait des lunchs pour le lendemain
- Si le repas est plutôt week-end ou semaine
- Les imprévus / changements de dernière minute

---

## Stack — identique à inventaire_familial

### Backend
```
fastapi==0.115.6
uvicorn[standard]==0.32.1
```
Pas de pywebpush (pas de push notifications dans ce projet pour l'instant).

Architecture :
```
menu_hebdo/
├── backend/
│   └── main.py          # FastAPI app, routes
├── src/
│   └── menu_app/
│       └── store.py     # SQLite, connect(), initialize_database()
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       └── styles.css
├── data/                # SQLite DB (gitignored)
├── requirements.txt
├── Dockerfile
└── compose.yaml
```

### Frontend — package.json
```json
{
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "tsc && vite build",
    "preview": "vite preview --host 0.0.0.0"
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "lucide-react": "latest",
    "react": "latest",
    "react-dom": "latest",
    "recharts": "^3.9.0",
    "typescript": "latest",
    "vite": "latest"
  },
  "devDependencies": {
    "@types/react": "^19.2.15",
    "@types/react-dom": "^19.2.3"
  }
}
```
Pas de `@zxing/library` (pas de scanner code-barre dans cette app).

### vite.config.ts
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8001"
    }
  }
});
```

### tsconfig.json — copie exacte de inventaire_familial
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2020"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

---

## Style — copier exactement depuis inventaire_familial

Le fichier `styles.css` du menu_hebdo commence avec les mêmes variables CSS :

```css
:root {
  --ink: #242826;
  --muted: #68716c;
  --line: #d2d8d3;
  --panel: #ffffff;
  --bg: #f7f8f6;
  --fg: var(--ink);
  --green: #1f5f73;
  --green-soft: #e6f1f4;
  --secondary: #e16f5c;
  --amber: #e16f5c;
  --red: #9f3b33;
  --app-bg: #f7f8f6;
}
```

Composants à réutiliser tels quels (copier le CSS depuis inventaire_familial) :
- `.app-shell`, `.topbar`, `.title-block`
- `.segmented` (nav principale)
- `.nav-more-wrap`, `.nav-more-btn`, `.nav-more-dropdown` (overflow mobile)
- `.edit-panel`, `.modal-backdrop`, `.form-actions`
- `.error-banner`
- Toute la section `@media (max-width: 760px)`
- Variables dark mode si applicable

Icônes : `lucide-react` (même lib, mêmes conventions).

---

## Intégrations externes

### 1. Mealie (recettes)
- **URL :** à confirmer par l'utilisateur
- **Auth :** API key dans variable d'environnement `MEALIE_API_KEY`
- **Endpoints utilisés :**
  - `GET /api/recipes?perPage=1000` — liste toutes les recettes
  - `GET /api/recipes/{slug}` — détail d'une recette (ingrédients)
  - `GET /api/categories` — catégories de recettes
  - `GET /api/tags` — tags (on utilisera les tags pour "weekend", "fait-lunchs", etc.)
- Les recettes Mealie sont en **lecture seule** depuis menu_hebdo.
- Cache local 1h recommandé (les recettes changent rarement).

### 2. Inventaire familial (stock disponible)
- **URL :** `INVENTAIRE_API_URL` (ex. `http://inventaire-familial:8000` en prod)
- **Endpoints utilisés :**
  - `GET /api/items?domain=frozen` — stock congélateur
  - `GET /api/items?domain=household` — réserves
- Lecture seule. Pas d'écriture vers l'inventaire depuis menu_hebdo.
- Utilisé pour calculer le "score inventaire" de chaque recette.

---

## Modèle de données SQLite

### Pattern store.py — identique à inventaire_familial

```python
from contextlib import contextmanager
import sqlite3
from pathlib import Path
import os
from datetime import datetime, timezone

DATA_DIR = Path(os.getenv("MENU_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
DB_PATH = DATA_DIR / "menu.db"

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

@contextmanager
def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
```

### Tables

```sql
-- Semaines planifiées
CREATE TABLE meal_plans (
    id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL UNIQUE,  -- ISO date lundi (ex. "2026-06-30")
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Slots de repas (un par soir)
CREATE TABLE meal_slots (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
    slot_date TEXT NOT NULL,          -- ISO date (ex. "2026-06-30")
    recipe_source TEXT NOT NULL,      -- "mealie" | "local" | "free"
    mealie_slug TEXT,                 -- null si source != "mealie"
    local_recipe_id TEXT,             -- null si source != "local"
    free_text TEXT,                   -- null si source != "free" (repas sans recette)
    recipe_name TEXT NOT NULL,        -- nom affiché (dénormalisé pour perf)
    makes_lunch INTEGER NOT NULL DEFAULT 0,  -- 1 = fait des lunchs lendemain
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Recettes simples locales (sans Mealie)
-- Ex: Hamburgers, Hot-dogs, Grilled-cheese
CREATE TABLE local_recipes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    -- [{"name": "Steak haché", "quantity": 500, "unit": "g"}, ...]
    is_weekend INTEGER NOT NULL DEFAULT 0,
    makes_lunch INTEGER NOT NULL DEFAULT 0,
    prep_minutes INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Métadonnées locales sur les recettes Mealie
-- (préférences famille, ne pas modifier dans Mealie)
CREATE TABLE recipe_meta (
    mealie_slug TEXT PRIMARY KEY,
    is_weekend INTEGER NOT NULL DEFAULT 0,
    makes_lunch INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

-- Spéciaux épicerie de la semaine (saisis manuellement)
CREATE TABLE weekly_specials (
    id TEXT PRIMARY KEY,
    week_start TEXT NOT NULL,         -- ISO date lundi
    item_name TEXT NOT NULL,          -- ex. "Poulet entier"
    detail TEXT NOT NULL DEFAULT '',  -- ex. "3.99$/kg chez IGA"
    created_at TEXT NOT NULL
);
```

---

## Architecture des 3 écrans

### Écran 1 — Semaine (vue principale)

Grille lun–dim. Chaque soir = une carte avec :
- Nom du repas
- Badge inventaire : ✅ tout disponible / ⚠️ manque X / 🔴 plusieurs manquants
- Badge "L" (fait des lunchs)
- Badge "il y a 3 sem." (dernière fois que ce repas a été planifié)
- Mode weekend visuel distinct (couleur ou fond)
- Actions : assigner un repas, vider le slot, swapper (ouverture du picker)

Comportement du swap/imprévus :
- Clic sur un slot → ouvre le picker de recettes
- Le picker filtre par défaut sur "disponible maintenant" + "pas fait récemment"
- Tri : score inventaire desc, puis date dernière préparation asc

### Écran 2 — Recettes (picker + catalogue)

Recherche unifiée sur Mealie + recettes locales (même input, même liste).

Chaque recette affiche :
- Nom + source (icône Mealie ou local)
- Score inventaire (% d'ingrédients présents en stock)
- Dernière planification ("il y a X sem." ou "jamais")
- Badges : Weekend / Lunchs / Rapide (<30 min)

Filtres rapides :
- "Disponible maintenant" (score inventaire ≥ 80%)
- "Pas fait depuis 3 sem+"
- "Fait des lunchs"
- "Week-end" / "Semaine"

Action sur une recette : voir les ingrédients, voir l'historique de planification,
modifier les flags (weekend/lunchs) sans toucher à Mealie.

### Écran 3 — Historique + Stats

- Liste des semaines passées avec les 7 repas
- Stats par recette : fréquence, dernière date, nb de fois planifiée
- Recettes jamais planifiées
- Fréquence par catégorie sur 4/8/12 semaines
- Vue calendrier optionnelle

---

## Calcul du score inventaire

Pour chaque recette (Mealie ou locale), on compare la liste d'ingrédients
avec l'inventaire disponible. Matching par nom (insensible à la casse, trim).

```python
def inventory_score(ingredients: list[dict], inventory_items: list[dict]) -> dict:
    """
    Retourne {
      "score": 0.85,          # ratio ingrédients trouvés
      "missing": ["Riz basmati", "Crème 35%"],
      "available": ["Poulet", "Oignon", ...]
    }
    """
    inventory_names = {item["name"].lower().strip() for item in inventory_items}
    found = []
    missing = []
    for ing in ingredients:
        name = ing.get("name", "").lower().strip()
        if any(name in inv_name or inv_name in name for inv_name in inventory_names):
            found.append(ing["name"])
        else:
            missing.append(ing["name"])
    total = len(ingredients)
    return {
        "score": len(found) / total if total > 0 else 1.0,
        "missing": missing,
        "available": found,
    }
```

Ce calcul se fait côté backend à chaque appel de `/api/recipes` (avec cache inventaire).

---

## Authentification

Même pattern qu'inventaire_familial : **oauth2-proxy** devant le backend.
Variables d'environnement dans `compose.yaml` :
```yaml
OAUTH2_PROXY_REDIRECT_URL: "https://menus.kb87.net/oauth2/callback"
OAUTH2_PROXY_COOKIE_NAME: "_oauth2_proxy_menus"
```
Le backend lit le header `X-Forwarded-User` / `X-Auth-Request-User` pour
identifier l'utilisateur (même pattern qu'inventaire_familial `backend/auth.py`).

---

## Dockerfile — identique à inventaire_familial

```dockerfile
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json frontend/tsconfig.json \
     frontend/tsconfig.node.json frontend/vite.config.ts ./
COPY frontend/index.html ./index.html
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm ci
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONPATH=/app/src
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY src ./src
COPY data ./data
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## Questions ouvertes à confirmer avec l'utilisateur

1. **URL Mealie** et méthode d'auth (API key dans header `Authorization: Bearer <key>`)
2. **URL inventaire_familial API** en production (ex. `http://inventaire-familial:8000`)
3. **URL finale** du menu_hebdo (sous-domaine `menus.kb87.net` ?)
4. **Tags Mealie** : utiliser les tags existants pour "weekend"/"fait-lunchs" ou
   stocker uniquement dans `recipe_meta` local ? Recommandation : local seulement,
   pour ne pas polluer Mealie avec des tags applicatifs.

---

## Ordre de développement recommandé

1. Scaffolding du projet (structure dossiers, package.json, vite.config, requirements)
2. Backend : `store.py` avec `connect()` + `initialize_database()` + toutes les tables
3. Backend : routes CRUD pour `meal_plans` + `meal_slots` + `local_recipes`
4. Backend : proxy Mealie (fetch recettes, cache 1h en mémoire)
5. Backend : proxy inventaire + calcul score inventaire
6. Frontend : squelette (topbar + nav segmented + styles copiés)
7. Frontend : écran Semaine (grille + cartes)
8. Frontend : écran Recettes (picker + filtres)
9. Frontend : écran Historique + stats
10. Docker + compose.yaml + déploiement

---

## Décisions d'architecture prises

- **Pas de Mealie meal planner** : toute la planification est dans menu_hebdo
- **Deux sources de recettes** : Mealie (slug) + local (id) + free-text — traitement
  unifié dans le frontend, source transparente pour l'utilisateur
- **Lecture seule** vers Mealie et inventaire — aucune écriture vers ces apps
- **Score inventaire** calculé côté backend à chaque requête (avec cache inventaire
  rafraîchi toutes les 5 minutes)
- **Métadonnées famille** (weekend, lunchs, fréquence) stockées localement dans
  `recipe_meta`, jamais dans Mealie
- **Historique** = les `meal_slots` passés, pas de table séparée
- **Style** = copie exacte des variables CSS et composants de inventaire_familial
