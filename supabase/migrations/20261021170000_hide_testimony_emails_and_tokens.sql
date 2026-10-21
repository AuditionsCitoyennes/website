-- Take testimonies.email and testimonies.verification_token out of the
-- public API, and stop letting anyone edit or delete pending testimonies.
--
-- On production every row of testimonies is readable by anon and
-- authenticated ("Public read testimonies", USING true), with every column:
-- witnesses' email addresses and verification tokens included. RLS filters
-- rows, not columns, so the columns go through privileges: the two roles keep
-- SELECT on every other column. Admins read emails through admin_testimonies()
-- and witnesses use their link through the *_by_token() functions
-- (20261021160000). The service role is untouched.
--
-- Apply only once both apps call those functions: a `select *` on testimonies
-- from anon or a signed-in user fails after this migration.
--
-- A column added to testimonies later is NOT readable by anon/authenticated
-- until a migration grants it.
set lock_timeout = '200ms';

drop policy if exists "Anon can update testimony by token" on public.testimonies;
drop policy if exists "Anon can delete testimony by token" on public.testimonies;

revoke select on public.testimonies from anon, authenticated;
grant select (
  id,
  audition_id,
  person_name,
  person_info,
  content,
  topics,
  verification_status,
  created_by,
  created_at
) on public.testimonies to anon, authenticated;
