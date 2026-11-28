# Backups

Production's database is backed up every night by `.github/workflows/backup.yml`
(02:17 UTC, or on demand: Actions → Backup → Run workflow). The Supabase Free
plan keeps no backup of its own: these are the only copies.

| | |
|---|---|
| What | `roles.sql`, `schema.sql`, `data.sql` from `supabase db dump` (data includes the `auth` accounts), in one `tar.gz` |
| Encryption | [age](https://age-encryption.org), to `BACKUP_AGE_RECIPIENT`. Only the owners hold the private key (password manager); GitHub and Scaleway never see it |
| Where | Scaleway Object Storage, Paris, bucket `BACKUP_BUCKET`, prefix `prod/`, project `auditions-citoyennes-prod` |
| Kept | 30 days (bucket lifecycle rule), versioned |
| Upload key | IAM application allowed `ObjectStorageObjectsWrite` only: it can add files, not read, list or delete them |

A run fails, and GitHub emails the owner, if the dump has no auditions or no
testimonies. The key, if lost, makes every backup unreadable: keep it in the
password manager of both owners.

The workflow reads its secrets (`PROD_DB_URL`, `SCW_ACCESS_KEY`,
`SCW_SECRET_KEY`) from the GitHub environment `production-backup` (Settings →
Environments), not from the repository's own secrets. Set there: deployment
branches `dev` and `main`, so that only a workflow run from one of them
receives the secrets, and no required reviewer, or the nightly run would wait
for an approval. The job uses no action from another repository and no cache:
the Supabase CLI is downloaded from its release page and checked against the
checksum written in the workflow.

A run that never starts (a disabled workflow, a schedule GitHub paused) fails
nothing and emails nobody. Optional: a monitor outside GitHub that expects a
call every night and alerts when none came for 36 hours; put its URL in the
environment's secret `BACKUP_PING_URL` and each finished backup calls it.

## Restore drill (do it after setup, then every few months)

On your machine, into the **local** stack only. The decrypted files hold real
personal data: they go to a temporary folder outside the repository, the
private key is never written to a file, and both are gone at the end.

1. Scaleway console → project `auditions-citoyennes-prod` → Object Storage →
   the bucket → `prod/` → download the latest `prod-….tar.gz.age`.
2. Decrypt it into a temporary folder. `--identity -` reads the private key
   from the terminal: paste it from the password manager, press Enter, then
   Ctrl-D.

   ```sh
   drill=$(mktemp -d)
   age --decrypt --identity - ~/Downloads/prod-….tar.gz.age | tar -xzf - -C "$drill"
   ```

3. In the same terminal, at the repository's root, load the data into a local
   database that has the same structure (migrations, no fake data):

   ```sh
   npm run db:start
   supabase db reset --no-seed
   # the auth service recreates its tables a few seconds after the reset
   until docker ps | grep -q 'supabase_auth_auditions-citoyennes.*(healthy)'; do sleep 2; done
   docker exec -i supabase_db_auditions-citoyennes psql -U postgres \
     --single-transaction -v ON_ERROR_STOP=1 \
     -c 'SET session_replication_role = replica' -f - < "$drill/data.sql"
   ```

4. Compare with production (Studio at http://127.0.0.1:54323, or counts of
   `auditions`, `testimonies`, `auth.users`).
5. Clean up: `npm run db:reset` (back to fake data), then
   `rm -rf "$drill" ~/Downloads/prod-….tar.gz.age`.

## Real restore

Into a new Supabase project, or into production after an incident, with the
three files and Supabase's documented order
([backup & restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)):

```sh
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql --dbname "$TARGET_DB_URL"
```

Then point the apps at it and check the migration history
(`supabase migration list`).
