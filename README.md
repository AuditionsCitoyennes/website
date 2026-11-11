# Auditions Citoyennes

> Open-source civic-tech platform for collecting, verifying and mapping citizens' testimonies.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![CI](https://github.com/AuditionsCitoyennes/website/actions/workflows/ci.yml/badge.svg)](https://github.com/AuditionsCitoyennes/website/actions/workflows/ci.yml)
[![DCO](https://img.shields.io/badge/DCO-required-brightgreen.svg)](CONTRIBUTING.md#sign-off-dco)

Plateforme d'auditions citoyennes pour la démocratie participative — réécriture sur **Vue 3 + Fastify**, en conservant Supabase.

## Stack

- **Frontend** — Vue 3 + Vite (SPA), vue-router, Pinia, TanStack Query, Mapbox GL (carte), CSS écrit à la main (pas de framework CSS).
- **Backend** — Fastify (TypeScript). Vérifie le JWT Supabase et fait office de couche API + logique métier (analyse IA Claude, emails Resend, gestion des inscriptions).
- **Supabase** — Postgres + Auth + RLS. L'auth (email/mot de passe, Google OAuth, vérification email, reset) se fait directement côté client via `supabase-js`.

## Structure (monorepo npm workspaces)

```
apps/web          Vue 3 + Vite SPA
apps/api          Fastify API
packages/shared   Types TS + schémas Zod partagés
supabase/         Migrations + config (référence du schéma)
```

### Le code du site (`apps/web/src`)

Une organisation par fonctionnalité, décidée dans [docs/architecture-proposal-2026-10-20.md](docs/architecture-proposal-2026-10-20.md) :

```
main.ts, App.vue   démarrage et coquille
app/               ce qui n'existe qu'une fois : routeur, en-tête, popups globales, réglages vue-query
shared/            ce qui ne connaît aucune fonctionnalité : système de design (ui/), client API,
                   dates, rendu d'un témoignage, feuilles de style
features/<nom>/    une fonctionnalité par dossier, exposée par son index.ts (le « barrel »)
```

Les fonctionnalités s'empilent dans un seul sens, et ESLint le fait respecter
(`eslint.config.js`, règle `no-restricted-imports`) :

```
geo  →  map  →  analyses  →  geo-nav  →  temoignages  →  map-stage  →  app
```

`geo` est le modèle géographique pur ; `map` la carte Mapbox et ses couches WebGL ; `analyses` ce
que l'association a entendu, posé sur les dalles ; `geo-nav` l'exploration (panneau, fil d'Ariane,
caméra) ; `temoignages` la page et ses filtres ; `map-stage` l'unique instance de carte partagée
entre la carte d'accueil et la page. À côté : `filters`, `auth`, `testify` (témoigner, vérifier),
`audition`, `home`, `admin`, `outbox`.

Une fonctionnalité importe `shared/`, les barrels des fonctionnalités sous elle, et ses propres
fichiers en chemin relatif. Quelques entrées secondaires existent pour ne pas tirer des composants
dans un autre lot : `@/features/map/lib`, `map/types`, `map/events`, `@/features/auth/account`.
Rien n'importe `app/`, sauf `main.ts`. L'état chaud de la carte (instance Mapbox, couches, tampons
par image) reste hors de la réactivité Vue, exposé par des accesseurs.

### L'API (`apps/api/src`)

```
lib/               l'infrastructure partagée : clients Supabase, auth, caches, limites, e-mails
modules/<ressource>/   routes.ts (HTTP) + service.ts (les règles, contre un client passé en argument)
```

## Démarrage

```sh
npm install
cp apps/api/.env.example apps/api/.env   # puis remplir les variables
cp apps/web/.env.example apps/web/.env
npm run dev      # lance l'API (3000) et le web (5173)
```

### Base de données locale

Le développement se fait sur une base Supabase locale (Docker), jamais sur la production.

```sh
npm run db:start      # démarre Supabase en local (Docker Desktop doit tourner)
npm run db:reset      # repart d'une base vide : migrations + données fictives
npm run db:accounts   # crée les comptes de test (mot de passe affiché une fois)
npm run dev:local     # API + web branchés sur la base locale, sans IA ; les emails vont dans la boîte de test
npm run db:stop
```

`supabase/migrations/` part d'un état de référence de la production (`…_baseline.sql`, 21/10/2026) : la structure seule, jamais de données.

Les données locales et de staging sont **fictives** et propres à Auditions Citoyennes, générées par `scripts/seed/` dans `supabase/seed.sql` (non versionné) : textes inventés, adresses `@example.org`, aucun jeu de données importé. Toujours les mêmes pour un profil donné. Le script refuse de se charger dans une base qui contient des auditions qu'il n'a pas écrites (la production, par exemple) ; rechargé sur ses propres données, il les remplace :

| `SEED_PROFILE` | Contenu |
|---|---|
| `france` (défaut) | ~65 auditions et ~300 témoignages à la forme du corpus réel actuel (surtout Villeurbanne, Lyon, Bron, La Tour-du-Pin, quelques villes et villages ailleurs), brouillons, auditions en ligne, et des cas limites (emoji, HTML, texte très long, homonymes, outre-mer). Chaque audition en présentiel se tient dans une rue ou sur une place, sauf trois cas limites sans point sur la carte ; les 5 écrites comme le faisait l'ancienne application sont chargées sans position sur la carte, puis placées à l'adresse de leur lieu par la tâche de placement de l'API |
| `world` | Chaque pays sauf la France : plusieurs villes, 2–3 auditions de 3–4 témoignages, en partie dans la langue locale |
| `all` | Les deux |
| `france-abroad` | Le profil `france`, plus ~500 témoignages placés sur la carte dans 26 pays : deux à trois lieux publics réels par ville (51 villes), en partie dans la langue locale |

**Staging** tourne sur ces mêmes données fictives (profil `france`). Il peut aussi être chargé avec le profil `france-abroad` : mettre `france-abroad` à la place de `france` dans les commandes ci-dessous (dans le nom du fichier aussi). Les témoignages à l'étranger ne sont sur la carte qu'avec la source « Serveur » (celle de staging par défaut) ; sous « Données », ils n'y sont pas. Si seule la France apparaît, ouvrir la fenêtre DEV et réinitialiser les choix. Chaque audition en présentiel y est à une adresse précise (une rue ou une place), sauf trois cas limites volontairement sans point sur la carte : « Saint-Denis » (communes homonymes), « Ribiers » (commune déléguée) et « France » (lieu général) ; avec `france-abroad`, les auditions à l'étranger sont placées dans une ville (`locality`), à l'un de ses lieux publics. Pour recharger sa base après un changement de `scripts/seed/` (réservé aux mainteneurs qui ont accès au projet de staging ; jamais un agent ni un script), depuis une copie à jour de `dev` : vérifier d'abord que le dossier `supabase/migrations/` du dossier staging est identique à celui de cette copie (le recopier au besoin), puis lancer les commandes ci-dessous. Le dry run ne doit annoncer que le fichier de seed (« Would seed these files ») ; s'il annonce aussi une migration (« Would push these migrations »), s'arrêter et la pousser d'abord selon `scripts/place-backfill/README.md` (staging d'abord).

```sh
SEED_PROFILE=france npm run db:seed                       # écrit supabase/seed.sql
H=$(shasum supabase/seed.sql | cut -c1-8)
cp supabase/seed.sql <dossier staging>/supabase/seed-france-$H.sql
sed -i '' "s#^sql_paths = .*#sql_paths = [\"./seed-france-$H.sql\"]#" <dossier staging>/supabase/config.toml
supabase db push --workdir <dossier staging> --include-seed --dry-run   # n'annonce que ce fichier de seed, sinon s'arrêter
supabase db push --workdir <dossier staging> --include-seed
```

`<dossier staging>` est le dossier lié au projet de staging, celui des migrations (`scripts/place-backfill/README.md`) ; jamais la copie principale du dépôt, liée à la production. Le fichier porte un nom tiré de son contenu parce que `db push --include-seed` ne rejoue pas un seed déjà appliqué sous le même nom (il n'en met à jour que l'empreinte : « hash update »). Le script refuse une base qui n'a jamais reçu ces données fictives (la production) ; sur staging, qui les a déjà reçues, il remplace TOUT : toutes les auditions, tous les témoignages et dépôts en ligne, y compris ceux créés à la main (les comptes restent). Le site de staging montre les nouvelles données sous un quart d'heure (caches de l'API).

Pour lister, en lecture seule, les auditions qui ne sont pas à une adresse (staging ou production) : éditeur SQL du tableau de bord Supabase,

```sql
select id, location, audition_en_ligne, status, place_precision, place_stale
  from public.auditions
 where place_precision is distinct from 'address'
 order by audition_en_ligne, place_precision nulls first, location;
```

ou avec la clé publique (auditions publiées seulement ; en ligne, une fois un témoignage vérifié) :

```sh
curl -s "$SUPABASE_URL/rest/v1/auditions?select=id,location,audition_en_ligne,status,place_precision,place_stale&or=(place_precision.is.null,place_precision.neq.address)&order=audition_en_ligne.asc,location.asc" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY"
```

`place_precision` vide = jamais placée (la tâche de placement de l'API s'en charge, sous une dizaine de minutes sur staging) ; `commune` = au centre de la commune ; `locality` = placée dans une ville à l'étranger, à l'un de ses lieux publics ; `unplaced` = sans point sur la carte. Juste après un rechargement, staging en liste 8 (les trois cas limites et les 5 jamais placées), puis 3. Avec `france-abroad`, la requête liste aussi chaque audition à l'étranger (`locality`) : 143 de plus.

Comptes de test (`npm run db:accounts`) : `superadmin@example.org`, `admin@example.org`, `inscription@example.org` (inscription en attente), `non-confirme@example.org`. Sur staging : `SUPABASE_PROJECT_REF=<ref> SEED_PASSWORD=… npm run db:accounts` (la clé est lue via la CLI Supabase connectée). Le script refuse de s'exécuter sur la production.

Studio : http://127.0.0.1:54323.

**Emails de test.** En local et sur staging, aucun email ne part : l'API les garde (table `captured_emails`) et le site les affiche via le bouton « Emails de test », en bas à gauche, liens cliquables. Chaque testeur y retrouve d'abord les siens (« Les miens » : ce que ses actions ont envoyé, même à une adresse inventée), et ceux de tous (« Tous »). Les emails de Supabase Auth (confirmation d'inscription, mot de passe oublié…) y arrivent aussi, par le *Send Email hook* d'Auth, qui les confie à l'API (`/api/hooks/send-email`, configuré dans `supabase/config.toml`). Ils sont gardés 30 jours. La production refuse ce mode au démarrage, et un build de production n'en contient rien.

### Scripts

| Commande | Effet |
|---|---|
| `npm run dev` | API + web en parallèle |
| `npm run typecheck` | Vérification de types sur tous les workspaces |
| `npm run build` | Build web + API |

## Variables d'environnement

Côté **API** (`apps/api/.env`) — voir `apps/api/.env.example` :

| Variable | Usage |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Connexion Supabase (clé *publishable*, publique) |
| `SUPABASE_SERVICE_ROLE_KEY` | Opérations privilégiées (rôles, suppression de compte, emails) — **secret** |
| `ANTHROPIC_API_KEY` | Analyse thématique des témoignages (Claude) — **secret** |
| `RESEND_API_KEY` | Envoi des emails de vérification / inscription — **secret** |
| `APP_ENV` | `local`, `staging` ou `production` (défaut). Tout sauf `local` se comporte comme la production : aucun raccourci de développement |
| `EMAIL_MODE` / `EMAIL_REDIRECT_TO` / `EMAIL_ALLOWLIST` | `live` (défaut en production), `outbox` (rien n'est envoyé, tout va dans la boîte de test du site : local et staging ; refusé en production), `redirect` (les adresses de `EMAIL_ALLOWLIST` — adresses ou `@domaine` — reçoivent leurs emails, tous les autres partent vers `EMAIL_REDIRECT_TO`) ou `log` (rien n'est envoyé, seulement journalisé : défaut hors production) |
| `SEND_EMAIL_HOOK_SECRET` | Secret du *Send Email hook* de Supabase Auth (`v1,whsec_…`, page Auth Hooks du projet) : renseigné, l'API reçoit les emails d'Auth et les envoie comme les siens — **secret** |
| `LOG_LEVEL` | `info` par défaut ; les en-têtes d'authentification ne sont jamais journalisés |

L'API se déploie en conteneur (Node 24) : `docker build -f apps/api/Dockerfile -t auditions-api .` depuis la racine. **Staging** : à chaque merge dans `dev`, elle part sur Scaleway toute seule (`.github/workflows/deploy-staging.yml`, mise en place et clés : [`docs/staging.md`](docs/staging.md)). Le site de staging, https://staging.auditionscitoyennes.com, part sur Cloudflare de la même façon (`.github/workflows/deploy-staging-web.yml`), avec un aperçu par pull request. `npm run build --workspace=@ac/api` produit `apps/api/dist/index.js` ; un `SIGTERM` la fait s'arrêter proprement (les requêtes en cours se terminent).

Côté **web** (`apps/web/.env`) : `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_API_URL`, et `VITE_MAPBOX_TOKEN` (token public Mapbox — sans lui, les pages affichent un encart « Carte indisponible »). `VITE_APP_ENV=staging` au build de staging y ajoute les outils de test : la boîte « Emails de test » et les réglages DEV des analyses (toujours présents avec `npm run dev`, jamais dans un build de production).

> ⚠️ Ne committez **jamais** de vraies clés secrètes. Les fichiers `.env` sont ignorés par git ; seuls les `.env.example` (sans valeurs) sont versionnés.

## Contribuer

Les contributions sont les bienvenues ! Lisez le **[guide de contribution](CONTRIBUTING.md)** — en particulier le **[sign-off DCO](CONTRIBUTING.md#sign-off-dco)** obligatoire (`git commit -s`) — et le **[code de conduite](CODE_OF_CONDUCT.md)**.

- 🐛 Bug ou idée ? [Ouvrez une issue](https://github.com/AuditionsCitoyennes/website/issues/new/choose).
- 💬 Question ? [Discussions](https://github.com/AuditionsCitoyennes/website/discussions).
- 🔒 Faille de sécurité ? Voir [SECURITY.md](SECURITY.md) — **ne pas** ouvrir d'issue publique.

## Licence

Distribué sous licence **[GNU AGPL v3](LICENSE) ou toute version ultérieure** (`AGPL-3.0-or-later`), avec une permission additionnelle (section 7) qui autorise son utilisation avec Mapbox GL JS, la bibliothèque de carte, qui n'est pas libre : voir [NOTICE](NOTICE). En contribuant, vous acceptez que votre travail soit publié sous cette licence et cette permission (voir le DCO dans [CONTRIBUTING.md](CONTRIBUTING.md)).
