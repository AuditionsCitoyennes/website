-- Map phase 1, second migration: where each audition is, stored on its row,
-- so that the server can count, filter and frame by place without geocoding
-- on every read.
--
-- geo_units: the units auditions are filed under, and only those some row
-- references. Countries by ISO 3166-1 alpha-2 (FR, overseas France included),
-- France below them as fr:reg:<INSEE>, fr:dep:<INSEE>, fr:com:<INSEE> (Paris,
-- Lyon and Marseille arrondissements under their commune), elsewhere Overture
-- division ids. An id is never updated: a remap inserts the new unit, repoints
-- the rows that name the old one (leaf and path in one row update) and then
-- deletes it. Hence no ON UPDATE CASCADE: it would rewrite place_unit alone,
-- which the path CHECK below rejects. Server only: RLS on, no policy, nothing
-- granted to anon or authenticated.
--
-- auditions gains eleven nullable columns, written by the API, the backfill
-- and the seed (the old app, still live on this database, writes location
-- only):
--   place_unit        the leaf unit (geo_units);
--   place_path        root to leaf inclusive, {FR,fr:reg:84,fr:dep:69,fr:com:69123,fr:com:69387};
--   locality_id       the municipality-level unit: the commune of an arrondissement;
--   lieu_key          the lieu's name as lieux are grouped: getCanonicalLocation(location)
--                     in France, the town-hall label online, normalizeLocation(location)
--                     for a pick abroad;
--   lat, lng          the lieu's point;
--   place_precision   address | commune | locality | departement | region | country | unplaced;
--   place_candidates  the same-named communes involved, settled or not;
--   placed_location   the location the placement was computed from;
--   placed_rules      a hash of LOCATION_RULES at placement;
--   geo_release       the units' release (geoapi-2026, an Overture release);
-- and two stored generated columns, which call no custom function (a writer
-- needs no EXECUTE for them):
--   place_stale       placed_location is distinct from location: never placed (an
--                     old-app insert), or relocated since; the API re-places it;
--   lieu_id           'l:' and 16 hex of md5(place_unit, lieu_key): the lieu's id.
--
-- A row is never placed (placed_location NULL, so stale), placed (path and point
-- set, placed_location = location), or unplaced after an attempt (no path,
-- place_precision 'unplaced', placed_location = location).
--
-- placement_support() counts, per département, the lieux that settle the
-- homonyms of a new one. submit_online_testimony takes the bucket's place:
-- seven arguments, defaulted so that the eleven-argument call of older API
-- builds still resolves (its bucket is born stale, and placed by the first
-- call that brings them). A place that is partial or refused never costs the
-- testimony: the bucket is filed stale instead.
set lock_timeout = '200ms';

create table public.geo_units (
  id          text primary key,
  parent_id   text references public.geo_units (id),
  level       text not null
              check (level in ('country', 'dependency', 'region', 'county', 'localadmin', 'locality')),
  country     text not null check (country ~ '^[A-Z]{2}$'),
  -- The French label where the source has one ("Lyon 7e").
  name        text not null,
  -- INSEE in France; ISO 3166-2 for an Overture region when known.
  code        text,
  -- The label point, when known.
  lat         double precision,
  lng         double precision,
  -- Whether a tile polygon exists: phase 2 lights the nearest ancestor that has one.
  polygon     boolean not null default true,
  wikidata    text,
  source      text not null check (source in ('insee', 'overture')),
  -- 'geoapi-2026' | '2026-10-21.0'
  geo_release text not null,
  updated_at  timestamptz not null default now(),
  constraint geo_units_root check ((parent_id is null) = (level in ('country', 'dependency')))
);

alter table public.geo_units enable row level security;
revoke all on table public.geo_units from public, anon, authenticated;
grant select, insert, update, delete on table public.geo_units to service_role;

create index geo_units_parent_idx on public.geo_units (parent_id);

-- Every column nullable without a default: only the two generated ones rewrite
-- the table (about 64 rows on prod).
alter table public.auditions
  add column place_unit text references public.geo_units (id) on delete restrict,
  add column place_path text[],
  add column locality_id text,
  add column lieu_key text,
  add column lat double precision,
  add column lng double precision,
  add column place_precision text,
  add column place_candidates jsonb,
  add column placed_location text,
  add column placed_rules text,
  add column geo_release text,
  add column place_stale boolean generated always as (placed_location is distinct from location) stored,
  add column lieu_id text generated always as (
    case when place_unit is not null and lieu_key is not null
         then 'l:' || left(md5(place_unit || chr(31) || lieu_key), 16) end) stored,
  add constraint auditions_place_precision check (place_precision in
    ('address', 'commune', 'locality', 'departement', 'region', 'country', 'unplaced')),
  add constraint auditions_place_point check ((lat is null) = (lng is null)
    and (lat is null or (lat between -90 and 90 and lng between -180 and 180))),
  -- Leaf and path come together; the path is a plain list, root (a country)
  -- first, ending on the leaf. Written so that it is never NULL: a CHECK lets
  -- NULL through.
  add constraint auditions_place_path check ((place_path is null) = (place_unit is null)
    and (place_path is null or (
      pg_catalog.array_ndims(place_path) = 1
      and pg_catalog.array_lower(place_path, 1) = 1
      and pg_catalog.cardinality(place_path) between 1 and 8
      and pg_catalog.array_position(place_path, null) is null
      and place_path[pg_catalog.cardinality(place_path)] = place_unit
      and place_path[1] ~ '^[A-Z]{2}$'))),
  add constraint auditions_place_placed check
    ((place_precision is null or place_precision = 'unplaced') = (place_path is null)),
  add constraint auditions_place_lieu check
    (place_path is null or (lieu_key is not null and lat is not null));

-- The children of a unit, and the rows under it.
create index auditions_place_path_idx on public.auditions using gin (place_path)
  where status = 'published';
create index auditions_lieu_id_idx on public.auditions (lieu_id)
  where status = 'published';
-- Reusing the placement of a lieu already placed under the same name.
create index auditions_lieu_key_idx on public.auditions (lieu_key)
  where place_path is not null and not audition_en_ligne;
-- The re-placement job's queue, oldest first.
create index auditions_stale_idx on public.auditions (created_at)
  where place_stale;

-- Homonym support from the stored rows: per département, the distinct lieux of
-- published offline auditions placed without any homonym involved (the
-- settleHomonyms rule). A placement reused from a homonym copies its
-- place_candidates, so it never counts. Nor does a stale row: settleHomonyms
-- counts lieux under their current names, and a row relocated since its
-- placement still holds the old one until the API re-places it.
create function public.placement_support() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_object_agg(dep, n), '{}') from (
    select pg_catalog.split_part(p, ':', 3) as dep, count(distinct a.lieu_key) as n
      from public.auditions a cross join lateral pg_catalog.unnest(a.place_path) as p
     where a.status = 'published' and not a.audition_en_ligne and a.place_candidates is null
       and a.place_path is not null and not a.place_stale and p like 'fr:dep:%'
     group by 1) s
$$;
revoke all on function public.placement_support() from public, anon, authenticated;
grant execute on function public.placement_support() to service_role;

-- The baseline's function, same body, plus the place of the bucket. Dropped
-- and created again: two overloads, one with defaults, would make the
-- eleven-argument call ambiguous.
drop function public.submit_online_testimony(
  text, text, text, text, text, text, jsonb, date, text, text, uuid
);

create function public.submit_online_testimony(
  p_email_hash text, p_person_name text, p_person_info text, p_content text, p_citycode text,
  p_location text, p_place jsonb, p_month date, p_title text, p_audition_content text, p_token uuid,
  p_place_unit text default null, p_place_path text[] default null, p_locality_id text default null,
  p_lat double precision default null, p_lng double precision default null,
  p_place_precision text default null, p_geo_release text default null
) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_last timestamptz;
  v_audition uuid;
  v_created boolean := false;
  v_testimony uuid := gen_random_uuid();
  -- The bucket's place comes with every argument a placed row needs, or not at all.
  v_place boolean := p_place_unit is not null and p_place_path is not null
    and p_place_precision is not null and p_lat is not null and p_lng is not null;
begin
  -- One submission per email at a time: the quota check and the insert below
  -- cannot interleave with another request for the same address.
  perform pg_advisory_xact_lock(hashtextextended('online-testimony:' || p_email_hash, 0));

  -- Only testimonies that still exist count: one deleted — from its own
  -- email link, by its author — frees the week again.
  select max(created_at) into v_last
  from public.online_testimony_submissions
  where email_hash = p_email_hash
    and testimony_id is not null
    and created_at > now() - interval '7 days';
  if v_last is not null then
    -- PT429: PostgREST answers 429; the detail is when the next one is allowed.
    raise exception 'weekly_limit'
      using errcode = 'PT429', detail = to_char((v_last + interval '7 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;

  -- Housekeeping, before anything is locked. Links expire after 14 days: what
  -- was never verified goes (and an audition it leaves empty, with it).
  -- Online auditions found empty a month later go too — those left so before
  -- auditions went with their last testimony.
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

  -- The bucket's place, under its own label: a new bucket takes it here, in
  -- the transaction that creates it; one filed without it (by an older API
  -- build) gets it from the first call that brings it; a placed one keeps its
  -- own. A place the table refuses leaves the bucket stale, for the API to
  -- re-place: the testimony is filed all the same.
  if v_place then
    begin
      update public.auditions
         set place_unit = p_place_unit, place_path = p_place_path, locality_id = p_locality_id,
             lieu_key = location, lat = p_lat, lng = p_lng, place_precision = p_place_precision,
             placed_location = location, geo_release = p_geo_release
       where id = v_audition and place_path is null;
    exception when check_violation or foreign_key_violation then
      null;
    end;
  end if;

  insert into public.testimonies
    (id, audition_id, person_name, person_info, content, email, verification_status, verification_token, created_by)
  values
    (v_testimony, v_audition, p_person_name, p_person_info, p_content, null, 'pending', p_token, null);

  insert into public.online_testimony_submissions (testimony_id, email_hash)
  values (v_testimony, p_email_hash);

  -- And the quota forgets an address once its week is over. Last, and never
  -- waiting: a row someone else holds (a testimony being deleted clears its
  -- testimony_id) is purged next time.
  delete from public.online_testimony_submissions
  where id in (
    select id from public.online_testimony_submissions
    where created_at < now() - interval '8 days'
    for update skip locked
  );

  return jsonb_build_object(
    'testimony_id', v_testimony,
    'audition_id', v_audition,
    'audition_created', v_created
  );
end;
$$;

-- The server alone (service role) files online testimonies, as before.
revoke all on function public.submit_online_testimony(
  text, text, text, text, text, text, jsonb, date, text, text, uuid,
  text, text[], text, double precision, double precision, text, text
) from public, anon, authenticated;
grant execute on function public.submit_online_testimony(
  text, text, text, text, text, text, jsonb, date, text, text, uuid,
  text, text[], text, double precision, double precision, text, text
) to service_role;
