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

## Restore drill (do it after setup, then every few months)

On your machine, into the **local** stack only. The decrypted files hold real
personal data: delete them at the end.

1. Scaleway console → project `auditions-citoyennes-prod` → Object Storage →
   the bucket → `prod/` → download the latest `prod-….tar.gz.age`.
2. Put the private key from the password manager in a file, then decrypt:

   ```sh
   mkdir restore
   age --decrypt --identity key.txt prod-….tar.gz.age | tar -xzf - -C restore
   rm key.txt
   ```

3. Load the data into a local database that has the same structure
   (migrations, no fake data):

   ```sh
   npm run db:start
   supabase db reset --no-seed
   # the auth service recreates its tables a few seconds after the reset
   until docker ps | grep -q 'supabase_auth_auditions-citoyennes.*(healthy)'; do sleep 2; done
   docker exec -i supabase_db_auditions-citoyennes psql -U postgres \
     --single-transaction -v ON_ERROR_STOP=1 \
     -c 'SET session_replication_role = replica' -f - < restore/data.sql
   ```

4. Compare with production (Studio at http://127.0.0.1:54323, or counts of
   `auditions`, `testimonies`, `auth.users`).
5. Clean up: `npm run db:reset` (back to fake data), then delete `restore/`
   and the downloaded file.

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
