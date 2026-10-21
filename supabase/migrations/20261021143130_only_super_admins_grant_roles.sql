-- Only super admins may grant roles.
--
-- Production's "Admin insert roles" policy was created outside the migration
-- history with WITH CHECK (true) and no TO clause, and anon/authenticated hold
-- every privilege on user_roles: any caller of the public API, including an
-- account signed up a minute earlier, could insert a row making itself
-- super_admin. (The repository never had this policy, so a database built
-- from these migrations skips the DROP below.)
--
-- Roles are granted in two places, and both keep working:
--   * the old app: its handle-registration edge function, with the service
--     role key (bypasses RLS) after checking the caller is a super admin;
--   * the new API: POST /api/admin/registrations/:userId, behind
--     requireSuperAdmin, through the caller's RLS client.
set lock_timeout = '200ms';

drop policy if exists "Admin insert roles" on public.user_roles;

create policy "Super admins grant roles"
  on public.user_roles
  for insert
  to authenticated
  with check ((select public.is_super_admin()));
