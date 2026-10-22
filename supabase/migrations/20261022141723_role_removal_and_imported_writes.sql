-- Two policies production still left too open.
--
-- 1. "Admin delete roles" let any admin delete any user_roles row, a super
--    admin's included. Now only a super admin removes someone else's role;
--    anyone may still remove their own (the old app's "delete my account"
--    does that, and it only lowers the caller's own rights). The new API's
--    role removal is behind requireSuperAdmin and its account deletion uses
--    the service role, so both keep working.
--
-- 2. Any signed-in account could insert, update or delete imported_auditions
--    rows. Only the ingestion script writes there, with the service role
--    (which bypasses RLS); the API only reads and the old app never touches
--    the table. The table itself goes with the imported-data feature.
set lock_timeout = '200ms';

drop policy if exists "Admin delete roles" on public.user_roles;

create policy "Super admins remove roles, anyone their own"
  on public.user_roles
  for delete
  to authenticated
  using ((select public.is_super_admin()) or user_id = (select auth.uid()));

drop policy if exists "Authenticated can insert imported auditions" on public.imported_auditions;
drop policy if exists "Authenticated can update imported auditions" on public.imported_auditions;
drop policy if exists "Authenticated can delete imported auditions" on public.imported_auditions;
