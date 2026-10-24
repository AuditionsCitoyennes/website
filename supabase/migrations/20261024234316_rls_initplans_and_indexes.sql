-- Audit PR 7 (docs/api-optimisation-audit-2026-10-20.md, "PR 7 — Database",
-- points 1 and 2). Two things, nothing a user could notice except speed.
--
-- 1. Eight policies still call public.is_admin() / public.is_super_admin()
--    bare. Both functions are SECURITY DEFINER, which stops the planner from
--    inlining them, so a bare call is run again for every candidate row (one
--    user_roles probe each time). Written as (select public.is_admin()) the
--    same call becomes an InitPlan: evaluated once per statement, its result
--    reused for every row. The 2026-10 online-testimonies policies and the
--    two 2026-10-21/22 user_roles policies already do this; these are the
--    ones the baseline still has the old way. Same predicates, same names,
--    same commands, same roles (none named: PUBLIC, as before), permissive as
--    before — only the wrapping changes. Dropped and re-created in this one
--    transaction, so no statement ever runs without them.
--
-- 2. Four indexes for the orderings and filters the API and the admin pages
--    actually use. audit_log is the only table that grows without bound, and
--    it is read newest-first; the public testimonies feed pages newest-first
--    with id as the tie-break; the home page lists published auditions by
--    date; has_verified_testimony() and the counts view look up verified
--    testimonies by audition. Plain create index (no CONCURRENTLY: this file
--    runs inside one transaction); the tables are small, it takes
--    milliseconds.
--
-- Not here, on purpose: the functions themselves are untouched (still
-- VOLATILE SECURITY DEFINER; the InitPlan does not depend on volatility),
-- and the optional jsonb RPCs / verify_testimony_v2 of points 3-4 are a
-- separate decision.
set lock_timeout = '200ms';

-- 1. Policies ---------------------------------------------------------------

-- auditions
drop policy if exists "Admin insert auditions" on public.auditions;
create policy "Admin insert auditions"
  on public.auditions
  for insert
  with check ((select public.is_admin()));

drop policy if exists "Admin update auditions" on public.auditions;
create policy "Admin update auditions"
  on public.auditions
  for update
  using ((select public.is_admin()));

drop policy if exists "Admin delete auditions" on public.auditions;
create policy "Admin delete auditions"
  on public.auditions
  for delete
  using ((select public.is_admin()));

-- testimonies
drop policy if exists "Admin insert testimonies" on public.testimonies;
create policy "Admin insert testimonies"
  on public.testimonies
  for insert
  with check ((select public.is_admin()));

drop policy if exists "Admin update testimonies" on public.testimonies;
create policy "Admin update testimonies"
  on public.testimonies
  for update
  using ((select public.is_admin()));

drop policy if exists "Admin delete testimonies" on public.testimonies;
create policy "Admin delete testimonies"
  on public.testimonies
  for delete
  using ((select public.is_admin()));

-- user_roles
drop policy if exists "Admin read roles" on public.user_roles;
create policy "Admin read roles"
  on public.user_roles
  for select
  using ((select public.is_admin()));

-- audit_log
drop policy if exists "super_admin_read_audit_log" on public.audit_log;
create policy "super_admin_read_audit_log"
  on public.audit_log
  for select
  using ((select public.is_super_admin()));

-- 2. Indexes ----------------------------------------------------------------

create index if not exists audit_log_created_at_idx
  on public.audit_log (created_at desc);

create index if not exists testimonies_created_at_id_idx
  on public.testimonies (created_at desc, id desc);

create index if not exists auditions_published_date_idx
  on public.auditions ("date" desc)
  where status = 'published';

create index if not exists testimonies_verified_audition_id_idx
  on public.testimonies (audition_id)
  where verification_status = 'verified';
