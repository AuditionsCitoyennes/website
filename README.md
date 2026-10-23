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
| `france` (défaut) | ~65 auditions et ~300 témoignages à la forme du corpus réel actuel (surtout Villeurbanne, Lyon, Bron, La Tour-du-Pin, quelques villes et villages ailleurs), brouillons, auditions en ligne, et des cas limites (emoji, HTML, texte très long, homonymes, outre-mer) |
| `world` | Chaque pays sauf la France : plusieurs villes, 2–3 auditions de 3–4 témoignages, en partie dans la langue locale |
| `all` | Les deux |

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

L'API se déploie en conteneur (Node 24) : `docker build -f apps/api/Dockerfile -t auditions-api .` depuis la racine. `npm run build --workspace=@ac/api` produit `apps/api/dist/index.js` ; un `SIGTERM` la fait s'arrêter proprement (les requêtes en cours se terminent).

Côté **web** (`apps/web/.env`) : `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_API_URL`, et `VITE_MAPBOX_TOKEN` (token public Mapbox — sans lui, les pages affichent un encart « Carte indisponible »). `VITE_APP_ENV=staging` au build de staging y ajoute la boîte « Emails de test » (toujours présente avec `npm run dev`, jamais dans un autre build).

> ⚠️ Ne committez **jamais** de vraies clés secrètes. Les fichiers `.env` sont ignorés par git ; seuls les `.env.example` (sans valeurs) sont versionnés.

## Contribuer

Les contributions sont les bienvenues ! Lisez le **[guide de contribution](CONTRIBUTING.md)** — en particulier le **[sign-off DCO](CONTRIBUTING.md#sign-off-dco)** obligatoire (`git commit -s`) — et le **[code de conduite](CODE_OF_CONDUCT.md)**.

- 🐛 Bug ou idée ? [Ouvrez une issue](https://github.com/AuditionsCitoyennes/website/issues/new/choose).
- 💬 Question ? [Discussions](https://github.com/AuditionsCitoyennes/website/discussions).
- 🔒 Faille de sécurité ? Voir [SECURITY.md](SECURITY.md) — **ne pas** ouvrir d'issue publique.

## Licence

Distribué sous licence **[GNU AGPL v3](LICENSE)**. En contribuant, vous acceptez que votre travail soit publié sous cette licence (voir le DCO dans [CONTRIBUTING.md](CONTRIBUTING.md)).
