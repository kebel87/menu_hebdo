# Sonde de disponibilité DNS

`GET /api/ready` répond `200 {"status":"ok"}` si les tables essentielles de la base SQLite locale sont lisibles, sinon `503 {"status":"unavailable"}`. Calendrier vérifie également le chargement de ses trois fichiers YAML essentiels. Les réponses portent `Cache-Control: no-store` et ne contiennent ni données métier ni détails d’erreur.

La connexion SQLite utilise `mode=ro` et un délai d’attente de verrou de 1 seconde. La sonde ne crée pas de base, ne lance pas de migrations et ne contacte pas les intégrations externes. Elle ne garantit pas la disponibilité en écriture, la santé complète du stockage, le fonctionnement du navigateur ou celui de PocketID.

L’exception oauth2-proxy est limitée à `GET=^/api/ready$`, ajoutée aux exceptions existantes. Les autres méthodes et chemins ne bénéficient pas de cette exception. `/api/health` conserve son contrat existant.

Configurer l’APP Technitium Failover avec le profil HTTPS et `healthCheckUrl=https://<domaine>/api/ready`, uniquement après avoir validé l’endpoint en TLS strict via chaque adresse primaire/secondaire et depuis les deux DNS. Conserver initialement les adresses et TTL existants. Le `serverDown` configuré vers le VPS demeure un dernier recours non validé par la santé.

Vérification locale : `pip install -r requirements-test.txt` puis `python -m unittest discover -s tests -p test_health.py`. Les cas manquants/corrompus/verrouillés sont testés sur des bases temporaires, jamais sur la production. Vérifier également les routes métier sans session via les deux reverse proxies après déploiement.

Retour arrière : restaurer l’URL APP précédente avant de retirer la route et son exception. Les essais de panne de production nécessitent une fenêtre convenue; aucune panne ne doit être provoquée sur la base réelle pour tester cette sonde.
