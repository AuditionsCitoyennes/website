# data-ingestion

Pipeline d'ingestion de jeux de données ouverts d'événements de participation
citoyenne (« objets de type audition »), affichés sur le site aux côtés des
données propres d'Auditions Citoyennes.

Tous les scripts sont sous licence AGPL-3.0-or-later (comme le reste du dépôt).

## Vue d'ensemble

```
data/                          (gitignoré, sauf sources.yml et DATA_LICENSES.md)
├── sources.yml                registre des sources : licence, attribution, pii_policy, publish
├── DATA_LICENSES.md           attributions pour le pied de page du site (généré — ne pas éditer)
├── raw/                       instantanés bruts + manifest.json (sha256, retrieved_at)
├── interim/                   fichiers intermédiaires (NDJSON, caches, rapports QA)
├── processed/
│   ├── auditions.parquet      exports fusionnés — sources publish: true, licences permissives
│   ├── auditions.geojson
│   └── by-source/<id>.geojson par source, y compris publish: false (affichage-avec-lien seulement)
└── nc-sa/participedia/        contenu CC BY-NC-SA — SÉGRÉGÉ, jamais fusionné
```

Schéma normalisé (une ligne par événement, validé par zod — `src/lib/schema.ts`) :
`source, source_id, title, description_text, start_at, end_at, address_raw,
street, postcode, city, country_code, lat, lng, geocode_precision
(housenumber|street|venue|municipality|unknown), url, license, attribution,
retrieved_at`.

## Rejouer le pipeline

Prérequis : Node ≥ 20, `npm install` à la racine du dépôt (workspace
`@ac/data-ingestion`). Toutes les commandes se lancent depuis `data-ingestion/`.

### 1. Grand Débat National (prioritaire — Licence Ouverte 2.0)

```bash
npm run download          # énumère les ressources via l'API data.gouv.fr
                          # (URLs statiques épinglées en secours), sha256 + manifest.
                          # Idempotent ; --force pour re-télécharger,
                          # --all pour inclure les 4 fichiers thématiques (gros, zipcode only)
npm run parse:gdn         # parseur tolérant (le JSON contient des lignes malformées) :
                          # events.ndjson (~10 457 objets, dédupliqués par id) +
                          # cr-ril.ndjson + rapport de schéma / clé de jointure
npm run scrub             # RGPD — OBLIGATOIRE avant toute sortie de data/raw/ :
                          # courriels + téléphones FR supprimés, authorId supprimé
                          # (export GDN_HMAC_SECRET=... pour garder un pseudonyme HMAC)
npm run geocode           # QA géocodage BAN (api-adresse.data.gouv.fr, ≤10 req/s) :
                          # geocode_precision depuis le type BAN, distance source↔BAN,
                          # >500 m ⇒ suspicion de centroïde communal.
                          # Cache disque ⇒ re-runs incrémentaux ; --offline pour rejouer
                          # sans réseau ; --limit N pour un échantillon ; --rps N (≤10)
npm run normalize         # exports parquet + geojson (voir arborescence ci-dessus)
npm run licenses          # régénère data/DATA_LICENSES.md depuis sources.yml
```

Ou tout enchaîner : `npm run pipeline:gdn`.

Rejouabilité hors-ligne : une fois `data/raw/` téléchargé et le cache géocodage
rempli, `parse:gdn`, `scrub`, `geocode --offline`, `normalize` et `licenses`
tournent sans aucun accès réseau. Aucun service tiers autre que data.gouv.fr,
la BAN et les API des instances listées dans `sources.yml` n'est contacté.

Décisions PII documentées (voir aussi `sources.yml`) :

- `authorId` est **supprimé** par défaut. Si une déduplication par auteur devient
  nécessaire, définir `GDN_HMAC_SECRET` : le scrubber écrit alors `author_ref`,
  un HMAC-SHA256 tronqué (pseudonymisation à clé, la clé reste hors dépôt).
- `authorZipCode` est **conservé** : granularité communale, déjà grossière,
  utile pour les agrégats géographiques — pas d'identification directe.
- Le scrubbing s'applique à tous les champs libres (dont les réponses des
  comptes-rendus), pas seulement à `body`.

### 2. Instances Decidim (licence PAR INSTANCE)

```bash
npm run harvest:decidim                          # toutes les instances de sources.yml
npm run harvest:decidim -- --source decidim-meta # une seule
npm run harvest:decidim -- --max 500             # plafonner (validation)
```

Le schéma GraphQL est introspecté d'abord (les versions Decidim diffèrent),
puis les réunions sont paginées 50 par 50 depuis `participatoryProcesses` et
`assemblies`. Règle stricte : chaque instance est enregistrée dans
`sources.yml` avec ses conditions de réutilisation ; `publish: false` par
défaut ⇒ affichage-avec-lien uniquement tant que la licence n'est pas
confirmée (mentions légales / portail open data).

### 3. Participedia (CC BY-NC-SA 3.0 — ségrégué)

L'export CSV est derrière un compte gratuit (Auth0) — **ne pas automatiser la
connexion**. Manuellement :

1. se connecter sur <https://participedia.net> ;
2. télécharger <https://participedia.net/search?selectedCategory=case&returns=csv>
   (idem pour methods/organizations si besoin) ;
3. déposer les fichiers dans `data/raw/participedia/` ;
4. `npm run parse:participedia` puis `npm run normalize`.

Le résultat vit sous `data/nc-sa/participedia/` et n'est **jamais** fusionné
dans les exports permissifs ; les sections du site qui l'affichent restent non
monétisées. Codebook des colonnes :
<https://participedia.net/docs/Participedia_Codebook_-_Case.pdf>.

### 4. OCDE (optionnel — citation et lien uniquement)

```bash
npm run check:oecd   # repère le lien tableur/Airtable courant sur la page OCDE
                     # et l'enregistre dans data/interim/oecd/links.json
```

Tant que les conditions de réutilisation ne sont pas confirmées : pas de
téléchargement, `publish: false`, citation + lien.

## Sources écartées — ne pas réintégrer naïvement

Voir la section `excluded` de `data/sources.yml` (rendue dans
`DATA_LICENSES.md`) : WVS/baromètres (redistribution des microdonnées
interdite), Ushahidi (autorisation par déploiement), cahiers de doléances
(CRPA + RGPD, autorisation écrite des Archives départementales requise).

## Tests

```bash
npm test          # vitest : parseur tolérant (ligne malformée), scrubber PII
                  # (courriels, formats +33/0X), schéma normalisé, fuseaux Paris
npm run typecheck
```
