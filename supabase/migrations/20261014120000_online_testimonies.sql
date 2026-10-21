-- Online testimonies ("Témoigner" on the site, open to every visitor).
--
-- A visitor gives a commune (an arrondissement in Paris, Lyon, Marseille), an
-- email and a testimony. The testimony goes into that place's online audition
-- of the month — "Audition en ligne de <mois>", located at its town hall,
-- created by the first testimony of the month — and is public only once the
-- link sent to the email has been clicked. One testimony per email per week.
--
-- Written to live alongside the old app, which shares this database and still
-- relies on the legacy "by token" policies: nothing existing is dropped or
-- loosened. Everything new only adds RESTRICTIVE policies (they AND with the
-- existing ones) that bite on online auditions/testimonies alone — plus one
-- security fix every guarantee here depends on (see "Admin rights" below).

-- Applied on a live database: rather fail fast (and be re-run) than queue
-- behind a long read while holding locks the site's reads would then wait on.
set lock_timeout = '200ms';

-- ---- Admin rights ---------------------------------------------------------------
-- "Allow first admin setup" (20251220154314) would let ANY signed-in account
-- insert an 'admin' role (its "no admin yet" check runs under the caller's own
-- RLS, which hides every role row from a newcomer). Every guarantee below
-- assumes admins are real admins. The live database no longer has it (removed
-- by hand); this makes sure of it wherever these migrations are replayed.
drop policy if exists "Allow first admin setup" on public.user_roles;

-- ---- Columns ------------------------------------------------------------------

alter table public.auditions
  add column if not exists audition_en_ligne boolean not null default false,
  -- INSEE code of the town hall's commune or arrondissement: with `date` (the
  -- 1st of the month), what makes "this place's audition of this month" unique.
  add column if not exists citycode text,
  -- Where the town hall is, resolved once from the official commune API when
  -- the audition is created: { insee, commune, arrondissement, departementCode,
  -- departementName, region, lat, lng }. The map places online auditions from
  -- it rather than by geocoding their label.
  add column if not exists place jsonb;

comment on column public.auditions.audition_en_ligne is
  'Audition en ligne : regroupe les témoignages déposés sur le site pour une mairie et un mois.';

alter table public.auditions
  drop constraint if exists auditions_en_ligne_shape;
alter table public.auditions
  add constraint auditions_en_ligne_shape check (
    not audition_en_ligne
    or (
      citycode is not null
      and place is not null
      and "date" = date_trunc('month', "date"::timestamp)::date
    )
  );

create unique index if not exists auditions_en_ligne_mairie_mois
  on public.auditions (citycode, "date")
  where audition_en_ligne;

-- Postgres does not index foreign keys: the policies below and the embedded
-- counts look testimonies up by audition.
create index if not exists testimonies_audition_id_idx on public.testimonies (audition_id);

-- ---- The weekly quota: who submitted when, without keeping the address -------

create table if not exists public.online_testimony_submissions (
  id bigint generated always as identity primary key,
  -- Kept when the testimony is deleted (rejected through its link, removed by
  -- an admin): the week's quota still counts it — or deleting one's own
  -- testimony would open the door to the next one at once.
  testimony_id uuid references public.testimonies (id) on delete set null,
  -- SHA-256 of the normalized email (lowercase, "+tag" dropped): enough to
  -- count a week's submissions, without storing the address itself. Purged
  -- after 8 days (see submit_online_testimony): no use beyond the week.
  email_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists online_testimony_submissions_email_idx
  on public.online_testimony_submissions (email_hash, created_at);

-- Server only (service role): no policy at all for anyone else.
alter table public.online_testimony_submissions enable row level security;
revoke all on public.online_testimony_submissions from anon, authenticated;

-- ---- Helpers (SECURITY DEFINER: they must see past the callers' RLS) --------

create or replace function public.is_online_audition(p_audition uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select audition_en_ligne from public.auditions where id = p_audition), false)
$$;

-- The online testimonies, as one list computed once per query (an InitPlan),
-- not a function call per row of a ~4,000-row table: all of them, or only
-- those not verified yet (the ones the public must not see).
create or replace function public.online_testimony_ids(p_unverified_only boolean)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(t.id), '{}'::uuid[])
  from public.testimonies t
  join public.auditions a on a.id = t.audition_id
  where a.audition_en_ligne
    and (not p_unverified_only or t.verification_status is distinct from 'verified')
$$;

create or replace function public.has_verified_testimony(p_audition uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.testimonies
    where audition_id = p_audition and verification_status = 'verified'
  )
$$;

-- ---- Visibility: an online testimony is public once its email is verified ----

drop policy if exists "Online testimonies are public once verified" on public.testimonies;
create policy "Online testimonies are public once verified"
  on public.testimonies as restrictive for select to anon, authenticated
  using (
    (select public.is_admin()) or (select public.is_super_admin())
    or id <> all ((select public.online_testimony_ids(true))::uuid[])
  );

-- The legacy by-token policies let anyone holding the anon key update or
-- delete a tokened row: not an online one (verification goes through the API).
drop policy if exists "Online testimonies are changed by admins only" on public.testimonies;
create policy "Online testimonies are changed by admins only"
  on public.testimonies as restrictive for update to anon, authenticated
  using (
    (select public.is_admin()) or (select public.is_super_admin())
    or id <> all ((select public.online_testimony_ids(false))::uuid[])
  )
  with check (
    (select public.is_admin()) or (select public.is_super_admin())
    or not public.is_online_audition(audition_id)
  );

drop policy if exists "Online testimonies are deleted by admins only" on public.testimonies;
create policy "Online testimonies are deleted by admins only"
  on public.testimonies as restrictive for delete to anon, authenticated
  using (
    (select public.is_admin()) or (select public.is_super_admin())
    or id <> all ((select public.online_testimony_ids(false))::uuid[])
  );

drop policy if exists "Online testimonies are added by admins only" on public.testimonies;
create policy "Online testimonies are added by admins only"
  on public.testimonies as restrictive for insert to anon, authenticated
  with check (
    (select public.is_admin()) or (select public.is_super_admin())
    or not public.is_online_audition(audition_id)
  );

-- An online audition is public once it holds a verified testimony: until then
-- it would only say that someone, somewhere, tried.
drop policy if exists "Online auditions are public once one testimony is verified" on public.auditions;
create policy "Online auditions are public once one testimony is verified"
  on public.auditions as restrictive for select to anon, authenticated
  using (
    not audition_en_ligne
    or (select public.is_admin()) or (select public.is_super_admin())
    or public.has_verified_testimony(id)
  );

-- Online auditions are created by the server alone (submit_online_testimony),
-- and only admins may change or remove them.
drop policy if exists "Online auditions are created by the server only" on public.auditions;
create policy "Online auditions are created by the server only"
  on public.auditions as restrictive for insert to anon, authenticated
  with check (not audition_en_ligne);

drop policy if exists "Online auditions are changed by admins only" on public.auditions;
create policy "Online auditions are changed by admins only"
  on public.auditions as restrictive for update to anon, authenticated
  using (not audition_en_ligne or (select public.is_admin()) or (select public.is_super_admin()))
  with check (not audition_en_ligne or (select public.is_admin()) or (select public.is_super_admin()));

drop policy if exists "Online auditions are deleted by admins only" on public.auditions;
create policy "Online auditions are deleted by admins only"
  on public.auditions as restrictive for delete to anon, authenticated
  using (not audition_en_ligne or (select public.is_admin()) or (select public.is_super_admin()));

-- The two public views run with their owner's rights (they bypass RLS): they
-- must leave unverified online testimonies out themselves. Same columns.
create or replace view public.audition_testimony_counts as
select
  t.audition_id,
  count(*)::int as total_count,
  count(*) filter (where t.verification_status = 'verified')::int as verified_count
from public.testimonies t
join public.auditions a on a.id = t.audition_id
where not a.audition_en_ligne or t.verification_status = 'verified'
group by t.audition_id;

create or replace view public.distinct_testimony_topics as
select distinct unnest(t.topics) as topic
from public.testimonies t
join public.auditions a on a.id = t.audition_id
where a.status = 'published'
  and t.topics is not null
  and (not a.audition_en_ligne or t.verification_status = 'verified');

-- ---- Submitting: one transaction, race-proof ---------------------------------

create or replace function public.submit_online_testimony(
  p_email_hash text,
  p_person_name text,
  p_person_info text,
  p_content text,
  p_citycode text,
  p_location text,
  p_place jsonb,
  p_month date,
  p_title text,
  p_audition_content text,
  p_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_audition uuid;
  v_created boolean := false;
  v_testimony uuid := gen_random_uuid();
begin
  -- One submission per email at a time: the quota check and the insert below
  -- cannot interleave with another request for the same address.
  perform pg_advisory_xact_lock(hashtextextended('online-testimony:' || p_email_hash, 0));

  select max(created_at) into v_last
  from public.online_testimony_submissions
  where email_hash = p_email_hash and created_at > now() - interval '7 days';
  if v_last is not null then
    -- PT429: PostgREST answers 429; the detail is when the next one is allowed.
    raise exception 'weekly_limit'
      using errcode = 'PT429', detail = to_char((v_last + interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;

  -- This place's audition of the month: created by its first testimony. Two
  -- first testimonies at once: one inserts, the other waits for it and finds
  -- it — locked, so that it cannot be deleted under this testimony. (Deleted
  -- between the two statements: inserted again on the next turn. Never a
  -- testimony without its audition: it would pass for an ordinary one.)
  loop
    insert into public.auditions
      (title, "date", location, content, status, audition_en_ligne, citycode, place)
    values
      (p_title, p_month, p_location, p_audition_content, 'published', true, p_citycode, p_place)
    on conflict (citycode, "date") where audition_en_ligne do nothing
    returning id into v_audition;
    if v_audition is not null then
      v_created := true;
      exit;
    end if;
    select id into v_audition
    from public.auditions
    where audition_en_ligne and citycode = p_citycode and "date" = p_month
    for key share;
    exit when v_audition is not null;
  end loop;

  insert into public.testimonies
    (id, audition_id, person_name, person_info, content, email, verification_status, verification_token, created_by)
  values
    (v_testimony, v_audition, p_person_name, p_person_info, p_content, null, 'pending', p_token, null);

  insert into public.online_testimony_submissions (testimony_id, email_hash)
  values (v_testimony, p_email_hash);

  -- Housekeeping. Links expire after 14 days: what was never verified goes.
  -- Online auditions left empty go too — a month late, so as never to touch
  -- one a request begun just before midnight is still filling. And the quota
  -- forgets an address once its week is over.
  delete from public.testimonies t
  using public.auditions a
  where a.id = t.audition_id
    and a.audition_en_ligne
    and t.verification_status = 'pending'
    and t.created_at < now() - interval '15 days';
  delete from public.auditions a
  where a.audition_en_ligne
    and a."date" < (p_month - interval '1 month')::date
    and not exists (select 1 from public.testimonies t where t.audition_id = a.id);
  delete from public.online_testimony_submissions
  where created_at < now() - interval '8 days';

  return jsonb_build_object(
    'testimony_id', v_testimony,
    'audition_id', v_audition,
    'audition_created', v_created
  );
end;
$$;

revoke all on function public.submit_online_testimony(text, text, text, text, text, text, jsonb, date, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_online_testimony(text, text, text, text, text, text, jsonb, date, text, text, uuid)
  to service_role;
