-- The public roles keep the privileges the two applications use, no others.
--
-- anon (the public key) reads: auditions, nine columns of testimonies and the
-- two views. authenticated (a signed-in account) also inserts, updates and
-- deletes auditions and testimonies, and reads, inserts and deletes
-- user_roles, each under its row level security policies. Everything else
-- they held on the tables, views and sequence of schema public goes:
--
-- - TRUNCATE, REFERENCES, TRIGGER and MAINTAIN everywhere: row level security
--   does not apply to them, and PostgREST has no request that uses them;
-- - every privilege on audit_log: it is read through get_audit_log() and
--   written through insert_audit_log();
-- - writes on the two views, and anon's writes on auditions and testimonies:
--   only signed-in accounts write;
-- - anon's privileges on user_roles, and UPDATE for authenticated: a role is
--   granted or removed, never changed;
-- - the sequence of online_testimony_submissions, a table neither role reaches;
-- - has_role(): no policy and neither application calls it. get_audit_log()
--   stays for signed-in accounts (it answers super admins only).
--
-- Never `revoke all` nor `revoke select` on testimonies: its nine column
-- grants would go with it.
--
-- From here on, a table, view, sequence or function that postgres creates in
-- schema public is granted to neither role: a migration grants what it means
-- to. (A new function is still executable by PUBLIC, which default privileges
-- of a schema cannot take away: every migration revokes it by name, and
-- `npm run db:check -- grants` fails on a function that is not listed.)
--
-- This file comes first, so that the next ones create nothing with the old
-- default grants.
--
-- To undo: the baseline's statements, again:
--   grant all on table public.audit_log, public.auditions, public.user_roles,
--     public.audition_testimony_counts, public.distinct_testimony_topics
--     to anon, authenticated;
--   grant insert, references, delete, trigger, truncate, maintain, update
--     on table public.testimonies to anon, authenticated;
--   grant all on sequence public.online_testimony_submissions_id_seq to anon, authenticated;
--   grant execute on function public.has_role(public.app_role, uuid) to anon, authenticated;
--   grant execute on function public.get_audit_log(integer, integer) to anon;
--   alter default privileges for role postgres in schema public
--     grant all on tables to anon, authenticated;  (and on sequences, on functions)

-- The live site reads these tables: fail fast rather than queue behind it.
set lock_timeout = '200ms';

revoke truncate, references, trigger, maintain
  on all tables in schema public
  from anon, authenticated;

revoke all on table public.audit_log from anon, authenticated;

revoke insert, update, delete
  on table public.audition_testimony_counts, public.distinct_testimony_topics
  from anon, authenticated;

revoke insert, update, delete on table public.auditions, public.testimonies from anon;
revoke all on table public.user_roles from anon;
revoke update on table public.user_roles from authenticated;

revoke all on sequence public.online_testimony_submissions_id_seq from anon, authenticated;

revoke execute on function public.has_role(public.app_role, uuid) from public, anon, authenticated;
grant execute on function public.has_role(public.app_role, uuid) to service_role;

revoke execute on function public.get_audit_log(integer, integer) from public, anon;
grant execute on function public.get_audit_log(integer, integer) to authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
