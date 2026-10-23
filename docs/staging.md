# Staging

Staging is the whole site on fake data, for testers: its own Supabase project
(`papnqtvugzqtllcwigfi`, fake data only — see the README), its API on Scaleway,
its web app on Cloudflare, at https://staging.auditionscitoyennes.com. No
email leaves it: they all land in the site's « Emails de test »
(`EMAIL_MODE=outbox`).

## The API

`.github/workflows/deploy-staging.yml` deploys it on every merge into `dev`
that touches the API (or by hand: Actions → Deploy staging API → Run workflow).
It builds the image from the commit, pushes it to a private Scaleway Container
Registry, creates or updates the Serverless Container with it, and waits until
that version answers on `/health` and reads its database. The run's summary
gives the URL, the version, and the Supabase Auth email hook's URL.

| | |
|---|---|
| Where | Scaleway, Paris (`fr-par`), project `auditions-citoyennes-staging`: containers namespace `staging`, container `auditions-api` |
| Size | 512 MB, one instance, always on (`STAGING_MIN_SCALE`, default 1). At 0 it costs nearly nothing but starts cold, slower than the 5 s Supabase Auth gives its email hook, so a sign-up after a quiet spell fails |
| Configuration | All of it in the workflow (`ENV_*` public, `SECRET_*` from the repository's secrets), applied at every deploy: change it there, never in the console |
| Images | Tagged with the commit; the 10 latest are kept |
| Version | `/health` answers `version` (the commit) and, outside production, `ip`: the address the API sees, which must be the visitor's |

`scripts/deploy/scaleway.sh` does the Scaleway part (`registry`, `deploy`,
`prune`), creating what is missing on the first run.

### Setup (once)

In Scaleway (console, organisation of Auditions Citoyennes):

1. **IAM → Applications → Create application**: `github-staging-deploy`, no
   group.
2. **IAM → Policies → Create policy**: `github-staging-deploy`, principal the
   application above. One rule: scope *Access to resources*, project
   `auditions-citoyennes-staging` only, permission sets
   `ContainersFullAccess` and `ContainerRegistryFullAccess`.
3. **The application → API keys → Generate an API key**: preferred project
   `auditions-citoyennes-staging`. Only the **secret key** is used; it is shown
   once: straight into GitHub (step 5), nowhere else.

In Supabase, staging project → **Project Settings → API Keys → Secret keys**:
reveal and copy the `default` key (`sb_secret_…`).

In a terminal at the repository's root (`gh secret set` asks for the value
without echoing it):

```bash
gh secret set STAGING_SCW_SECRET_KEY          # 4. the Scaleway secret key
gh secret set STAGING_SUPABASE_SECRET_KEY     # 5. the Supabase sb_secret_… key
gh variable set STAGING_SCW_PROJECT_ID --body <staging project id>
gh variable set STAGING_SCW_REGISTRY_NAMESPACE --body auditions-citoyennes-staging
```

The project id is in Scaleway → Project settings. The registry namespace name
is unique across all of Scaleway: if taken, pick another.

Then run the workflow once (Actions → Deploy staging API → Run workflow, branch
`dev`).

### Supabase Auth's emails (sign-up, password…)

After the first deploy: Supabase, staging project → **Authentication → Auth
Hooks → Add hook → Send Email hook**, type *HTTPS*, URL = the one in the run's
summary (`https://…/api/hooks/send-email`), **Generate secret**, copy it, then:

```bash
gh secret set STAGING_SEND_EMAIL_HOOK_SECRET  # the v1,whsec_… secret
```

Run the workflow again (the API serves the hook once it has the secret), then
create the hook in Supabase. From then on, Auth sends no email of its own: they
all go to the outbox.

## The site

`.github/workflows/deploy-staging-web.yml` builds the web app for staging and
puts it on Cloudflare Workers (`apps/web/wrangler.jsonc`, Worker
`auditions-staging`): every merge into `dev` that touches it goes to
https://staging.auditionscitoyennes.com, every pull request gets its own
preview, `pr-<number>-auditions-staging.<account>.workers.dev`, linked from the
pull request's checks as « Staging preview » (not Dependabot's: they get no
secrets).

Cloudflare serves the app's files; only `/api/*` runs the Worker
(`apps/web/worker/index.ts`), which forwards it to the API on Scaleway. For the
browser it is all one site: no CORS, and one gate in front of both (Cloudflare
Access, next). Every request then reaches the API from Cloudflare, so the
Worker passes the visitor's address along (`X-Visitor-IP`), and the API
believes it only with the secret they share (`PROXY_SECRET`). Each deploy
checks it: the address Cloudflare saw (`/cdn-cgi/trace`) must be the one the
API saw (`/api/health`).

Staging pages say `noindex` and `robots.txt` turns crawlers away.

### Setup (once)

In Cloudflare (dashboard of the account that holds `auditionscitoyennes.com`):

1. **Workers & Pages**: if Cloudflare asks for a `workers.dev` subdomain, give
   it one (e.g. `auditions-citoyennes`) — the previews live under it.
2. **My Profile → API Tokens → Create Token → template "Edit Cloudflare
   Workers"**: *Account Resources* = this account only, *Zone Resources* =
   `auditionscitoyennes.com` only. Copy the token (shown once).
3. The **Account ID**: on the domain's overview page, right column.

In a terminal at the repository's root:

```bash
gh secret set STAGING_CLOUDFLARE_API_TOKEN    # the token of step 2
gh variable set CLOUDFLARE_ACCOUNT_ID --body <account id>
openssl rand -base64 48 | gh secret set STAGING_PROXY_SECRET
gh variable set MAPBOX_TOKEN --body <the public pk.… token of apps/web/.env>
gh variable set MAPBOX_STYLE --body <the mapbox:// style URL of apps/web/.env>
```

`STAGING_PROXY_SECRET` is made up on the spot and never shown: both deploys
read it from GitHub. After setting it, run « Deploy staging API » once, so the
API knows it too.

The Mapbox token must accept the staging domain: if it is restricted to some
URLs (Mapbox → Tokens), add `https://staging.auditionscitoyennes.com` and
`https://*.workers.dev`.

In Supabase, staging project → **Authentication → URL Configuration**:

- *Site URL*: `https://staging.auditionscitoyennes.com`
- *Redirect URLs*: `https://staging.auditionscitoyennes.com/**` and
  `https://pr-*-auditions-staging.*.workers.dev/**` (the previews)

Without them, the links of the sign-up and password emails lead to
`localhost`.

### Keys

| Key | Can | Lives in |
|---|---|---|
| `STAGING_SCW_SECRET_KEY` | Containers and registry of the staging project only | GitHub secret |
| `STAGING_SUPABASE_SECRET_KEY` | Everything in the **staging** database (fake data) | GitHub secret → the container's secret environment |
| `STAGING_SEND_EMAIL_HOOK_SECRET` | Sign Auth's emails to the API | Supabase + GitHub secret → the container |
| `STAGING_CLOUDFLARE_API_TOKEN` | Workers of the account, and Worker routes of `auditionscitoyennes.com` | GitHub secret |
| `STAGING_PROXY_SECRET` | Vouch for a visitor's address to the API | GitHub secret → the Worker's and the container's secrets |

To rotate one: generate a new one, `gh secret set` it, run the workflow, then
revoke the old one.
