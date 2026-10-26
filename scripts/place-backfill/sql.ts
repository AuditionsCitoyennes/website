// The reviewed backfill as SQL (design B4): the migration, its fixture test
// and the expected list the database checks read. Pure: generate.ts renders
// production's plan with it, scripts/db-checks a fixed one.

/** A geo_units row the backfill inserts (never updates: on conflict, kept). */
export interface BackfillUnit {
  id: string;
  parent_id: string | null;
  level: string;
  country: string;
  name: string;
  code: string | null;
  lat: number | null;
  lng: number | null;
  source: string;
  geo_release: string;
}

/** One reviewed lieu, as the UPDATE matches and writes it. */
export interface BackfillValue {
  online: boolean;
  /** Offline: the raw location the UPDATE matches. Online: the town hall's label (not matched). */
  location: string;
  /** Online: the town hall code the UPDATE matches; null offline. */
  citycode: string | null;
  unit: string | null;
  path: string[] | null;
  locality: string | null;
  /** Offline: the lieu key. Online: null — each row keeps its own label (design A6). */
  key: string | null;
  lat: number | null;
  lng: number | null;
  precision: string;
  /** The same-named communes, as place_candidates stores them; null when none were involved. */
  candidates: unknown;
  release: string | null;
}

export interface Backfill {
  /** The migration's version, YYYYMMDDHHMMSS. */
  version: string;
  /** When it was read (ISO), and from where (a host, never a key). */
  generated: string;
  source: string;
  /** The LOCATION_RULES hash the offline rows are stamped with (placed_rules). */
  rules: string;
  units: BackfillUnit[];
  values: BackfillValue[];
}

export const MIGRATION_NAME = "backfill_places_fr";
export const TEST_FILE = `${MIGRATION_NAME}.sql`;
export const EXPECTED_FILE = `${MIGRATION_NAME}.expected.json`;

export const migrationFileOf = (version: string) => `${version}_${MIGRATION_NAME}.sql`;

/** What the expected list holds (supabase/tests/backfill_places_fr.expected.json). */
export interface ExpectedList {
  about: string;
  /** The migration file (supabase/migrations/), null before a backfill exists. */
  migration: string | null;
  /** Its fixture test (supabase/tests/), null with it. */
  test: string | null;
  generated: string | null;
  source: string | null;
  rules: string | null;
  /** Raw location → its unit chain, root first ([] for a lieu on no point). */
  offline: Record<string, string[]>;
  /** Town hall code → its unit chain ([] for one on no point). */
  online: Record<string, string[]>;
}

export const EXPECTED_ABOUT =
  "Written by scripts/place-backfill/generate.ts with the migration it names: where that reviewed " +
  "backfill places each audition never placed. Read by scripts/db-checks (backfill, migrate-seeded).";

// ---- Literals ------------------------------------------------------------------

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  return String(n);
}

const textOrNull = (s: string | null) => (s === null ? "null" : lit(s));
const numOrNull = (n: number | null) => (n === null ? "null" : num(n));
const arrayOrNull = (xs: string[] | null) =>
  xs === null ? "null" : `array[${xs.map(lit).join(", ")}]::text[]`;
const jsonOrNull = (v: unknown) =>
  v === null || v === undefined ? "null" : `${lit(JSON.stringify(v))}::jsonb`;

/** The UPDATE's VALUES columns, and their types. */
const V: [column: string, type: string][] = [
  ["online", "boolean"],
  ["location", "text"],
  ["citycode", "text"],
  ["unit", "text"],
  ["path", "text[]"],
  ["locality", "text"],
  ["key", "text"],
  ["lat", "double precision"],
  ["lng", "double precision"],
  ["prec", "text"],
  ["cand", "jsonb"],
  ["release", "text"],
];
const V_COLUMNS = V.map(([c]) => c).join(", ");
const V_DEFINITIONS = V.map(([c, t]) => `${c} ${t}`).join(", ");

/** A value's cells, in V's order; `typed` (the first row: the others follow it) casts each. */
function valueCells(v: BackfillValue, typed: boolean): string[] {
  const cells = [
    String(v.online),
    lit(v.location),
    textOrNull(v.citycode),
    textOrNull(v.unit),
    arrayOrNull(v.path),
    textOrNull(v.locality),
    textOrNull(v.key),
    numOrNull(v.lat),
    numOrNull(v.lng),
    lit(v.precision),
    jsonOrNull(v.candidates),
    textOrNull(v.release),
  ];
  if (!typed) return cells;
  return cells.map((cell, i) => {
    const type = V[i][1];
    return cell.endsWith(`::${type}`) || type === "boolean" ? cell : `${cell}::${type}`;
  });
}

const valueRow = (v: BackfillValue, typed: boolean) => `(${valueCells(v, typed).join(", ")})`;

function unitRow(u: BackfillUnit): string {
  return `(${[
    lit(u.id),
    textOrNull(u.parent_id),
    lit(u.level),
    lit(u.country),
    lit(u.name),
    textOrNull(u.code),
    numOrNull(u.lat),
    numOrNull(u.lng),
    lit(u.source),
    lit(u.geo_release),
  ].join(", ")})`;
}

// ---- Checks --------------------------------------------------------------------

/** Refuses a backfill the UPDATE would apply ambiguously, or the table would refuse. */
export function checkBackfill(b: Backfill): void {
  if (!/^\d{14}$/.test(b.version)) throw new Error(`version ${b.version}: YYYYMMDDHHMMSS`);
  if (!/^[0-9a-f]{8}$/.test(b.rules)) throw new Error(`rules hash ${b.rules}: 8 hex`);
  if (b.values.length === 0) throw new Error("nothing to backfill: no lieu");
  const units = new Map(b.units.map((u) => [u.id, u]));
  if (units.size !== b.units.length) throw new Error("a unit is listed twice");
  for (const u of b.units) {
    if (u.parent_id !== null && !units.has(u.parent_id)) {
      throw new Error(`unit ${u.id}: its parent ${u.parent_id} is not inserted`);
    }
  }
  const seen = new Set<string>();
  for (const v of b.values) {
    const match = v.online ? `online ${v.citycode}` : `offline ${v.location}`;
    if (v.online ? !v.citycode : v.citycode !== null || v.key === null) {
      throw new Error(
        `${match}: an online lieu is matched by its code, an offline one by its text`,
      );
    }
    if (seen.has(match)) throw new Error(`${match} is listed twice`);
    seen.add(match);
    const placed = v.path !== null;
    if (placed !== (v.precision !== "unplaced") || placed !== (v.unit !== null)) {
      throw new Error(`${match}: a path, a unit and a precision go together`);
    }
    if (placed && (v.lat === null || v.lng === null || v.path!.at(-1) !== v.unit)) {
      throw new Error(`${match}: a placed lieu has a point and its unit ends its path`);
    }
    for (const id of v.path ?? []) {
      if (!units.has(id)) throw new Error(`${match}: unit ${id} is not inserted`);
    }
    if (v.locality !== null && !v.path?.includes(v.locality)) {
      throw new Error(`${match}: its locality ${v.locality} is off its path`);
    }
  }
}

// ---- The migration -----------------------------------------------------------------

/** supabase/migrations/<version>_backfill_places_fr.sql */
export function migrationSql(b: Backfill, review: string): string {
  checkBackfill(b);
  const offline = b.values.filter((v) => !v.online).length;
  const online = b.values.length - offline;
  const unitsSql = b.units.length
    ? `insert into public.geo_units (id, parent_id, level, country, name, code, lat, lng, source, geo_release) values
  ${b.units.map(unitRow).join(",\n  ")}
on conflict (id) do nothing;`
    : "-- No lieu is on a point: no unit to insert.";
  return `-- The reviewed backfill of a database's places (map phase 1, design B4).
-- Generated by scripts/place-backfill/generate.ts from ${b.source}, read
-- ${b.generated} with the publishable key; reviewed in ${review}.
-- Do not edit: generate it again, and review that.
--
-- Places the auditions never placed (placed_location is null) whose text is
-- the reviewed one: ${offline} offline lieu spelling(s) matched by their raw
-- location, ${online} town hall(s) matched by code (an online row keeps its own
-- label as lieu key). A row changed since the review matches nothing and stays
-- stale, for the API's placement job; a row already placed is left as it is;
-- running it again changes nothing. Offline rows are stamped with the
-- LOCATION_RULES hash they were computed under (${b.rules}); online rows,
-- as the API files them, with none.

set lock_timeout = '200ms';

${unitsSql}

with v (${V_COLUMNS}) as (values
  ${b.values.map((v, i) => valueRow(v, i === 0)).join(",\n  ")}
)
update public.auditions a
   set place_unit = v.unit, place_path = v.path, locality_id = v.locality,
       lieu_key = case when v.online then a.location else v.key end,
       lat = v.lat, lng = v.lng, place_precision = v.prec, place_candidates = v.cand,
       placed_location = a.location,
       placed_rules = case when v.online then null else ${lit(b.rules)} end,
       geo_release = v.release
  from v
 where a.placed_location is null
   and a.audition_en_ligne = v.online
   and ((not v.online and a.location = v.location) or (v.online and a.citycode = v.citycode));

do $$
declare
  n_point bigint;
  n_none bigint;
  n_stale_offline bigint;
  n_stale_online bigint;
begin
  select count(*) filter (where not place_stale and place_path is not null),
         count(*) filter (where not place_stale and place_path is null),
         count(*) filter (where place_stale and not audition_en_ligne),
         count(*) filter (where place_stale and audition_en_ligne)
    into n_point, n_none, n_stale_offline, n_stale_online
    from public.auditions;
  raise notice '${MIGRATION_NAME}: % auditions placed, % on no point (generic text, no such place, same-named communes)',
    n_point, n_none;
  raise notice '${MIGRATION_NAME}: % still stale (% offline, % online): changed since the review, or not listed — the placement job places them',
    n_stale_offline + n_stale_online, n_stale_offline, n_stale_online;
end $$;
`;
}

// ---- The fixture test ----------------------------------------------------------------

/** A fixture row's location that no listed lieu has. */
function changedLocation(b: Backfill, base: string): string {
  const listed = new Set(b.values.filter((v) => !v.online).map((v) => v.location));
  let changed = `${base} (modifié après la revue)`;
  while (listed.has(changed)) changed += " bis";
  return changed;
}

const PLACE_COLUMNS =
  "place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release";

/**
 * supabase/tests/backfill_places_fr.sql: the migration over fixture rows, in
 * a transaction rolled back. `include` is the migration's path from the test
 * file (psql's \ir; scripts/db-checks inlines it).
 */
export function testSql(b: Backfill, include: string): string {
  checkBackfill(b);
  const firstOffline = b.values.findIndex((v) => !v.online);
  const firstOnline = b.values.findIndex((v) => v.online);
  const extra: string[] = [];
  if (firstOffline >= 0) {
    const location = b.values[firstOffline].location;
    extra.push(
      `('changed', null, ${lit(changedLocation(b, location))}, null)`,
      `('placed', null, ${lit(location)}, null)`,
    );
  }
  if (firstOnline >= 0) {
    extra.push(
      `('renamed', ${firstOnline + 1}, 'Libellé changé (fixture)', ${lit(b.values[firstOnline].citycode!)})`,
    );
  }
  const listedRows = b.values.map((v, i) => `(${[i + 1, ...valueCells(v, false)].join(", ")})`);
  return `-- The reviewed backfill (${include}) over fixture rows, in a transaction
-- rolled back. Generated with it by scripts/place-backfill/generate.ts (${b.source},
-- ${b.generated}): do not edit.
--
--   * every listed lieu is placed exactly as listed, online rows under their own label;
--   * a row whose location changed since the review stays stale, untouched;
--   * a row already placed keeps its place;
--   * a second run changes nothing.
--
-- npm run db:check -- backfill (it inlines the \\ir lines), or psql -f from the repository root.

\\set ON_ERROR_STOP on
begin;

create temp table backfill_listed (n int primary key, ${V_DEFINITIONS}) on commit drop;
insert into backfill_listed (n, ${V_COLUMNS}) values
  ${listedRows.join(",\n  ")};

-- One audition never placed per listed lieu; then a row whose location changed
-- since the review, a row already placed, an online row whose label changed.
create temp table backfill_fixture (
  id uuid primary key default gen_random_uuid(), role text not null, n int, location text not null, citycode text
) on commit drop;
insert into backfill_fixture (role, n, location, citycode)
  select 'listed', n, location, citycode from backfill_listed;
${extra.length ? `insert into backfill_fixture (role, n, location, citycode) values\n  ${extra.join(",\n  ")};\n` : ""}
-- Online rows: one per town hall and month, months no real row has.
insert into public.auditions (id, title, "date", location, content, status, audition_en_ligne, citycode, place)
select f.id, 'Backfill fixture',
       (date '1800-01-01' + pg_catalog.make_interval(months => (row_number() over (order by f.id))::int))::date,
       f.location, 'Backfill fixture', 'published', f.citycode is not null, f.citycode,
       case when f.citycode is not null
            then pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('lat', l.lat, 'lng', l.lng)) end
  from backfill_fixture f left join backfill_listed l on l.n = f.n;
update public.auditions a
   set lieu_key = 'backfill fixture', place_precision = 'unplaced', placed_location = a.location
  from backfill_fixture f
 where f.id = a.id and f.role = 'placed';

\\ir ${include}

do $$
declare bad text;
begin
  select string_agg(coalesce(l.citycode, l.location), ' | ' order by l.n) into bad
    from backfill_fixture f
    join public.auditions a on a.id = f.id
    join backfill_listed l on l.n = f.n
   where f.role in ('listed', 'renamed')
     and not (a.place_unit is not distinct from l.unit
          and a.place_path is not distinct from l.path
          and a.locality_id is not distinct from l.locality
          and a.lieu_key is not distinct from (case when l.online then a.location else l.key end)
          and a.lat is not distinct from l.lat
          and a.lng is not distinct from l.lng
          and a.place_precision is not distinct from l.prec
          and a.place_candidates is not distinct from l.cand
          and a.placed_location is not distinct from a.location
          and a.placed_rules is not distinct from (case when l.online then null else ${lit(b.rules)} end)
          and a.geo_release is not distinct from l.release
          and not a.place_stale);
  if bad is not null then
    raise exception 'backfill: not placed as listed: %', bad;
  end if;
  select string_agg(f.location, ' | ') into bad
    from backfill_fixture f join public.auditions a on a.id = f.id
   where f.role = 'changed'
     and not (a.place_stale and a.placed_location is null and a.place_path is null and a.lieu_key is null);
  if bad is not null then
    raise exception 'backfill: a row changed since the review was placed: %', bad;
  end if;
  select string_agg(f.location, ' | ') into bad
    from backfill_fixture f join public.auditions a on a.id = f.id
   where f.role = 'placed'
     and not (a.lieu_key = 'backfill fixture' and a.place_precision = 'unplaced'
              and a.place_path is null and a.placed_rules is null and not a.place_stale);
  if bad is not null then
    raise exception 'backfill: a row already placed was placed again: %', bad;
  end if;
end $$;

create temp table backfill_auditions_once on commit drop as
  select id, ${PLACE_COLUMNS} from public.auditions;
create temp table backfill_units_once on commit drop as select * from public.geo_units;

\\ir ${include}

do $$
begin
  if exists (select * from backfill_auditions_once
             except select id, ${PLACE_COLUMNS} from public.auditions)
     or exists (select id, ${PLACE_COLUMNS} from public.auditions
                except select * from backfill_auditions_once) then
    raise exception 'backfill: a second run changed auditions';
  end if;
  if exists (select * from backfill_units_once except select * from public.geo_units)
     or exists (select * from public.geo_units except select * from backfill_units_once) then
    raise exception 'backfill: a second run changed geo_units';
  end if;
end $$;

rollback;
`;
}

/** The \ir lines of a psql script replaced by the files they name (psql inside a container reads no host file). */
export function inlineIncludes(sql: string, read: (path: string) => string): string {
  return sql.replace(/^\\ir[ \t]+(\S+)[ \t]*$/gm, (_, path: string) => read(path));
}

// ---- The expected list ----------------------------------------------------------------

/** supabase/tests/backfill_places_fr.expected.json */
export function expectedList(b: Backfill): ExpectedList {
  checkBackfill(b);
  const offline: Record<string, string[]> = {};
  const online: Record<string, string[]> = {};
  for (const v of b.values) {
    if (v.online) online[v.citycode!] = v.path ?? [];
    else offline[v.location] = v.path ?? [];
  }
  return {
    about: EXPECTED_ABOUT,
    migration: migrationFileOf(b.version),
    test: TEST_FILE,
    generated: b.generated,
    source: b.source,
    rules: b.rules,
    offline,
    online,
  };
}

/** The list before any backfill: nothing placed by a migration. */
export const NO_BACKFILL: ExpectedList = {
  about: EXPECTED_ABOUT,
  migration: null,
  test: null,
  generated: null,
  source: null,
  rules: null,
  offline: {},
  online: {},
};
