# Staging

Staging is the whole site on fake data, for testers: its own Supabase project
(`papnqtvugzqtllcwigfi`, fake data only — see the README), its API on Scaleway,
its web app on Cloudflare (coming next). No email leaves it: they all land in
the site's « Emails de test » (`EMAIL_MODE=outbox`).

## The API

`.github/workflows/deploy-staging.yml` deploys it on every merge into `dev`
that touches the API (or by hand: Actions → Deploy staging API → Run workflow).
It builds the image from the commit, pushes it to a private Scaleway Container
Registry, creates or updates the Serverless Container with it, and waits until
that version answers on `/health` and reads its database. The run's summary
gives the URL, the version, and the Supabase Auth email hook's URL.

| | |
|---|---|
| Where | Scaleway, Paris (`fr-par`), project `auditions-citoyennes-staging`: containers namespace `staging`, container `api` |
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

### Keys

| Key | Can | Lives in |
|---|---|---|
| `STAGING_SCW_SECRET_KEY` | Containers and registry of the staging project only | GitHub secret |
| `STAGING_SUPABASE_SECRET_KEY` | Everything in the **staging** database (fake data) | GitHub secret → the container's secret environment |
| `STAGING_SEND_EMAIL_HOOK_SECRET` | Sign Auth's emails to the API | Supabase + GitHub secret → the container |

To rotate one: generate a new one, `gh secret set` it, run the workflow, then
revoke the old one.
