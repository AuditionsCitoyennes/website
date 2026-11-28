-- The two lists a super admin reads are bounded: what an account wrote about
-- itself is cut to what the pages show, and each list holds 200 rows at most.
--
-- get_pending_registrations(): the confirmed accounts without a role, newest
-- first; get_user_roles_with_details(): the roles, newest first. Same columns
-- and same rule as before (they answer super admins only). The name is cut to
-- 80 characters and the presentation to 600: the sign-up forms accept 50 and
-- 500.
--
-- Both set their search_path and are executable by signed-in accounts and the
-- service role.
--
-- To undo: run again the two `CREATE OR REPLACE FUNCTION` of
-- 20261021175021_baseline.sql, then
--   grant execute on function public.get_pending_registrations(),
--     public.get_user_roles_with_details() to anon;

-- The live site calls these functions: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create or replace function public.get_pending_registrations()
  returns table (user_id uuid, email text, username text, bio text, created_at timestamptz)
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if not public.is_super_admin() then
    return;
  end if;

  return query
  select
    u.id as user_id,
    u.email::text,
    pg_catalog.left(u.raw_user_meta_data ->> 'username', 80) as username,
    pg_catalog.left(u.raw_user_meta_data ->> 'bio', 600) as bio,
    u.created_at
  from auth.users u
  where u.email_confirmed_at is not null
    and not exists (select 1 from public.user_roles ur where ur.user_id = u.id)
  order by u.created_at desc
  limit 200;
end;
$$;

revoke execute on function public.get_pending_registrations() from public, anon, authenticated;
grant execute on function public.get_pending_registrations() to authenticated, service_role;

create or replace function public.get_user_roles_with_details()
  returns table (id uuid, user_id uuid, role text, created_at timestamptz, email text, username text)
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if not public.is_super_admin() then
    return;
  end if;

  return query
  select
    ur.id,
    ur.user_id,
    ur.role::text,
    ur.created_at,
    u.email::text,
    pg_catalog.left(u.raw_user_meta_data ->> 'username', 80) as username
  from public.user_roles ur
  left join auth.users u on u.id = ur.user_id
  order by ur.created_at desc
  limit 200;
end;
$$;

revoke execute on function public.get_user_roles_with_details() from public, anon, authenticated;
grant execute on function public.get_user_roles_with_details() to authenticated, service_role;
