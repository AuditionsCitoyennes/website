-- Functions that let both apps stop reading testimonies.email and
-- testimonies.verification_token straight from the table: the first half of
-- taking those columns out of the public API (20261021170000 does the rest,
-- once the apps call these instead).
--
-- * testimony_for_verification / verify_testimony_by_token /
--   reject_testimony_by_token serve the old app's /verifier page. Each acts on
--   one row and only for a caller who holds that row's exact token. The table
--   policies they replace ("Anon can update/delete testimony by token") only
--   checked that a row HAS a token, so anyone could edit or delete every
--   pending testimony. Same rules as the page: pending only, 14 days, and
--   online testimonies stay out (their own restrictive policies already keep
--   anon away from them; the API verifies those).
-- * admin_testimonies is what the admin screens of both apps read, email
--   included, for admins only.
--
-- verification_token is text on production and uuid in a database built from
-- the older migrations, hence the ::text casts.
set lock_timeout = '200ms';

create or replace function public.testimony_for_verification(p_token text)
returns table (
  id uuid,
  person_name text,
  person_info text,
  content text,
  verification_status text,
  audition_id uuid,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.person_name, t.person_info, t.content,
         t.verification_status, t.audition_id, t.created_at
  from public.testimonies t
  where p_token is not null
    and t.verification_token::text = p_token
    and not public.is_online_audition(t.audition_id)
$$;

-- Confirms a pending testimony, optionally with the witness's corrections:
-- p_edits = {"person_name", "person_info", "content"} replaces all three (an
-- empty or missing person_info clears it). False when there is nothing to
-- confirm (unknown token, already handled, or past the 14 days).
create or replace function public.verify_testimony_by_token(p_token text, p_edits jsonb default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(p_edits ->> 'person_name'), '');
  v_info text := nullif(btrim(p_edits ->> 'person_info'), '');
  v_content text := nullif(btrim(p_edits ->> 'content'), '');
begin
  if p_token is null then
    return false;
  end if;
  if p_edits is not null and (
    v_name is null or v_content is null
    or length(v_name) > 200
    or length(coalesce(v_info, '')) > 500
    or length(v_content) > 20000
  ) then
    raise exception 'Modifications invalides' using errcode = '22023';
  end if;

  update public.testimonies t
     set verification_status = 'verified',
         person_name = case when p_edits is null then t.person_name else v_name end,
         person_info = case when p_edits is null then t.person_info else v_info end,
         content = case when p_edits is null then t.content else v_content end
   where t.verification_token::text = p_token
     and t.verification_status = 'pending'
     and t.created_at >= now() - interval '14 days'
     and not public.is_online_audition(t.audition_id);
  return found;
end;
$$;

-- The witness withdraws a pending testimony: the row is deleted.
create or replace function public.reject_testimony_by_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_token is null then
    return false;
  end if;
  delete from public.testimonies t
   where t.verification_token::text = p_token
     and t.verification_status = 'pending'
     and t.created_at >= now() - interval '14 days'
     and not public.is_online_audition(t.audition_id);
  return found;
end;
$$;

-- Admin view of testimonies, email included (never the token). One audition
-- (p_audition_id) or one testimony (p_id); there is no "everything" call.
create or replace function public.admin_testimonies(p_audition_id uuid default null, p_id uuid default null)
returns table (
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
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_super_admin()) then
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
    order by t.created_at, t.id;
end;
$$;

revoke all on function public.testimony_for_verification(text) from public;
revoke all on function public.verify_testimony_by_token(text, jsonb) from public;
revoke all on function public.reject_testimony_by_token(text) from public;
revoke all on function public.admin_testimonies(uuid, uuid) from public, anon;
grant execute on function public.testimony_for_verification(text) to anon, authenticated;
grant execute on function public.verify_testimony_by_token(text, jsonb) to anon, authenticated;
grant execute on function public.reject_testimony_by_token(text) to anon, authenticated;
grant execute on function public.admin_testimonies(uuid, uuid) to authenticated;
