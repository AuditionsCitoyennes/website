-- An admin reads the unpublished content they created; super admins read all.
--
-- 1. admin_testimonies(), the admin read that includes the witnesses' email
--    addresses: a super admin gets every testimony asked for, an admin those
--    they created and those of the auditions they created. Same columns, same
--    order, same refusals. It sets an empty search_path.
-- 2. A draft audition is read by a super admin, or by the admin who created
--    it. The testimonies of a draft audition are read by a super admin, by the
--    admin who created the audition, or by the admin who created the
--    testimony. An account whose role was removed reads neither. Published
--    content is read as before. The two restrictive policies keep their place
--    and take the names of what they say.
--
-- To undo: run again the `CREATE OR REPLACE FUNCTION "public"."admin_testimonies"`
-- of 20261021175021_baseline.sql (execute for authenticated and service_role),
-- then
--   alter policy "Draft auditions are read by their author and super admins"
--     on public.auditions
--     using (status = 'published' or (select public.is_admin()) or (select public.is_super_admin()));
--   alter policy "Draft auditions are read by their author and super admins"
--     on public.auditions rename to "Draft auditions are read by admins only";
--   alter policy "Draft testimonies are read by their authors and super admins"
--     on public.testimonies
--     using ((select public.is_admin()) or (select public.is_super_admin()) or exists (
--       select 1 from public.auditions a
--        where a.id = testimonies.audition_id and a.status = 'published'));
--   alter policy "Draft testimonies are read by their authors and super admins"
--     on public.testimonies rename to "Testimonies of a draft audition are read by admins only";

-- The live site reads these tables: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create or replace function public.admin_testimonies(
  p_audition_id uuid default null,
  p_id uuid default null
) returns table (
  id uuid,
  audition_id uuid,
  person_name text,
  person_info text,
  content text,
  topics text[],
  email text,
  verification_status text,
  created_by uuid,
  created_at timestamptz
)
  language plpgsql
  stable
  security definer
  set search_path = ''
as $$
declare
  v_all boolean := public.is_super_admin();
  v_me uuid := auth.uid();
begin
  if not (v_all or public.is_admin()) then
    raise exception 'Accès réservé aux administrateurs' using errcode = '42501';
  end if;
  if p_audition_id is null and p_id is null then
    raise exception 'p_audition_id ou p_id requis' using errcode = '22023';
  end if;
  return query
    select t.id, t.audition_id, t.person_name, t.person_info, t.content, t.topics,
           t.email, t.verification_status, t.created_by, t.created_at
    from public.testimonies t
    where (p_audition_id is null or t.audition_id = p_audition_id)
      and (p_id is null or t.id = p_id)
      and (
        v_all
        or t.created_by = v_me
        or exists (
          select 1 from public.auditions a
           where a.id = t.audition_id and a.created_by = v_me
        )
      )
    order by t.created_at, t.id;
end;
$$;

revoke execute on function public.admin_testimonies(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_testimonies(uuid, uuid) to authenticated, service_role;

alter policy "Draft auditions are read by admins only"
  on public.auditions
  using (
    status = 'published'
    or (select public.is_super_admin())
    or ((select public.is_admin()) and created_by = (select auth.uid()))
  );
alter policy "Draft auditions are read by admins only"
  on public.auditions
  rename to "Draft auditions are read by their author and super admins";

alter policy "Testimonies of a draft audition are read by admins only"
  on public.testimonies
  using (
    (select public.is_super_admin())
    or exists (
      select 1
      from public.auditions a
      where a.id = testimonies.audition_id
        and a.status = 'published'
    )
    or (
      (select public.is_admin())
      and (
        created_by = (select auth.uid())
        or exists (
          select 1
          from public.auditions a
          where a.id = testimonies.audition_id
            and a.created_by = (select auth.uid())
        )
      )
    )
  );
alter policy "Testimonies of a draft audition are read by admins only"
  on public.testimonies
  rename to "Draft testimonies are read by their authors and super admins";
