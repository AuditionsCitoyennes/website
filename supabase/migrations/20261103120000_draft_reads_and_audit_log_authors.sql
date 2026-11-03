-- Two access rules.
--
-- 1. Draft auditions, and the testimonies of a draft audition, are read by
--    admins only. Through the public key a reader sees what the site lists:
--    published auditions (the site's own reads all ask for
--    status = 'published'), with the online-audition rules on top as before.
--    Same shape as those rules: restrictive policies over the public read.
--
-- 2. An audit-log entry is written by the server (service role), or by a
--    signed-in user about their own action, the only two ways the old app and
--    the API write one.

-- The live site reads these tables: fail fast rather than queue behind it.
set lock_timeout = '200ms';

create policy "Draft auditions are read by admins only"
  on public.auditions
  as restrictive
  for select
  to authenticated, anon
  using (
    status = 'published'
    or (select public.is_admin())
    or (select public.is_super_admin())
  );

create policy "Testimonies of a draft audition are read by admins only"
  on public.testimonies
  as restrictive
  for select
  to authenticated, anon
  using (
    (select public.is_admin())
    or (select public.is_super_admin())
    or exists (
      select 1
      from public.auditions a
      where a.id = testimonies.audition_id
        and a.status = 'published'
    )
  );

create or replace function public.insert_audit_log(
  p_user_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (auth.uid() is null or p_user_id is distinct from auth.uid()) then
    raise exception 'an audit entry is written by the server, or by a signed-in user about their own action'
      using errcode = '42501';
  end if;
  insert into public.audit_log (user_id, action, target_type, target_id, metadata)
  values (p_user_id, p_action, p_target_type, p_target_id, p_metadata);
end;
$$;

revoke execute on function public.insert_audit_log(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.insert_audit_log(uuid, text, text, text, jsonb) to authenticated, service_role;
