// The database side of the parity harness: what the old endpoints served
// (read as they read it) and what the read RPCs answer, from the same rows.
//
// Every session starts with the same setup, in a transaction rolled back at
// its end, which gives the seed the cases it lacks:
//   - the analyses' other cohorts: two 2019 cahiers (by their title), an
//     archive (a generic location);
//   - keyset ties at a page boundary: an audition's testimonies sharing a
//     created_at, another's with none; two auditions of one lieu on one day;
//     two lieux of the same rank;
//   - which audition is a lieu's newest when two share its newest day (the
//     lower id: its tie, point and precision), in a lieu of the same count and
//     rank as a sibling lieu whose tie falls between the two, so that
//     unpublishing or moving the first between two result pages moves the
//     lieu past its sibling (copies of a seed audition, fixed ids);
//   - ties the tree breaks: sibling units of one count and one rank, and a
//     unit's largest audition shared by two lieux, each tie order against
//     the ids' (a département of the harness, '99');
//   - what the map hides next to what it shows: a draft and an online
//     audition nobody verified, in lieux on the map, newer than anything on
//     it and placed elsewhere (point, town);
//   - an old-app location edit (place_stale), left for the placement job;
//     the old app's online rows: an insert holding a verified testimony
//     (stale, unplaced) and a renamed one (stale, placed), copies of the
//     seed's online auditions;
//   - a draft with testimonies on no point (it must not add to `unplaced`);
//   - a plain admin (a fake auth user) owning the Lyon area's auditions, for
//     the admin list's theme options.

import { type LocationGroup, type PublicTestimony } from "@ac/shared";
import { groupsFromRows, type MapRow } from "../../apps/api/src/modules/places/groups";
import type { GeoUnitName } from "../../apps/api/src/modules/places/geoUnits";
import type { FilterableTestimony } from "./legacy/adminFilters";
import { lit, runSql, sqlJson } from "../db-checks/psql";

/** The plain admin of the harness (rolled back with everything else). */
export const PLAIN_ADMIN = "00000000-0000-4000-8000-00000000a11c";

/** A row the old app wrote or moved, as the server reads it. */
export interface StaleRow {
  id: string;
  location: string;
  /** Its stored lieu (null: unplaced). */
  lieu_key: string | null;
}

export interface Setup {
  sql: string;
  /** The rows the setup changed, by what they exercise. */
  edges: Record<string, string[]>;
  stale: StaleRow[];
}

// Placed, published, offline, not taken by an earlier edge.
const POOL = `a.status = 'published' and a.place_path is not null and not a.audition_en_ligne
     and a.id not in (select e.id from pg_temp.edges e)`;

const SETUP_SQL = `
create temp table edges (kind text, id uuid) on commit drop;

-- A copy of an audition under a fixed id, on another day (an online one's
-- town hall holds one audition a month), with its first p_testimonies
-- testimonies (all: null) under ids derived from theirs.
create function pg_temp.copy_audition(p_from uuid, p_id uuid, p_date date, p_testimonies integer default null)
returns void language plpgsql as $copy$
declare
  v_cols text;
  v_vals text;
begin
  select pg_catalog.string_agg(pg_catalog.quote_ident(attname), ', ' order by attnum),
         pg_catalog.string_agg(case attname when 'date' then '$3' else pg_catalog.quote_ident(attname) end,
                               ', ' order by attnum)
    into v_cols, v_vals
    from pg_catalog.pg_attribute
   where attrelid = 'public.auditions'::regclass and attnum > 0 and not attisdropped
     and attgenerated = '' and attname <> 'id';
  execute pg_catalog.format(
    'insert into public.auditions (id, %s) select $1, %s from public.auditions where id = $2', v_cols, v_vals)
    using p_id, p_from, p_date;
  select pg_catalog.string_agg(pg_catalog.quote_ident(attname), ', ' order by attnum) into v_cols
    from pg_catalog.pg_attribute
   where attrelid = 'public.testimonies'::regclass and attnum > 0 and not attisdropped
     and attgenerated = '' and attname not in ('id', 'audition_id');
  execute pg_catalog.format(
    'insert into public.testimonies (id, audition_id, %1$s)
     select pg_catalog.md5($1::text || t.id::text)::uuid, $1, %1$s
       from public.testimonies t where t.audition_id = $2 order by t.id limit $3', v_cols)
    using p_id, p_from, p_testimonies;
end $copy$;

-- The cohorts of the analyses (auditionCohort): two 2019 cahiers by their
-- title (case and spaces as typed), and an archive by its generic location,
-- left where it is placed.
with p as (
  select id, row_number() over (order by id) as i from public.auditions
   where place_path is not null and not audition_en_ligne and status = 'published'),
u as (
  update public.auditions a
     set title = case p.i when 1 then 'Cahier de doléances - ' || a.location
                          when 2 then '  CAHIERS DE DOLÉANCES de ' || a.location else a.title end,
         location = case p.i when 3 then 'France' else a.location end,
         placed_location = case p.i when 3 then 'France' else a.placed_location end
    from p
   where a.id = p.id and p.i <= 3
  returning a.id, p.i)
insert into pg_temp.edges select case when i = 3 then 'archive' else 'cahier' end, id from u;

do $edges$
declare
  r record;
  v record;
  v_id uuid;
  v_max date;
begin
  select max(a."date") into v_max from public.auditions a
   where a.status = 'published' and a.place_path is not null
     and (not a.audition_en_ligne or exists (
           select 1 from public.testimonies t
            where t.audition_id = a.id and t.verification_status = 'verified'));

  -- Testimony pages of 7: the most heard audition gets 2 undated testimonies
  -- then 9 sharing one created_at, the next one 9 undated; a page ends
  -- inside each run.
  for r in
    select a.id, row_number() over (order by count(*) desc, a.id) as i
      from public.auditions a join public.testimonies t on t.audition_id = a.id
     where ${POOL}
     group by a.id having count(*) >= 11
     order by count(*) desc, a.id limit 2
  loop
    update public.testimonies t
       set created_at = case when r.i = 1 and k.k <= 2 then null
                             when r.i = 1 and k.k <= 11 then '2000-01-01 00:00:00+00'::timestamptz
                             when r.i = 2 and k.k <= 9 then null
                             else t.created_at end
      from (select x.id, row_number() over (order by x.id) as k
              from public.testimonies x where x.audition_id = r.id) k
     where t.id = k.id;
    insert into pg_temp.edges values (case r.i when 1 then 'testimonies tied' else 'testimonies undated' end, r.id);
  end loop;

  -- Results: an audition joins another lieu on the day of one of its
  -- auditions (one lieu, one day: by id).
  select a.* into v from public.auditions a where ${POOL} order by a.id desc limit 1;
  select a.id into v_id from public.auditions a
   where ${POOL} and a.lieu_id <> v.lieu_id order by a.id desc limit 1;
  if v_id is not null then
    update public.auditions
       set place_unit = v.place_unit, place_path = v.place_path, locality_id = v.locality_id,
           lieu_key = v.lieu_key, lat = v.lat, lng = v.lng, place_precision = v.place_precision,
           "date" = v."date"
     where id = v_id;
    insert into pg_temp.edges values ('one lieu, one day', v.id), ('one lieu, one day', v_id);
  end if;

  -- Two lieux of the same rank: an audition alone in its lieu takes the
  -- newest date of another lieu.
  v_id := null;
  select a.id, a.lieu_id into r from public.auditions a
   where ${POOL}
     and not exists (select 1 from public.auditions b where b.lieu_id = a.lieu_id and b.id <> a.id)
   order by a.id desc limit 1;
  select b.lieu_id, max(b."date") as rank into v from public.auditions b
   where b.status = 'published' and b.place_path is not null and not b.audition_en_ligne
     and b.lieu_id <> r.lieu_id
     and b.lieu_id not in (select x.lieu_id from public.auditions x
                            join pg_temp.edges e on e.id = x.id where x.lieu_id is not null)
   group by b.lieu_id order by b.lieu_id desc limit 1;
  if r.id is not null and v.lieu_id is not null then
    update public.auditions set "date" = v.rank where id = r.id;
    insert into pg_temp.edges values ('same rank', r.id);
  end if;

  -- Sibling units of one count and one rank: a département of the harness
  -- ('99') with two communes; the first (by id) holds one audition heard
  -- twice, the second two lieux heard once each, all on one day. The second
  -- comes first by tie, its two lieux first by tie against their lieu ids,
  -- so an order by id instead would show.
  select a.* into v from public.auditions a
   where a.id = (
     with heard as (
       select a.id, count(*) as n from public.auditions a
         join public.testimonies t on t.audition_id = a.id
        where ${POOL} and a.place_unit like 'fr:%'
        group by a.id)
     select h.id from heard h
      where h.n = 2
        and exists (select 1 from heard o where o.n = 1 and o.id < h.id)
        and exists (select 1 from heard o where o.n = 1 and o.id > h.id)
      order by h.id limit 1);
  select a.id into r from public.auditions a
    join public.testimonies t on t.audition_id = a.id
   where ${POOL} and a.id < v.id
   group by a.id having count(*) = 1
   order by a.id limit 1;
  select a.id into v_id from public.auditions a
    join public.testimonies t on t.audition_id = a.id
   where ${POOL} and a.id > v.id
   group by a.id having count(*) = 1
   order by a.id desc limit 1;
  if v.id is not null and r.id is not null and v_id is not null then
    insert into public.geo_units (id, parent_id, level, country, name, code, source, geo_release)
    values ('fr:dep:99', v.place_path[2], 'county', 'FR', 'Parité', '99', 'insee', v.geo_release),
           ('fr:com:99001', 'fr:dep:99', 'locality', 'FR', 'Parité-Haut', '99001', 'insee', v.geo_release),
           ('fr:com:99002', 'fr:dep:99', 'locality', 'FR', 'Parité-Bas', '99002', 'insee', v.geo_release);
    update public.auditions a
       set place_unit = x.unit, place_path = array[v.place_path[1], v.place_path[2], 'fr:dep:99', x.unit],
           locality_id = x.unit, lieu_key = x.key, lat = 44.5 + x.k * 0.05, lng = 3.5 + x.k * 0.05,
           place_precision = 'address', "date" = v."date"
      from (values (v.id, 'fr:com:99001', 'Parvis, Parité-Haut', 0),
                   -- The lieu keys whose lieu ids run against the auditions' ids.
                   (r.id, 'fr:com:99002',
                    case when md5('fr:com:99002' || chr(31) || 'Halle, Parité-Bas') collate "C"
                              < md5('fr:com:99002' || chr(31) || 'Lavoir, Parité-Bas')
                         then 'Lavoir, Parité-Bas' else 'Halle, Parité-Bas' end, 1),
                   (v_id, 'fr:com:99002',
                    case when md5('fr:com:99002' || chr(31) || 'Halle, Parité-Bas') collate "C"
                              < md5('fr:com:99002' || chr(31) || 'Lavoir, Parité-Bas')
                         then 'Halle, Parité-Bas' else 'Lavoir, Parité-Bas' end, 2))
           as x(id, unit, key, k)
     where a.id = x.id;
    insert into pg_temp.edges values ('sibling, alone', v.id), ('sibling, two lieux', r.id), ('sibling, two lieux', v_id);
  end if;

  -- Hidden next to shown: a draft, then an online audition nobody verified,
  -- join the two lieux with the most auditions, newer than anything on the
  -- map, at another point and in another town.
  for r in
    select a.lieu_id, row_number() over (order by count(*) desc, a.lieu_id) as i
      from public.auditions a
     where a.status = 'published' and a.place_path is not null and not a.audition_en_ligne
     group by a.lieu_id order by count(*) desc, a.lieu_id limit 2
  loop
    select a.* into v from public.auditions a
     where a.lieu_id = r.lieu_id and a.status = 'published'
     order by a."date" desc, a.id limit 1;
    v_id := case r.i
      when 1 then (select a.id from public.auditions a
                    where a.status is distinct from 'published' order by a.id limit 1)
      else (select a.id from public.auditions a
             where a.audition_en_ligne and a.status = 'published'
               and not exists (select 1 from public.testimonies t
                                where t.audition_id = a.id and t.verification_status = 'verified')
             order by a.id limit 1) end;
    continue when v_id is null;
    update public.auditions a
       set place_unit = v.place_unit, place_path = v.place_path, lieu_key = v.lieu_key,
           locality_id = (select g.id from public.geo_units g
                           where g.id like 'fr:com:%' and g.id is distinct from v.locality_id
                           order by g.id limit 1),
           lat = v.lat + 0.37, lng = v.lng + 0.41,
           -- An online audition's date is the first of its month.
           "date" = case when a.audition_en_ligne
                         then (pg_catalog.date_trunc('month', v_max) + pg_catalog.make_interval(months => 1 + r.i::integer))::date
                         else v_max + 30 * r.i::integer end,
           place = case when a.audition_en_ligne
                        then pg_catalog.jsonb_set(a.place, '{commune}', '"Ailleurs"') else a.place end,
           placed_location = a.location
     where a.id = v_id;
    insert into pg_temp.edges values (case r.i when 1 then 'draft in a lieu' else 'unverified online in a lieu' end, v_id);
  end loop;

  -- An old-app edit: the most heard audition left takes another lieu's
  -- name, the location only (stale until the placement job's next pass).
  select a.id, a.lieu_id into r from public.auditions a
    left join public.testimonies t on t.audition_id = a.id
   where ${POOL}
   group by a.id order by count(t.id) desc, a.id limit 1;
  if r.id is not null then
    update public.auditions
       set location = (select b.lieu_key from public.auditions b
                        where b.status = 'published' and b.place_path is not null
                          and not b.audition_en_ligne and b.lieu_id <> r.lieu_id
                        group by b.lieu_key, b.lieu_id order by count(*) desc, b.lieu_id limit 1)
     where id = r.id;
    insert into pg_temp.edges values ('stale edit', r.id);
  end if;

  -- A lieu's newest day shared by two auditions, and a sibling lieu between
  -- them: copies of one audition, all on one day newer than the map (and
  -- older than the hidden ones above). Lieu A holds p (one testimony) and s
  -- (one, another point and precision), lieu B q (two), p < q < s: same
  -- count, same rank, A first by its tie p, and by lieu id the other way.
  select a.* into v from public.auditions a
   where ${POOL} and a.place_unit like 'fr:com:%'
     and (select count(*) from public.testimonies t where t.audition_id = a.id) >= 2
   order by a.id limit 1;
  if v.id is not null then
    perform pg_temp.copy_audition(v.id, 'd0000000-0000-4000-8000-000000000001', v_max + 7, 1);
    perform pg_temp.copy_audition(v.id, 'd0000000-0000-4000-8000-000000000002', v_max + 7, 2);
    perform pg_temp.copy_audition(v.id, 'd0000000-0000-4000-8000-000000000003', v_max + 7, 1);
    update public.auditions a
       set lieu_key = x.key, location = x.key, placed_location = x.key,
           -- Six decimals, as the seed's: printed alike at any extra_float_digits.
           lat = pg_catalog.round((v.lat + x.k * 0.013)::numeric, 6),
           lng = pg_catalog.round((v.lng + x.k * 0.017)::numeric, 6),
           place_precision = case x.k when 1 then 'commune' else 'address' end
      from (values ('d0000000-0000-4000-8000-000000000001'::uuid, 'a', 0),
                   ('d0000000-0000-4000-8000-000000000002'::uuid, 'b', 2),
                   ('d0000000-0000-4000-8000-000000000003'::uuid, 'a', 1)) as y(id, lieu, k)
      cross join lateral (
        -- The two names, so that A's lieu id sorts after B's.
        select case when (pg_catalog.md5(v.place_unit || chr(31) || 'Kiosque de la parité') collate "C"
                          > pg_catalog.md5(v.place_unit || chr(31) || 'Fontaine de la parité'))
                         = (y.lieu = 'a')
                    then 'Kiosque de la parité' else 'Fontaine de la parité' end as key, y.k as k) x
     where a.id = y.id;
    insert into pg_temp.edges values
      ('newest day shared', 'd0000000-0000-4000-8000-000000000001'),
      ('newest day shared', 'd0000000-0000-4000-8000-000000000003'),
      ('newest day shared, sibling', 'd0000000-0000-4000-8000-000000000002');
  end if;

  -- A draft with testimonies, on no point (as an old-app insert the job
  -- settled unplaced): its testimonies are not public, unplaced or not.
  select a.id into v_id from public.auditions a
    join public.testimonies t on t.audition_id = a.id
   where a.status is distinct from 'published' and a.id not in (select e.id from pg_temp.edges e)
   group by a.id order by count(*) desc, a.id limit 1;
  if v_id is not null then
    update public.auditions
       set place_unit = null, place_path = null, locality_id = null, lieu_key = null, lat = null,
           lng = null, place_precision = 'unplaced', placed_location = location
     where id = v_id;
    insert into pg_temp.edges values ('unplaced draft', v_id);
  end if;

  -- The old app's online rows, copies of the seed's online auditions that
  -- hold a verified testimony: an insert (stale, on no point: /api/map files
  -- it by its name at once), and a rename (stale, at its stored lieu).
  for r in
    select a.id, a."date", row_number() over (order by a.id) as i
      from public.auditions a
     where a.audition_en_ligne and a.status = 'published' and a.place_path is not null
       and a.id not in (select e.id from pg_temp.edges e)
       and exists (select 1 from public.testimonies t
                    where t.audition_id = a.id and t.verification_status = 'verified')
     order by a.id limit 2
  loop
    v_id := case r.i when 1 then 'd0000000-0000-4000-8000-0000000000f1'::uuid
                     else 'd0000000-0000-4000-8000-0000000000f2'::uuid end;
    perform pg_temp.copy_audition(
      r.id, v_id, (pg_catalog.date_trunc('month', r."date") - pg_catalog.make_interval(years => 1))::date);
    if r.i = 1 then
      update public.auditions
         set place_unit = null, place_path = null, locality_id = null, lieu_key = null, lat = null,
             lng = null, place_precision = null, placed_location = null, placed_rules = null,
             geo_release = null
       where id = v_id;
      insert into pg_temp.edges values ('online old-app insert', v_id);
    else
      update public.auditions set location = location || ' (salle B)' where id = v_id;
      insert into pg_temp.edges values ('online old-app rename', v_id);
    end if;
  end loop;
end $edges$;

insert into auth.users (id) values (${lit(PLAIN_ADMIN)});
update public.auditions set created_by = ${lit(PLAIN_ADMIN)}
 where location like '%Lyon%' or location like '%Villeurbanne%';
`;

/** The setup every session runs first (see the header), and what it did. */
export function setup(): Setup {
  const [edges, stale] = sqlJson<unknown>(`
begin;
${SETUP_SQL}
select coalesce(pg_catalog.jsonb_object_agg(kind, ids), '{}'::jsonb)
  from (select kind, pg_catalog.jsonb_agg(id order by id) as ids from pg_temp.edges group by kind) x;
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'id', id, 'location', location, 'lieu_key', case when place_path is not null then lieu_key end)
         order by id), '[]'::jsonb)
  from public.auditions where place_stale;
rollback;`) as [Record<string, string[]>, StaleRow[]];
  return { sql: SETUP_SQL, edges, stale };
}

/** An audition as the database holds it (what the admin list and the checks read). */
export interface AuditionRow {
  id: string;
  title: string;
  date: string;
  location: string;
  content: string;
  status: string | null;
  audition_en_ligne: boolean;
  created_by: string | null;
  place_path: string[] | null;
  lieu_id: string | null;
  place_precision: string | null;
  lat: number | null;
  lng: number | null;
}

export interface Exported {
  /** /api/testimonies: the corpus as anon reads it, newest first. */
  corpus: PublicTestimony[];
  /**
   * /api/map's groups as the server reads the places (groupsFromRows): a
   * stale row at its stored place, an online row with none unplaced (D14).
   */
  groups: LocationGroup[];
  /** /api/map's groups as it serves them: a stale row filed by its name. */
  mapGroups: LocationGroup[];
  /** The rows /api/map reads: published; online, once holding a verified testimony. */
  mapIds: Set<string>;
  /** Every audition (admins see every status). */
  auditions: AuditionRow[];
  /** /api/testimonies/admin/filterable, as an admin reads it. */
  filterable: FilterableTestimony[];
}

/** What the old endpoints served, read as they read it. */
export function exportLegacy(s: Setup): Exported {
  const [corpus, mapRows, counts, units, auditions, filterable] = sqlJson<unknown>(`
begin;
${s.sql}
-- /api/testimonies (modules/testimonies/service.ts fetchPublicTestimonies), as anon.
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';
select coalesce(pg_catalog.jsonb_agg(x order by x.created_at desc, x.id desc), '[]'::jsonb) from (
  select t.id, t.person_name, t.person_info, t.content, t.topics, t.verification_status, t.created_at,
         case when a.id is not null then pg_catalog.jsonb_build_object(
           'id', a.id, 'title', a.title, 'location', a.location, 'date', a."date") end as audition
    from public.testimonies t left join public.auditions a on a.id = t.audition_id) x;
-- /api/map's rows (fetchPublishedAuditions) and the counts view it reads, as anon.
select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by a."date" desc, a.id), '[]'::jsonb)
  from public.auditions a where a.status = 'published';
select coalesce(pg_catalog.jsonb_object_agg(c.audition_id, pg_catalog.jsonb_build_array(c.total_count, c.verified_count)), '{}'::jsonb)
  from public.audition_testimony_counts c where c.audition_id is not null;
reset role;
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'id', id, 'parent_id', parent_id, 'level', level, 'name', name, 'code', code)), '[]'::jsonb)
  from public.geo_units;
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'id', id, 'title', title, 'date', "date", 'location', location, 'content', content,
         'status', status, 'audition_en_ligne', audition_en_ligne, 'created_by', created_by,
         'place_path', place_path, 'lieu_id', lieu_id, 'place_precision', place_precision,
         'lat', lat, 'lng', lng)
         order by "date" desc, id), '[]'::jsonb)
  from public.auditions;
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'audition_id', audition_id, 'person_name', person_name, 'person_info', person_info,
         'content', content, 'topics', topics, 'verification_status', verification_status)
         order by created_at, id), '[]'::jsonb)
  from public.testimonies;
rollback;`) as [
    PublicTestimony[],
    (MapRow & { audition_en_ligne: boolean; testimony_count?: number })[],
    Record<string, [number, number]>,
    GeoUnitName[],
    AuditionRow[],
    FilterableTestimony[],
  ];
  // fetchPublishedAuditions: every testimony of an ordinary audition, the
  // verified ones of an online one; an online one without any is left out.
  const rows: MapRow[] = mapRows
    .map((a) => {
      const c = counts[a.id];
      const testimony_count = (a.audition_en_ligne ? c?.[1] : c?.[0]) ?? 0;
      return { ...a, testimony_count };
    })
    .filter((a) => !(a.audition_en_ligne && a.testimony_count === 0));
  const byId = new Map(units.map((u) => [u.id, u]));
  // What the RPCs read until the placement job's next pass (design A21, D14):
  // every row at its stored place. groupsFromRows files an online row by its
  // name at its town hall: one the old app renamed is filed by its stored
  // lieu (the name it was placed under) at its stored point instead.
  const stored = rows
    .filter((a) => !(a.audition_en_ligne && !a.place_path))
    .map((a) =>
      a.audition_en_ligne && a.place_stale
        ? {
            ...a,
            location: a.lieu_key!,
            place: { ...(a.place as object), lat: a.lat, lng: a.lng },
            place_stale: false,
          }
        : { ...a, place_stale: false },
    );
  return {
    corpus,
    groups: groupsFromRows(stored, byId),
    mapGroups: groupsFromRows(rows, byId),
    mapIds: new Set(rows.map((a) => a.id)),
    auditions,
    filterable,
  };
}

/** One RPC call (or any select printing one json value) of a session, and where its answer goes. */
export interface Call {
  sql: string;
  take: (value: unknown) => void;
}

// Walks a keyset through to its end; the same across a change of the rows
// between two pages; the rows through an audition and the page after them;
// and the SQLSTATE a statement raises.
const HELPERS = `
create function pg_temp.walk_on(p_filters jsonb, p_sort text, p_limit integer, p_page jsonb)
returns jsonb language plpgsql as $$
declare
  v_page jsonb := p_page;
  v_pages jsonb := '[]';
  v_turns integer := 0;
begin
  loop
    v_pages := v_pages || pg_catalog.jsonb_build_array(v_page);
    exit when pg_catalog.jsonb_typeof(v_page -> 'next') is distinct from 'array';
    v_turns := v_turns + 1;
    if v_turns > 500 then raise exception 'walk_results: no last page'; end if;
    v_page := public.audition_results(p_filters, p_sort, v_page -> 'next', p_limit);
  end loop;
  return v_pages;
end $$;
create function pg_temp.walk_results(p_filters jsonb, p_sort text, p_limit integer, p_through uuid default null)
returns jsonb language plpgsql as $$
begin
  return pg_temp.walk_on(p_filters, p_sort, p_limit,
                         public.audition_results(p_filters, p_sort, null, p_limit, p_through));
end $$;
-- [the rows through p_through, the pages after them once p_change has run,
-- a whole walk after the change]; the change is undone (a subtransaction
-- rolled back), the answers kept.
create function pg_temp.walk_across(p_filters jsonb, p_sort text, p_limit integer, p_through uuid, p_change text)
returns jsonb language plpgsql as $$
declare
  v_first jsonb;
  v_rest jsonb;
  v_fresh jsonb;
begin
  begin
    v_first := public.audition_results(p_filters, p_sort, null, p_limit, p_through);
    execute p_change;
    v_rest := case when pg_catalog.jsonb_typeof(v_first -> 'next') = 'array'
                   then pg_temp.walk_on(p_filters, p_sort, p_limit,
                          public.audition_results(p_filters, p_sort, v_first -> 'next', p_limit))
                   else '[]' end;
    v_fresh := pg_temp.walk_results(p_filters, p_sort, p_limit);
    raise exception 'undone' using errcode = 'AC000';
  exception when sqlstate 'AC000' then
    null;
  end;
  return pg_catalog.jsonb_build_array(v_first, v_rest, v_fresh);
end $$;
create function pg_temp.through_and_next(p_filters jsonb, p_sort text, p_limit integer, p_through uuid)
returns jsonb language plpgsql as $$
declare
  v_first jsonb := public.audition_results(p_filters, p_sort, null, p_limit, p_through);
begin
  return pg_catalog.jsonb_build_array(v_first,
    case when pg_catalog.jsonb_typeof(v_first -> 'next') = 'array'
         then public.audition_results(p_filters, p_sort, v_first -> 'next', p_limit) end);
end $$;
create function pg_temp.walk_testimonies(p_audition uuid, p_filters jsonb, p_limit integer)
returns jsonb language plpgsql as $$
declare
  v_page jsonb := public.testimony_page(p_audition, p_filters, null, p_limit);
  v_pages jsonb := '[]';
  v_turns integer := 0;
begin
  loop
    v_pages := v_pages || pg_catalog.jsonb_build_array(v_page);
    exit when pg_catalog.jsonb_typeof(v_page -> 'next') is distinct from 'array';
    v_turns := v_turns + 1;
    if v_turns > 500 then raise exception 'walk_testimonies: no last page'; end if;
    v_page := public.testimony_page(p_audition, p_filters, v_page -> 'next', p_limit);
  end loop;
  return v_pages;
end $$;
create function pg_temp.sqlstate_of(p_sql text) returns jsonb language plpgsql as $$
begin
  execute p_sql;
  return 'null';
exception when others then
  return pg_catalog.to_jsonb(sqlstate);
end $$;
`;

/** Runs the calls in one session (after the setup, rolled back), handing each its answer. */
export function runCalls(s: Setup, calls: Call[]): void {
  if (!calls.length) return;
  const out = sqlJson<unknown>(`
begin;
${s.sql}
${HELPERS}
-- As the API calls them.
set local role service_role;
${calls.map((c) => `${c.sql.trim().replace(/;$/, "")};`).join("\n")}
rollback;`);
  if (out.length !== calls.length) {
    throw new Error(`expected ${calls.length} answers, got ${out.length}`);
  }
  calls.forEach((c, i) => c.take(out[i]));
}

/** A jsonb literal. */
export function jsonb(v: unknown): string {
  return `${lit(JSON.stringify(v))}::jsonb`;
}

/** Checks the session tools are there (psql reachable, the RPCs installed). */
export function rpcsInstalled(): boolean {
  const out = runSql(
    "select pg_catalog.to_regprocedure('public.place_counts(text, jsonb, integer, boolean, integer, boolean)') is not null;",
  ).trim();
  return out === "t";
}
