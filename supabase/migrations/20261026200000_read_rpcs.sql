-- Map phase 1, fourth migration: the reads the Témoignages map and the admin
-- list make of the place columns, as functions only the API calls (with the
-- service role). Each returns one jsonb, so PostgREST's max_rows never cuts
-- it; each builds its SQL from fixed fragments for the filters that are on
-- and binds their values (EXECUTE … USING): no visitor text is ever spliced
-- into a statement, and the planner sees the values, so the trigram, facts
-- and place_path indexes serve them.
--
--   place_counts         a unit's subtree: its units and lieux with their
--                        counts, rank and point box; all of it at once when
--                        it holds at most p_budget units plus lieux (then
--                        with every unit's analyses figures and every lieu's
--                        auditions); place_counts_many, up to 20 units;
--   lieu_auditions       a lieu's matching auditions;
--   audition_results     every matching placed audition, keyset pages,
--                        with the total and the frame on the first one;
--   testimony_page       an audition's matching testimonies, keyset pages;
--   place_facets         the theme picker's counts and the date bounds;
--   admin_audition_filter  per audition, its testimonies passing the
--                        content filters with and without the text; theme
--                        counts over the auditions an admin may open.
--
-- What the public sees, restated in every public read (never left to RLS,
-- which neither hides drafts nor is cheap): an audition counts when it is
-- published; a testimony when its audition is published and, for an online
-- audition, once verified. A placed audition is on the map when it is
-- published and, online, holds a verified testimony. Drafts' testimonies
-- count nowhere public (design D1). The admin filter sees every status.
--
-- Floats print exactly (shortest round trip), whatever the session's
-- extra_float_digits (the local stack's is 0: 15 digits, which would round
-- the computed frame).
--
-- Orders and ties (design A18): a lieu's rank is the date of its newest
-- audition on the map (unfiltered), its point and city that audition's;
-- a unit's rank the newest of its matching lieux. Children come by
-- testimonies desc, rank desc, id; results by date, rank desc, lieu id, id;
-- a lieu's auditions by date, id; testimonies oldest first (no date first),
-- id desc. Ids compare byte-wise (collate "C").
--
-- Lastly the service role gets its own statement timeout, 5 s, under the
-- API's 7 s abort: through PostgREST it otherwise inherits authenticator's
-- 8 s, and a query cut by the API's abort would run on.
set lock_timeout = '200ms';

-- ---- Filters -----------------------------------------------------------------

-- The filters the API sends, typed. Field order is the binding order of the
-- statements below: mask $1, "like" $2, from_date $3, to_date $4, units $5,
-- lieux $6 (verified is a fixed fragment, not a value).
create type ac.filters as (
  mask integer,
  "like" text,
  from_date date,
  to_date date,
  units text[],
  lieux text[],
  verified boolean
);

-- A unit id: a country (ISO 3166-1), France's régions, départements and
-- communes (INSEE), an Overture division elsewhere.
create function ac.unit_id_ok(p text) returns boolean
language sql immutable parallel safe set search_path = ''
return p ~ '^([A-Z]{2}|fr:(reg|dep|com):[0-9AB]{2,5}|[0-9a-f-]{32,36})$';

create function ac.lieu_id_ok(p text) returns boolean
language sql immutable parallel safe set search_path = ''
return p ~ '^l:[0-9a-f]{16}$';

-- A date filter: 'YYYY-MM-DD', a real day.
create function ac.read_date(p jsonb, p_name text) returns date
language plpgsql stable parallel safe set search_path = '' as $$
begin
  if pg_catalog.jsonb_typeof(p) <> 'string' or (p #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'filters: % must be a YYYY-MM-DD date', p_name using errcode = '22023';
  end if;
  return (p #>> '{}')::date;
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception 'filters: % is no such day', p_name using errcode = '22023';
end $$;

-- An id list: 1 to 50 strings; empty is no filter (null).
create function ac.read_ids(p jsonb, p_name text) returns text[]
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  v_list text[];
begin
  if pg_catalog.jsonb_typeof(p) <> 'array'
     or exists (select 1 from pg_catalog.jsonb_array_elements(p) as e
                 where pg_catalog.jsonb_typeof(e) <> 'string') then
    raise exception 'filters: % must be an array of strings', p_name using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p) > 50 then
    raise exception 'filters: at most 50 %', p_name using errcode = '22023';
  end if;
  select pg_catalog.array_agg(e) into v_list from pg_catalog.jsonb_array_elements_text(p) as e;
  return v_list;
end $$;

-- {"verified":true,"mask":1234,"like":"%clim%","from":"2025-01-01","to":"2025-12-31",
--  "units":["fr:dep:69"],"lieux":["l:3fa…"]}, every key optional. A filter that
-- filters nothing (false, mask 0, an empty list) is no filter. Raises 22023
-- on anything else.
create function ac.read_filters(p jsonb) returns ac.filters
language plpgsql stable parallel safe set search_path = '' as $$
declare
  f ac.filters;
  v_key text;
  v_num numeric;
  v_list text[];
begin
  if p is null or pg_catalog.jsonb_typeof(p) = 'null' then
    return f;
  end if;
  if pg_catalog.jsonb_typeof(p) <> 'object' then
    raise exception 'filters: a JSON object expected' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p) loop
    if v_key not in ('verified', 'mask', 'like', 'from', 'to', 'units', 'lieux') then
      raise exception 'filters: unknown key %', v_key using errcode = '22023';
    end if;
  end loop;

  if p ? 'verified' then
    if pg_catalog.jsonb_typeof(p -> 'verified') <> 'boolean' then
      raise exception 'filters: verified must be a boolean' using errcode = '22023';
    end if;
    f.verified := nullif((p ->> 'verified')::boolean, false);
  end if;

  if p ? 'mask' then
    if pg_catalog.jsonb_typeof(p -> 'mask') <> 'number' then
      raise exception 'filters: mask must be a number' using errcode = '22023';
    end if;
    v_num := (p ->> 'mask')::numeric;
    if v_num <> pg_catalog.trunc(v_num) or v_num < 0 or v_num > 65535 then
      raise exception 'filters: mask must be an integer in 0..65535' using errcode = '22023';
    end if;
    f.mask := nullif(v_num::integer, 0);
  end if;

  if p ? 'like' then
    if pg_catalog.jsonb_typeof(p -> 'like') <> 'string'
       or pg_catalog.length(p ->> 'like') not between 1 and 404 then
      raise exception 'filters: like must be a string of 1 to 404 characters' using errcode = '22023';
    end if;
    f."like" := p ->> 'like';
  end if;

  if p ? 'from' then
    f.from_date := ac.read_date(p -> 'from', 'from');
  end if;
  if p ? 'to' then
    f.to_date := ac.read_date(p -> 'to', 'to');
  end if;

  if p ? 'units' then
    v_list := ac.read_ids(p -> 'units', 'units');
    if exists (select 1 from pg_catalog.unnest(v_list) as u where not ac.unit_id_ok(u)) then
      raise exception 'filters: malformed unit id' using errcode = '22023';
    end if;
    f.units := v_list;
  end if;
  if p ? 'lieux' then
    v_list := ac.read_ids(p -> 'lieux', 'lieux');
    if exists (select 1 from pg_catalog.unnest(v_list) as l where not ac.lieu_id_ok(l)) then
      raise exception 'filters: malformed lieu id' using errcode = '22023';
    end if;
    f.lieux := v_list;
  end if;
  return f;
end $$;

-- The predicates of the filters that are on, over testimonies t joined to
-- their audition a, each value bound at its place ($1..$6). Today's
-- semantics (packages/shared/src/filters.ts passesContent, passesDate; the
-- place filter on the audition's units or lieu): verified only; any of the
-- themes picked; the folded text found in search_text (the API sends
-- '%' || escaped needle || '%'); the audition's date within the range.
create function ac.filter_sql(f ac.filters) returns text
language plpgsql immutable parallel safe set search_path = '' as $$
declare
  s text := '';
begin
  if f.verified then
    s := s || ' and t.verification_status = ''verified''';
  end if;
  if f.mask is not null then
    s := s || ' and (t.theme_mask & $1) <> 0';
  end if;
  if f."like" is not null then
    s := s || ' and t.search_text like $2';
  end if;
  if f.from_date is not null then
    s := s || ' and a."date" >= $3';
  end if;
  if f.to_date is not null then
    s := s || ' and a."date" <= $4';
  end if;
  if f.units is not null and f.lieux is not null then
    s := s || ' and (a.place_path && $5 or a.lieu_id = any ($6))';
  elsif f.units is not null then
    s := s || ' and a.place_path && $5';
  elsif f.lieux is not null then
    s := s || ' and a.lieu_id = any ($6)';
  end if;
  return s;
end $$;

-- auditionCohort() of packages/shared/src/auditions.ts, as an expression over
-- a title and a location (column expressions of the caller, never visitor
-- text): the archive (a generic location, GENERIC_LOCATION of locations.ts),
-- the 2019 cahiers (by title), else met in the street. Case-insensitive as the
-- browser's /i is, whatever the database's ctype. Spliced into the statement
-- rather than called: a function (with its search_path) per member row cost
-- more than the rest of the facts together (16 µs a row, measured).
create function ac.cohort_sql(p_title text, p_location text) returns text
language sql immutable parallel safe set search_path = ''
return pg_catalog.format($f$(case
  when pg_catalog.lower(ac.js_trim(%2$s) collate pg_catalog."und-x-icu")
       in ('france', 'métropole', 'metropole', 'en ligne', 'internet', 'divers', 'inconnu') then 'archive'
  when pg_catalog.lower(ac.js_trim(%1$s) collate pg_catalog."und-x-icu") ~ '^cahiers? de doléances' then 'cahier2019'
  else 'terrain'
end)$f$, p_title, p_location);

-- p_template once per theme, comma-separated: %1$s is the theme's number
-- (1..16, AUDITION_THEMES order), %2$s its bit in theme_mask.
create function ac.sql_16(p_template text) returns text
language sql immutable parallel safe set search_path = ''
return (select pg_catalog.string_agg(pg_catalog.format(p_template, i, 1 << (i - 1)), ', ' order by i)
          from pg_catalog.generate_series(1, 16) as i);

-- ---- place_counts --------------------------------------------------------------

-- A unit's subtree under the filters ('world': everything), in one jsonb:
--
--   unit, complete;
--   self      {n, auditions, rank, bbox[, facts]}: over placed rows only;
--   unplaced  {n, auditions} (world only): the published auditions on no
--             point, so that N résultats = self.n + unplaced.n;
--   units     [{id, parent, level, name, code, country, polygon, d, n, auditions,
--              rank, bbox, wrap[, facts]}], d levels below the unit;
--   lieux     [{id, unit, key, city, lat, lng, precision, n, auditions, rank[, list]}].
--
-- Members are the auditions with at least one matching testimony (p_empty:
-- every audition on the map, testimonies or not, unfiltered: the home card,
-- the place picker). bbox = [min lat, min lng, max lat, max lng] of the lieu
-- points, which the client pads as it pads a point; wrap when it spans more
-- than half the globe.
--
-- complete: the whole subtree is there (at most p_budget units plus lieux),
-- with, when p_facts, every unit's analyses figures, and every lieu's
-- auditions as [id, title, date, n] newest first. Else the units p_depth
-- levels down, the lieux of the unit and of the levels above the last, and
-- with p_facts the figures of the unit and of its children.
--
-- Facts mirror buildUnitStats/analyseScope (apps/web/src/features/analyses/
-- stats/scopeStats.ts): testimonies, auditions, lieux, communes (the
-- municipality: arrondissements roll up), cohorts [terrain, cahier2019,
-- archive], themes[16] and themeAuditions[16], themeBase, untagged, approx,
-- first and last real date (street auditions), and the largest audition
-- [id, lieu id, lieu key, n, lieu city].
create function public.place_counts(
  p_unit text default 'world',
  p_filters jsonb default '{}',
  p_depth integer default 2,
  p_facts boolean default false,
  p_budget integer default 600,
  p_empty boolean default false
) returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare
  f ac.filters := ac.read_filters(p_filters);
  v_where text := ac.filter_sql(f);
  v_facts boolean := coalesce(p_facts, false);
  v_empty boolean := coalesce(p_empty, false);
  v_fact_sql text;
  v_tally_sql text;
  v_out jsonb;
begin
  if p_unit is null or not (p_unit = 'world' or ac.unit_id_ok(p_unit)) then
    raise exception 'place_counts: malformed unit %', p_unit using errcode = '22023';
  end if;
  if p_depth is null or p_depth not between 1 and 3 then
    raise exception 'place_counts: depth must be 1..3' using errcode = '22023';
  end if;
  if p_budget is null or p_budget not between 0 and 2000 then
    raise exception 'place_counts: budget must be 0..2000' using errcode = '22023';
  end if;
  if v_empty and v_where <> '' then
    raise exception 'place_counts: empty takes no filters' using errcode = '22023';
  end if;

  -- Per audition, what the facts add up (only when they are asked for).
  v_tally_sql := case when v_facts then pg_catalog.format(
    $f$, count(*) filter (where t.theme_mask <> 0)::integer as base,
         count(*) filter (where t.untagged)::integer as untagged,
         count(*) filter (where t.themes_approx)::integer as approx,
         array[%s]::integer[] as th$f$,
    ac.sql_16('count(*) filter (where (t.theme_mask & %2$s) <> 0)'))
  else ', 0 as base, 0 as untagged, 0 as approx, null::integer[] as th' end;

  -- A set of member rows' figures (the rows of one unit, or the whole subtree).
  v_fact_sql := pg_catalog.format(
    $f$pg_catalog.jsonb_build_object(
      'testimonies', coalesce(sum(n), 0),
      'auditions', count(*) filter (where n > 0),
      'lieux', count(distinct lieu_id) filter (where n > 0),
      'communes', count(distinct locality_id) filter (where n > 0),
      'cohorts', pg_catalog.jsonb_build_array(
        coalesce(sum(n) filter (where cohort = 'terrain'), 0),
        coalesce(sum(n) filter (where cohort = 'cahier2019'), 0),
        coalesce(sum(n) filter (where cohort = 'archive'), 0)),
      'themes', pg_catalog.jsonb_build_array(%s),
      'themeAuditions', pg_catalog.jsonb_build_array(%s),
      'themeBase', coalesce(sum(base), 0),
      'untagged', coalesce(sum(untagged), 0),
      'approx', coalesce(sum(approx), 0),
      'first', min("date") filter (where cohort = 'terrain' and n > 0),
      'last', max("date") filter (where cohort = 'terrain' and n > 0),
      'largest', (pg_catalog.array_agg(pg_catalog.jsonb_build_array(id, lieu_id, lieu_key, n, pcity)
                    order by n desc, rank desc, lieu_id collate "C", "date" desc, id)
                  filter (where n > 0))[1])$f$,
    ac.sql_16('coalesce(sum(th[%1$s]), 0)'),
    ac.sql_16('count(*) filter (where th[%1$s] > 0)'));

  execute pg_catalog.format($q$
    with
    -- What the map shows, unfiltered: published and placed; online once it
    -- holds a verified testimony. k: where the unit sits on the path (0: world).
    vis as (
      select a.id, a.title, a."date", a.location, a.lieu_id, a.place_unit, a.place_path,
             a.locality_id, a.lieu_key, a.lat, a.lng, a.place_precision,
             case when a.audition_en_ligne then a.place ->> 'commune' else lc.name end as city,
             coalesce(pg_catalog.array_position(a.place_path, $7), 0) as k
        from public.auditions a
        left join public.geo_units lc on lc.id = a.locality_id
       where a.status = 'published' and a.place_path is not null
         and ($7 = 'world' or a.place_path @> array[$7])
         and (not a.audition_en_ligne or exists (
               select 1 from public.testimonies v
                where v.audition_id = a.id and v.verification_status = 'verified'))),
    -- Each lieu's newest audition: its rank, point, city and precision.
    lmd as (
      select distinct on (lieu_id) lieu_id, "date" as rank, lat as plat, lng as plng,
             city as pcity, place_precision as pprec
        from vis
       order by lieu_id, "date" desc, id),
    -- Matching public testimonies per audition (the facts index alone).
    m as (
      select t.audition_id, count(*)::integer as n %3$s
        from public.testimonies t
        join public.auditions a on a.id = t.audition_id
       where a.status = 'published'
         and (not a.audition_en_ligne or t.verification_status = 'verified')
         and ($7 = 'world' or a.place_path @> array[$7])
         %1$s
       group by t.audition_id),
    -- The members: auditions on the map with a matching testimony (or all, $11).
    s as (
      select vis.*, lmd.rank, lmd.plat, lmd.plng, lmd.pcity, lmd.pprec,
             coalesce(m.n, 0) as n, m.base, m.untagged, m.approx, m.th,
             case when $10 then %4$s end as cohort
        from vis
        join lmd using (lieu_id)
        left join m on m.audition_id = vis.id
       where m.n > 0 or $11),
    -- One row per member and unit below the unit, d levels down.
    u as (
      select x.unit, x.d::integer as d, s.id, s."date", s.n, s.rank, s.plat, s.plng, s.pcity,
             s.lieu_id, s.lieu_key, s.locality_id, s.cohort, s.base, s.untagged, s.approx, s.th
        from s
       cross join lateral pg_catalog.unnest(s.place_path[s.k + 1 :]) with ordinality as x(unit, d)),
    -- The whole subtree when it fits the budget (depth 99), else p_depth levels.
    lim as (
      select case when (select count(distinct lieu_id) from s) > $9 then $8
                  when (select count(distinct unit) from u) + (select count(distinct lieu_id) from s) <= $9
                  then 99 else $8 end as depth)
    select pg_catalog.jsonb_build_object(
      'unit', $7,
      'complete', (select depth from lim) = 99,
      'self', (
        select pg_catalog.jsonb_build_object(
                 'n', coalesce(sum(n), 0), 'auditions', count(*) filter (where n > 0),
                 'rank', max(rank),
                 'bbox', case when count(*) > 0 then pg_catalog.jsonb_build_array(
                           min(plat), min(plng), max(plat), max(plng)) end)
               || case when $10 and $7 <> 'world'
                       then pg_catalog.jsonb_build_object('facts', %2$s) else '{}'::jsonb end
          from s),
      'units', coalesce((
        select pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'id', r.id, 'parent', g.parent_id, 'level', g.level, 'name', g.name,
                   'code', g.code, 'country', g.country, 'polygon', g.polygon, 'd', r.d,
                   'n', r.n, 'auditions', r.auditions, 'rank', r.rank,
                   'bbox', pg_catalog.jsonb_build_array(r.min_lat, r.min_lng, r.max_lat, r.max_lng),
                   'wrap', (r.max_lng - r.min_lng) > 180)
                 || case when f.facts is not null
                         then pg_catalog.jsonb_build_object('facts', f.facts) else '{}'::jsonb end
                 order by r.n desc, r.rank desc, r.id collate "C")
          from (
            select u.unit as id, min(u.d) as d, sum(u.n)::integer as n,
                   count(*) filter (where u.n > 0)::integer as auditions, max(u.rank) as rank,
                   min(u.plat) as min_lat, min(u.plng) as min_lng,
                   max(u.plat) as max_lat, max(u.plng) as max_lng
              from u
             where u.d <= (select depth from lim)
             group by u.unit) r
          join public.geo_units g on g.id = r.id
          -- The figures only where they are sent: every unit of a complete
          -- answer, else the children.
          left join (
            select u.unit, %2$s as facts
              from u
             where $10 and (u.d = 1 or (select depth from lim) = 99)
             group by u.unit) f on f.unit = r.id), '[]'::jsonb),
      'lieux', coalesce((
        select pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'id', l.lieu_id, 'unit', l.place_unit, 'key', l.lieu_key, 'city', l.pcity,
                   'lat', l.plat, 'lng', l.plng, 'precision', l.pprec, 'n', l.n,
                   'auditions', l.auditions, 'rank', l.rank)
                 || case when (select depth from lim) = 99
                         then pg_catalog.jsonb_build_object('list', l.list) else '{}'::jsonb end
                 order by l.n desc, l.rank desc, l.lieu_id collate "C")
          from (
            select lieu_id, place_unit, lieu_key, pcity, plat, plng, pprec, rank,
                   sum(n)::integer as n, count(*) filter (where n > 0)::integer as auditions,
                   pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(id, title, "date", n)
                                        order by "date" desc, id) as list
              from s
             where pg_catalog.cardinality(place_path) - k between 0 and (select depth from lim) - 1
             group by lieu_id, place_unit, lieu_key, pcity, plat, plng, pprec, rank) l), '[]'::jsonb))
      || case when $7 = 'world' then pg_catalog.jsonb_build_object('unplaced', (
           select pg_catalog.jsonb_build_object('n', coalesce(sum(m.n), 0), 'auditions', count(*))
             from m join public.auditions a on a.id = m.audition_id
            where a.place_path is null)) else '{}'::jsonb end
    $q$, v_where, v_fact_sql, v_tally_sql, ac.cohort_sql('vis.title', 'vis.location'))
  into v_out
  using f.mask, f."like", f.from_date, f.to_date, f.units, f.lieux,
        p_unit, p_depth, p_budget, v_facts, v_empty;
  return v_out;
end $$;

-- place_counts for 1 to 20 units, in their order: one round trip for a drill
-- step (the API splits larger requests).
create function public.place_counts_many(
  p_units text[],
  p_filters jsonb default '{}',
  p_depth integer default 2,
  p_facts boolean default false,
  p_budget integer default 600,
  p_empty boolean default false
) returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
begin
  if p_units is null or pg_catalog.cardinality(p_units) not between 1 and 20 then
    raise exception 'place_counts_many: 1 to 20 units' using errcode = '22023';
  end if;
  return (
    select pg_catalog.jsonb_agg(
             public.place_counts(x.unit, p_filters, p_depth, p_facts, p_budget, p_empty)
             order by x.i)
      from pg_catalog.unnest(p_units) with ordinality as x(unit, i));
end $$;

-- ---- lieu_auditions ------------------------------------------------------------

-- A lieu's auditions with a matching testimony, {id, title, date, n}, by date
-- (p_sort: 'recent' newest first, 'ancien' oldest first), then id; and the
-- lieu {id, unit, key, path, lat, lng, city} as its newest audition places it
-- (null: no such lieu on the map).
create function public.lieu_auditions(
  p_lieu text,
  p_filters jsonb default '{}',
  p_sort text default 'recent'
) returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare
  f ac.filters := ac.read_filters(p_filters);
  v_out jsonb;
begin
  if p_lieu is null or not ac.lieu_id_ok(p_lieu) then
    raise exception 'lieu_auditions: malformed lieu %', p_lieu using errcode = '22023';
  end if;
  if p_sort is null or p_sort not in ('recent', 'ancien') then
    raise exception 'lieu_auditions: sort must be recent or ancien' using errcode = '22023';
  end if;

  execute pg_catalog.format($q$
    with
    vis as (
      select a.id, a.title, a."date", a.place_unit, a.place_path, a.lieu_key, a.lat, a.lng,
             case when a.audition_en_ligne then a.place ->> 'commune' else lc.name end as city
        from public.auditions a
        left join public.geo_units lc on lc.id = a.locality_id
       where a.status = 'published' and a.lieu_id = $7 and a.place_path is not null
         and (not a.audition_en_ligne or exists (
               select 1 from public.testimonies v
                where v.audition_id = a.id and v.verification_status = 'verified'))),
    m as (
      select t.audition_id, count(*)::integer as n
        from public.testimonies t
        join public.auditions a on a.id = t.audition_id
       where a.status = 'published' and a.lieu_id = $7
         and (not a.audition_en_ligne or t.verification_status = 'verified')
         %1$s
       group by t.audition_id)
    select pg_catalog.jsonb_build_object(
      'lieu', (
        select pg_catalog.jsonb_build_object(
                 'id', $7, 'unit', v.place_unit, 'key', v.lieu_key, 'path', v.place_path,
                 'lat', v.lat, 'lng', v.lng, 'city', v.city)
          from vis v order by v."date" desc, v.id limit 1),
      'auditions', coalesce((
        select pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object('id', v.id, 'title', v.title, 'date', v."date", 'n', m.n)
                 order by v."date" %2$s, v.id)
          from vis v join m on m.audition_id = v.id), '[]'::jsonb))
    $q$, ac.filter_sql(f), case p_sort when 'ancien' then 'asc' else 'desc' end)
  into v_out
  using f.mask, f."like", f.from_date, f.to_date, f.units, f.lieux, p_lieu;
  return v_out;
end $$;

-- ---- audition_results ----------------------------------------------------------

-- Every placed audition on the map with a matching testimony (no filter: all
-- of them), {id, title, date, n, lieu {id, key, unit, path, lat, lng, city}},
-- the lieu as its newest audition places it. Ordered by date (p_sort), rank
-- desc, lieu id, id; keyset pages of p_limit (1..100) after p_after = [date,
-- rank, lieu id, id], `next` the key to ask the following page with (null on
-- the last). The first page also carries `total` {auditions, lieux, n} and
-- `frame` [min lat, min lng, max lat, max lng]: resultBounds of
-- apps/web/src/features/geo-nav/model/auditions.ts over the lieux' points
-- (all but the outermost 3% on each side from 30 lieux, padded 8%, at least
-- 0.004°). p_through: the rows up to that audition (at most 2,000), and
-- throughFound; not found there, the first page and throughFound false.
create function public.audition_results(
  p_filters jsonb default '{}',
  p_sort text default 'recent',
  p_after jsonb default null,
  p_limit integer default 50,
  p_through uuid default null
) returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare
  f ac.filters := ac.read_filters(p_filters);
  v_dir text;
  v_cmp text;
  v_after_date date;
  v_after_rank date;
  v_after_lieu text;
  v_after_id uuid;
  v_out jsonb;
begin
  if p_sort is null or p_sort not in ('recent', 'ancien') then
    raise exception 'audition_results: sort must be recent or ancien' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'audition_results: limit must be 1..100' using errcode = '22023';
  end if;
  if p_after is not null and pg_catalog.jsonb_typeof(p_after) <> 'null' then
    if p_through is not null then
      raise exception 'audition_results: after and through do not go together' using errcode = '22023';
    end if;
    begin
      if pg_catalog.jsonb_typeof(p_after) <> 'array' or pg_catalog.jsonb_array_length(p_after) <> 4
         or (p_after ->> 0) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or (p_after ->> 1) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         or not ac.lieu_id_ok(p_after ->> 2) then
        raise exception 'malformed';
      end if;
      v_after_date := (p_after ->> 0)::date;
      v_after_rank := (p_after ->> 1)::date;
      v_after_lieu := p_after ->> 2;
      v_after_id := (p_after ->> 3)::uuid;
    exception when others then
      raise exception 'audition_results: after must be [date, rank, lieu id, id]' using errcode = '22023';
    end;
    if v_after_id is null then
      raise exception 'audition_results: after must be [date, rank, lieu id, id]' using errcode = '22023';
    end if;
  end if;
  v_dir := case p_sort when 'ancien' then 'asc' else 'desc' end;
  v_cmp := case p_sort when 'ancien' then '>' else '<' end;

  execute pg_catalog.format($q$
    with
    -- Matching placed public auditions, with their matching testimonies.
    hits as (
      select a.id, a.title, a."date", a.lieu_id, a.place_unit, a.place_path, a.lieu_key,
             count(*)::integer as n
        from public.testimonies t
        join public.auditions a on a.id = t.audition_id
       where a.status = 'published' and a.place_path is not null
         and (not a.audition_en_ligne or t.verification_status = 'verified')
         %1$s
       group by a.id),
    -- Their lieux' newest auditions on the map (unfiltered): rank, point, city.
    lmd as (
      select distinct on (a.lieu_id) a.lieu_id, a."date" as rank, a.lat, a.lng,
             case when a.audition_en_ligne then a.place ->> 'commune' else lc.name end as city
        from public.auditions a
        left join public.geo_units lc on lc.id = a.locality_id
       where a.status = 'published' and a.place_path is not null
         and a.lieu_id in (select lieu_id from hits)
         and (not a.audition_en_ligne or exists (
               select 1 from public.testimonies v
                where v.audition_id = a.id and v.verification_status = 'verified'))
       order by a.lieu_id, a."date" desc, a.id),
    r as (
      select h.*, l.rank, l.lat, l.lng, l.city,
             pg_catalog.row_number() over (
               order by h."date" %2$s, l.rank desc, h.lieu_id collate "C", h.id) as i
        from hits h join lmd l using (lieu_id)),
    -- The rows asked for: from the first up to p_through, or a page from the
    -- first or after p_after; and one more, when there is one (then `next`).
    upto as (select i from r where $12::uuid is not null and id = $12 and i <= 2000),
    take as (
      select case when $8::date is null then coalesce((select i from upto), $11) else $11 end as n),
    pg as (
      select r.*, pg_catalog.row_number() over (order by r.i) as j
        from r
       where case
               when $8::date is null then r.i <= (select n from take) + 1
               else (r."date" %3$s $8
                     or (r."date" = $8 and (r.rank < $9
                         or (r.rank = $9 and (r.lieu_id collate "C" > $10
                             or (r.lieu_id = $10 and r.id > $13))))))
             end),
    shown as (select * from pg where j <= (select n from take)),
    pts as (select lat, lng from lmd),
    cut as (
      select count(*)::integer as c,
             case when count(*) >= 30 then pg_catalog.floor(count(*)::float8 * 0.03::float8)::integer
                  else 0 end as k
        from pts),
    b as (
      select (select lat from pts order by lat offset (select k from cut) limit 1) as min_lat,
             (select lat from pts order by lat desc offset (select k from cut) limit 1) as max_lat,
             (select lng from pts order by lng offset (select k from cut) limit 1) as min_lng,
             (select lng from pts order by lng desc offset (select k from cut) limit 1) as max_lng),
    pad as (
      select b.*, greatest((max_lat - min_lat) * 0.08::float8, 0.004::float8) as pad_lat,
             greatest((max_lng - min_lng) * 0.08::float8, 0.004::float8) as pad_lng
        from b)
    select pg_catalog.jsonb_build_object(
      'auditions', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                 'id', s.id, 'title', s.title, 'date', s."date", 'n', s.n,
                 'lieu', pg_catalog.jsonb_build_object(
                   'id', s.lieu_id, 'key', s.lieu_key, 'unit', s.place_unit, 'path', s.place_path,
                   'lat', s.lat, 'lng', s.lng, 'city', s.city)) order by s.j)
          from shown s), '[]'::jsonb),
      'next', (
        select pg_catalog.jsonb_build_array(s."date", s.rank, s.lieu_id, s.id)
          from shown s
         where exists (select 1 from pg where pg.j > (select n from take))
         order by s.j desc limit 1))
      || case when $12::uuid is not null
              then pg_catalog.jsonb_build_object('throughFound', exists (select 1 from upto))
              else '{}'::jsonb end
      || case when $8::date is null then pg_catalog.jsonb_build_object(
           'total', (select pg_catalog.jsonb_build_object(
                              'auditions', count(*), 'lieux', count(distinct lieu_id),
                              'n', coalesce(sum(n), 0))
                       from hits),
           'frame', (select case when min_lat is not null then pg_catalog.jsonb_build_array(
                              min_lat - pad_lat, min_lng - pad_lng, max_lat + pad_lat, max_lng + pad_lng) end
                       from pad))
         else '{}'::jsonb end
    $q$, ac.filter_sql(f), v_dir, v_cmp)
  into v_out
  using f.mask, f."like", f.from_date, f.to_date, f.units, f.lieux,
        null::text, v_after_date, v_after_rank, v_after_lieu, p_limit, p_through, v_after_id;
  return v_out;
end $$;

-- ---- testimony_page ------------------------------------------------------------

-- An audition's public testimonies matching the filters, oldest first (no
-- date first), then id desc: the panel's order (groupOwnAuditions over the
-- corpus' created_at desc, id desc). Keyset pages of p_limit (1..100) after
-- p_after = [created_at or null, id]; `next` null on the last. The order is
-- the facts index's, from its prefix.
create function public.testimony_page(
  p_audition uuid,
  p_filters jsonb default '{}',
  p_after jsonb default null,
  p_limit integer default 50
) returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare
  f ac.filters := ac.read_filters(p_filters);
  v_after_at timestamptz;
  v_after_id uuid;
  v_out jsonb;
begin
  if p_audition is null then
    raise exception 'testimony_page: no audition' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'testimony_page: limit must be 1..100' using errcode = '22023';
  end if;
  if p_after is not null and pg_catalog.jsonb_typeof(p_after) <> 'null' then
    begin
      if pg_catalog.jsonb_typeof(p_after) <> 'array' or pg_catalog.jsonb_array_length(p_after) <> 2
         or pg_catalog.jsonb_typeof(p_after -> 0) not in ('string', 'null') then
        raise exception 'malformed';
      end if;
      v_after_at := coalesce((p_after ->> 0)::timestamptz, '-infinity'::timestamptz);
      v_after_id := (p_after ->> 1)::uuid;
    exception when others then
      raise exception 'testimony_page: after must be [created_at or null, id]' using errcode = '22023';
    end;
    if v_after_id is null then
      raise exception 'testimony_page: after must be [created_at or null, id]' using errcode = '22023';
    end if;
  end if;

  execute pg_catalog.format($q$
    with pg as (
      select t.id, t.audition_id, t.person_name, t.person_info, t.content, t.topics,
             t.verification_status, t.created_at
        from public.testimonies t
        join public.auditions a on a.id = t.audition_id
       where t.audition_id = $7 and a.status = 'published'
         and (not a.audition_en_ligne or t.verification_status = 'verified')
         %1$s
         and ($8::timestamptz is null
              or coalesce(t.created_at, '-infinity'::timestamptz) > $8
              or (coalesce(t.created_at, '-infinity'::timestamptz) = $8 and t.id < $9))
       order by coalesce(t.created_at, '-infinity'::timestamptz), t.id desc
       limit $10 + 1),
    numbered as (
      select pg.*, pg_catalog.row_number() over (
               order by coalesce(pg.created_at, '-infinity'::timestamptz), pg.id desc) as i
        from pg)
    select pg_catalog.jsonb_build_object(
      'testimonies', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) - 'i' order by x.i)
          from numbered x where x.i <= $10), '[]'::jsonb),
      'next', (
        select pg_catalog.jsonb_build_array(x.created_at, x.id)
          from numbered x where x.i = $10 and (select count(*) from numbered) > $10))
    $q$, ac.filter_sql(f))
  into v_out
  using f.mask, f."like", f.from_date, f.to_date, f.units, f.lieux,
        p_audition, v_after_at, v_after_id, p_limit;
  return v_out;
end $$;

-- ---- place_facets --------------------------------------------------------------

-- The filter dialog's bounds, unfiltered: themes [{i, n}], i the theme's
-- index in AUDITION_THEMES, n its public testimonies (published auditions,
-- placed or not), the most frequent first; dates [first, last] of the
-- auditions on the map (dateBoundsOf of the map's groups).
create function public.place_facets() returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare
  v_out jsonb;
begin
  execute pg_catalog.format($q$
    with
    th as (
      select array[%s]::integer[] as n
        from public.testimonies t
        join public.auditions a on a.id = t.audition_id
       where a.status = 'published'
         and (not a.audition_en_ligne or t.verification_status = 'verified')),
    vis as (
      select a."date"
        from public.auditions a
       where a.status = 'published' and a.place_path is not null
         and (not a.audition_en_ligne or exists (
               select 1 from public.testimonies v
                where v.audition_id = a.id and v.verification_status = 'verified')))
    select pg_catalog.jsonb_build_object(
      'themes', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('i', x.i - 1, 'n', x.n)
                                    order by x.n desc, x.i)
          from th cross join lateral pg_catalog.unnest(th.n) with ordinality as x(n, i)
         where x.n > 0), '[]'::jsonb),
      'dates', (select case when count(*) > 0
                            then pg_catalog.jsonb_build_array(min("date"), max("date")) end
                  from vis))
    $q$, ac.sql_16('count(*) filter (where (t.theme_mask & %2$s) <> 0)'))
  into v_out;
  return v_out;
end $$;

-- ---- admin_audition_filter -----------------------------------------------------

-- The admin list's content filters (verified, mask, like only), over every
-- testimony of every status as admins see them: per audition with a
-- testimony passing verified and themes, [n_all, n_no_text] — those passing
-- every filter, and those passing all but the text. The client keeps its
-- own test of the text in the audition's title, location and context
-- (useAuditionFilters' textInAudition): text only, an audition passes when
-- it holds the text or n_all > 0; verified or themes on, n_no_text > 0 when
-- it holds the text, else n_all > 0. themes: per theme, the testimonies of
-- the auditions the admin may open (p_reachable_by: those they created;
-- null, a super admin: all), for buildTopicOptions. Called after requireAdmin.
create function public.admin_audition_filter(
  p_filters jsonb default '{}',
  p_reachable_by uuid default null
) returns jsonb
language plpgsql stable security invoker set search_path = '' set extra_float_digits = 1 as $$
declare
  f ac.filters := ac.read_filters(p_filters);
  v_no_text ac.filters;
  v_out jsonb;
begin
  if p_filters is not null and pg_catalog.jsonb_typeof(p_filters) = 'object'
     and exists (select 1 from pg_catalog.jsonb_object_keys(p_filters) as k
                  where k not in ('verified', 'mask', 'like')) then
    raise exception 'admin_audition_filter: only verified, mask and like' using errcode = '22023';
  end if;
  v_no_text := f;
  v_no_text."like" := null;

  execute pg_catalog.format($q$
    select pg_catalog.jsonb_build_object(
      'matches', coalesce((
        select pg_catalog.jsonb_object_agg(x.audition_id, pg_catalog.jsonb_build_array(x.n_all, x.n_no_text))
          from (
            select t.audition_id,
                   count(*) filter (where true %1$s)::integer as n_all,
                   count(*) filter (where true %2$s)::integer as n_no_text
              from public.testimonies t
             where t.audition_id is not null
             group by t.audition_id
            having count(*) filter (where true %2$s) > 0) x), '{}'::jsonb),
      'themes', (
        select pg_catalog.jsonb_build_array(%3$s)
          from public.testimonies t
          join public.auditions a on a.id = t.audition_id
         where $7::uuid is null or a.created_by = $7))
    $q$, ac.filter_sql(f), ac.filter_sql(v_no_text),
    ac.sql_16('count(*) filter (where (t.theme_mask & %2$s) <> 0)'))
  into v_out
  using f.mask, f."like", f.from_date, f.to_date, f.units, f.lieux, p_reachable_by;
  return v_out;
end $$;

-- ---- Grants --------------------------------------------------------------------

-- The API alone, with the service role: never anon or authenticated.
revoke all on function public.place_counts(text, jsonb, integer, boolean, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.place_counts(text, jsonb, integer, boolean, integer, boolean)
  to service_role;
revoke all on function public.place_counts_many(text[], jsonb, integer, boolean, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.place_counts_many(text[], jsonb, integer, boolean, integer, boolean)
  to service_role;
revoke all on function public.lieu_auditions(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.lieu_auditions(text, jsonb, text) to service_role;
revoke all on function public.audition_results(jsonb, text, jsonb, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.audition_results(jsonb, text, jsonb, integer, uuid) to service_role;
revoke all on function public.testimony_page(uuid, jsonb, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.testimony_page(uuid, jsonb, jsonb, integer) to service_role;
revoke all on function public.place_facets() from public, anon, authenticated;
grant execute on function public.place_facets() to service_role;
revoke all on function public.admin_audition_filter(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.admin_audition_filter(jsonb, uuid) to service_role;

-- The service role's statements end after 5 s (57014), before the API's 7 s
-- abort: through PostgREST it would otherwise inherit authenticator's 8 s.
-- Its other users are the API's writes and the old app's registration
-- function, all single-row; migrations, backups and seed loads connect as
-- postgres. Refused (a hosted project that does not let postgres set it):
-- a notice, and the API's abort bounds the calls alone.
do $$
begin
  alter role service_role set statement_timeout = '5s';
exception when insufficient_privilege then
  raise notice 'service_role statement_timeout left as is: %', sqlerrm;
end $$;
-- PostgREST reads the roles' settings with its configuration.
notify pgrst, 'reload config';

-- The last two statements of every migration that creates functions in ac.
revoke all on all functions in schema ac from public, anon, authenticated;
grant execute on all functions in schema ac to service_role;
