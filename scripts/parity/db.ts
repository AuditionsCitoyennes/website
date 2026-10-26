// The database side of the parity harness: what the old endpoints served
// (read as they read it) and what the read RPCs answer, from the same rows.
//
// Every session starts with the same setup, in a transaction rolled back at
// its end:
//   - the rows the old app wrote (stale) are placed as the placement job
//     places them, by reuse (placeLieu: a placed, up-to-date French offline
//     row of the same lieu key): the RPCs count a stale row unplaced, while
//     /api/map files it under its name, until the job's first pass;
//   - three placed auditions take the analyses' other cohorts: two 2019
//     cahiers (by their title), an archive (a generic location);
//   - a plain admin (a fake auth user) owns the Lyon area's auditions, for
//     the admin list's theme options.

import { getCanonicalLocation, type LocationGroup, type PublicTestimony } from "@ac/shared";
import { RULES_HASH } from "../seed/fixtures/fr";
import { groupsFromRows, type MapRow } from "../../apps/api/src/modules/places/groups";
import type { GeoUnitName } from "../../apps/api/src/modules/places/geoUnits";
import type { FilterableTestimony } from "./legacy/adminFilters";
import { lit, runSql, sqlJson } from "../db-checks/psql";

/** The plain admin of the harness (rolled back with everything else). */
export const PLAIN_ADMIN = "00000000-0000-4000-8000-00000000a11c";

export interface Setup {
  sql: string;
  /** Stale offline rows the reuse placed, and those it could not. */
  reused: number;
  leftStale: string[];
}

/** The setup every session runs first (see the header). */
export function setup(): Setup {
  const [stale] = sqlJson<{ id: string; location: string }[] | null>(`
select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', id, 'location', location) order by id)
  from public.auditions where place_stale and not audition_en_ligne;`);
  const rows = (stale ?? []).map((r) => ({ id: r.id, key: getCanonicalLocation(r.location) }));
  const reuse = rows.length
    ? `
with v(id, key) as (values ${rows.map((r) => `(${lit(r.id)}::uuid, ${lit(r.key)})`).join(", ")}),
d as (
  select v.id, v.key, s.*
    from v
   cross join lateral (
     select x.place_unit, x.place_path, x.locality_id, x.lat, x.lng, x.place_precision,
            x.place_candidates, x.placed_rules, x.geo_release
       from public.auditions x
      where x.lieu_key = v.key and not x.audition_en_ligne and not x.place_stale
        and x.placed_rules = ${lit(RULES_HASH)} and x.place_path is not null
        and x.place_unit like 'fr:%'
      order by x.created_at desc nulls last, x.id
      limit 1) s)
update public.auditions a
   set place_unit = d.place_unit, place_path = d.place_path, locality_id = d.locality_id,
       lieu_key = d.key, lat = d.lat, lng = d.lng, place_precision = d.place_precision,
       place_candidates = d.place_candidates, placed_location = a.location,
       placed_rules = d.placed_rules, geo_release = d.geo_release
  from d
 where a.id = d.id;`
    : "";
  const sql = `
${reuse}
-- The cohorts of the analyses (auditionCohort): two 2019 cahiers by their
-- title (case and spaces as typed), and an archive by its generic location,
-- left where it is placed.
with p as (
  select id, row_number() over (order by id) as i from public.auditions
   where place_path is not null and not audition_en_ligne and status = 'published')
update public.auditions a
   set title = case p.i when 1 then 'Cahier de doléances - ' || a.location
                        when 2 then '  CAHIERS DE DOLÉANCES de ' || a.location else a.title end,
       location = case p.i when 3 then 'France' else a.location end,
       placed_location = case p.i when 3 then 'France' else a.placed_location end
  from p
 where a.id = p.id and p.i <= 3;
insert into auth.users (id) values (${lit(PLAIN_ADMIN)});
update public.auditions set created_by = ${lit(PLAIN_ADMIN)}
 where location like '%Lyon%' or location like '%Villeurbanne%';
`;
  const [left] = sqlJson<string[] | null>(`
begin;
${sql}
select pg_catalog.jsonb_agg(location order by location)
  from public.auditions where place_stale and not audition_en_ligne;
rollback;`);
  return { sql, reused: rows.length - (left?.length ?? 0), leftStale: left ?? [] };
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
}

export interface Exported {
  /** /api/testimonies: the corpus as anon reads it, newest first. */
  corpus: PublicTestimony[];
  /** /api/map's groups, built from the stored places (groupsFromRows). */
  groups: LocationGroup[];
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
         'place_path', place_path, 'lieu_id', lieu_id) order by "date" desc, id), '[]'::jsonb)
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
  return { corpus, groups: groupsFromRows(rows, byId), auditions, filterable };
}

/** One RPC call (or any select printing one json value) of a session, and where its answer goes. */
export interface Call {
  sql: string;
  take: (value: unknown) => void;
}

// Walks a keyset through to its end; and the SQLSTATE a statement raises.
const HELPERS = `
create function pg_temp.walk_results(p_filters jsonb, p_sort text, p_limit integer, p_through uuid default null)
returns jsonb language plpgsql as $$
declare
  v_page jsonb := public.audition_results(p_filters, p_sort, null, p_limit, p_through);
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
