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
  /** Offline: the lieu's point. Online: null — each row keeps the point it stored. */
  lat: number | null;
  lng: number | null;
  /** Online: the town hall's (each row without a point of its own is on no point). */
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

/** The migration's DO block is quoted with this tag: no value may hold it. */
const TAG = "$backfill$";

/** Refuses a backfill the UPDATE would apply ambiguously, or the table would refuse. */
export function checkBackfill(b: Backfill): void {
  if (!/^\d{14}$/.test(b.version)) throw new Error(`version ${b.version}: YYYYMMDDHHMMSS`);
  if (!/^[0-9a-f]{8}$/.test(b.rules)) throw new Error(`rules hash ${b.rules}: 8 hex`);
  if (b.values.length === 0) throw new Error("nothing to backfill: no lieu");
  if (JSON.stringify(b).includes(TAG)) throw new Error(`a value holds ${TAG}, the SQL's quote`);
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
    if (placed && v.path!.at(-1) !== v.unit) {
      throw new Error(`${match}: a placed lieu's unit ends its path`);
    }
    const point = v.lat !== null && v.lng !== null;
    if (v.online ? v.lat !== null || v.lng !== null : placed !== point) {
      throw new Error(
        `${match}: an offline lieu has a point if and only if it is placed; a town hall has none (each month keeps its own)`,
      );
    }
    if (v.online && (v.candidates !== null || (v.release === null) === placed)) {
      throw new Error(`${match}: a town hall has no candidates, and a release when placed`);
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

/** The offline UPDATE's VALUES columns, and their types. */
const OFFLINE: [column: string, type: string][] = [
  ["location", "text"],
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
/** The town halls' (online). */
const HALLS: [column: string, type: string][] = [
  ["citycode", "text"],
  ["unit", "text"],
  ["path", "text[]"],
  ["locality", "text"],
  ["prec", "text"],
  ["release", "text"],
];

/** VALUES rows of these cells, the first one typed (the others follow it). */
function valuesSql(rows: string[][], types: [string, string][], indent: string): string {
  return rows
    .map((cells, i) => {
      const typed =
        i > 0
          ? cells
          : cells.map((cell, c) => {
              const type = types[c][1];
              return cell.endsWith(`::${type}`) || type === "boolean" ? cell : `${cell}::${type}`;
            });
      return `(${typed.join(", ")})`;
    })
    .join(`,\n${indent}`);
}

const offlineCells = (v: BackfillValue) => [
  lit(v.location),
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
const hallCells = (v: BackfillValue) => [
  lit(v.citycode!),
  textOrNull(v.unit),
  arrayOrNull(v.path),
  textOrNull(v.locality),
  lit(v.precision),
  textOrNull(v.release),
];

/** An online row's place holds a point, as the API reads it (place.lat and place.lng, numbers). */
const HAS_POINT =
  "coalesce(pg_catalog.jsonb_typeof(a.place->'lat'), '') = 'number' and coalesce(pg_catalog.jsonb_typeof(a.place->'lng'), '') = 'number'";

/** supabase/migrations/<version>_backfill_places_fr.sql */
export function migrationSql(b: Backfill, review: string): string {
  checkBackfill(b);
  const offline = b.values.filter((v) => !v.online);
  const halls = b.values.filter((v) => v.online);
  const known = halls.filter((v) => v.path !== null);
  const unitsSql = b.units.length
    ? `insert into public.geo_units (id, parent_id, level, country, name, code, lat, lng, source, geo_release) values
  ${b.units.map(unitRow).join(",\n  ")}
on conflict (id) do nothing;`
    : "-- No lieu is on a point: no unit to insert.";
  const ind = "      ";
  const statements: string[] = [];
  if (offline.length) {
    statements.push(`  -- Offline: the rows never placed whose raw location is a reviewed spelling,
  -- as its lieu is listed.
  with v (${OFFLINE.map(([c]) => c).join(", ")}) as (values
      ${valuesSql(offline.map(offlineCells), OFFLINE, ind)}
  ),
  placed as (
    update public.auditions a
       set place_unit = v.unit, place_path = v.path, locality_id = v.locality, lieu_key = v.key,
           lat = v.lat, lng = v.lng, place_precision = v.prec, place_candidates = v.cand,
           placed_location = a.location, placed_rules = ${lit(b.rules)}, geo_release = v.release
      from v
     where a.placed_location is null
       and not a.audition_en_ligne
       and a.location = v.location
    returning a.place_path is not null as on_map
  )
  select count(*) filter (where on_map), count(*) filter (where not on_map),
         (select count(*) from public.auditions a join v on a.location = v.location
           where not a.audition_en_ligne and a.placed_location is not null)
    into n_map, n_nowhere, n_kept_offline
    from placed;`);
  }
  if (known.length) {
    statements.push(`  -- Online: the rows never placed of a reviewed town hall (by code), each at
  -- the point it stored, under the town hall's units, its own label as lieu key.
  -- A point out of range is left alone (stale), as the API could not store it.
  with t (${HALLS.map(([c]) => c).join(", ")}) as (values
      ${valuesSql(known.map(hallCells), HALLS, ind)}
  ),
  placed as (
    update public.auditions a
       set place_unit = t.unit, place_path = t.path, locality_id = t.locality, lieu_key = a.location,
           lat = (a.place->>'lat')::double precision, lng = (a.place->>'lng')::double precision,
           place_precision = t.prec, place_candidates = null,
           placed_location = a.location, placed_rules = null, geo_release = t.release
      from t
     where a.placed_location is null
       and a.audition_en_ligne
       and a.citycode = t.citycode
       and case when ${HAS_POINT}
                then (a.place->'lat')::numeric between -90 and 90
                     and (a.place->'lng')::numeric between -180 and 180
                else false end
    returning a.id
  )
  select count(*),
         (select count(*) from public.auditions a join t on a.citycode = t.citycode
           where a.audition_en_ligne and a.placed_location is not null)
    into n_own, n_kept_online
    from placed;`);
  }
  if (halls.length) {
    statements.push(`  -- Online: the other rows never placed of a reviewed town hall, with no point
  -- of their own (or of a town hall geo.api does not know): on no point.
  with t (citycode, known) as (values
      ${valuesSql(
        halls.map((v) => [lit(v.citycode!), String(v.path !== null)]),
        [
          ["citycode", "text"],
          ["known", "boolean"],
        ],
        ind,
      )}
  )
  update public.auditions a
     set place_unit = null, place_path = null, locality_id = null, lieu_key = a.location,
         lat = null, lng = null, place_precision = 'unplaced', place_candidates = null,
         placed_location = a.location, placed_rules = null, geo_release = null
    from t
   where a.placed_location is null
     and a.audition_en_ligne
     and a.citycode = t.citycode
     and (not t.known or not (${HAS_POINT}));
  get diagnostics n_pointless = row_count;`);
  }
  return `-- The reviewed backfill of a database's places (map phase 1, design B4).
-- Generated by scripts/place-backfill/generate.ts from ${b.source}, read
-- ${b.generated} with the publishable key; reviewed in ${review}.
-- Do not edit: generate it again, and review that.
--
-- Places the auditions never placed (placed_location is null) that the review
-- lists: ${offline.length} offline lieu spelling(s) matched by their exact raw location,
-- ${halls.length} town hall(s) matched by code (each online row at its own stored point,
-- under its own label). A row changed since the review matches nothing and
-- stays stale, for the API's placement job; a row already placed is left as
-- it is; running it again changes nothing. Offline rows are stamped with the
-- LOCATION_RULES hash they were computed under (${b.rules}); online rows,
-- as the API files them, with none. The NOTICEs count what this run placed.

set lock_timeout = '200ms';

${unitsSql}

do ${TAG}
declare
  n_map bigint := 0;
  n_nowhere bigint := 0;
  n_own bigint := 0;
  n_pointless bigint := 0;
  n_kept_offline bigint := 0;
  n_kept_online bigint := 0;
  n_stale_offline bigint;
  n_stale_online bigint;
begin
${statements.join("\n\n")}

  select count(*) filter (where place_stale and not audition_en_ligne),
         count(*) filter (where place_stale and audition_en_ligne)
    into n_stale_offline, n_stale_online
    from public.auditions;
  raise notice '${MIGRATION_NAME}: placed now: % offline auditions (% on the map, % on no point), % online (% at their own point, % on no point)',
    n_map + n_nowhere, n_map, n_nowhere, n_own + n_pointless, n_own, n_pointless;
  raise notice '${MIGRATION_NAME}: % listed auditions were already placed (by the placement job, or a run before this one): left as they were (% offline, % online)',
    n_kept_offline + n_kept_online, n_kept_offline, n_kept_online;
  raise notice '${MIGRATION_NAME}: % auditions still stale (% offline, % online): changed since the review, or not listed — the placement job places them',
    n_stale_offline + n_stale_online, n_stale_offline, n_stale_online;
end
${TAG};
`;
}

// ---- The fixture test ----------------------------------------------------------------

/** A text no listed value has, from `base`. */
function unlisted(taken: Set<string>, base: string, more: string): string {
  let text = base;
  while (taken.has(text)) text += more;
  return text;
}

const PLACE_COLUMNS =
  "place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release";

/** The fixture's listed values: every value, numbered, in V's shape. */
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

/**
 * supabase/tests/backfill_places_fr.sql: the migration over fixture rows, in
 * a transaction rolled back. `include` is the migration's path from the test
 * file (psql's \ir; scripts/db-checks inlines it).
 */
export function testSql(b: Backfill, include: string): string {
  checkBackfill(b);
  const firstOffline = b.values.findIndex((v) => !v.online);
  // A town hall geo.api knows, if any: its rows are placed at their own point.
  const knownHall = b.values.findIndex((v) => v.online && v.path !== null);
  const firstOnline = knownHall >= 0 ? knownHall : b.values.findIndex((v) => v.online);
  const spellings = new Set(b.values.filter((v) => !v.online).map((v) => v.location));
  const codes = new Set(b.values.filter((v) => v.online).map((v) => v.citycode!));
  const extra: string[] = [];
  const fixture = (
    role: string,
    n: number | null,
    location: string,
    online: boolean,
    citycode: string | null,
    place: string | null,
  ) =>
    `(${[lit(role), n ?? "null", lit(location), online, textOrNull(citycode), place === null ? "null" : `${lit(place)}::jsonb`].join(", ")})`;
  if (firstOffline >= 0) {
    const location = b.values[firstOffline].location;
    extra.push(
      fixture(
        "changed",
        null,
        unlisted(spellings, `${location} (modifié après la revue)`, " bis"),
        false,
        null,
        null,
      ),
      fixture("placed", null, location, false, null, null),
      // An online row of a town hall not listed, whose label is a listed spelling.
      fixture(
        "untouched",
        null,
        location,
        true,
        unlisted(codes, "99999", "9"),
        '{"lat": 45.1, "lng": 5.1}',
      ),
    );
  }
  if (firstOnline >= 0) {
    const n = firstOnline + 1;
    const code = b.values[firstOnline].citycode!;
    extra.push(
      // Offline rows carrying a listed town hall's code, with a point and without.
      fixture(
        "untouched",
        null,
        unlisted(spellings, "Lieu non revu (fixture)", " bis"),
        false,
        code,
        '{"lat": 45.2, "lng": 5.2}',
      ),
      fixture(
        "untouched",
        null,
        unlisted(spellings, "Autre lieu non revu (fixture)", " bis"),
        false,
        code,
        null,
      ),
      fixture("renamed", n, "Libellé changé (fixture)", true, code, '{"lat": 11.5, "lng": 21.5}'),
      fixture("pointless", n, "Sans point (fixture)", true, code, "{}"),
    );
    if (knownHall >= 0) {
      extra.push(
        fixture("far", n, "Point hors limites (fixture)", true, code, '{"lat": 95, "lng": 5}'),
      );
    }
  }
  const listedRows = b.values.map(
    (v, i) =>
      `(${[
        i + 1,
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
      ].join(", ")})`,
  );
  return `-- The reviewed backfill (${include}) over fixture rows, in a transaction
-- rolled back. Generated with it by scripts/place-backfill/generate.ts (${b.source},
-- ${b.generated}): do not edit.
--
--   * every listed offline spelling is placed exactly as listed;
--   * every online row of a listed town hall is placed under its units at its
--     own point, under its own label — or on no point without one;
--   * a row changed since the review, an offline row carrying a listed town
--     hall's code, an online row labelled like a listed spelling and an online
--     point out of range stay stale, untouched;
--   * a row already placed keeps its place;
--   * a second run changes nothing.
--
-- npm run db:check -- backfill (it inlines the \\ir lines), or psql -f from the repository root.

\\set ON_ERROR_STOP on
begin;

create temp table backfill_listed (n int primary key, ${V.map(([c, t]) => `${c} ${t}`).join(", ")}) on commit drop;
insert into backfill_listed (n, ${V.map(([c]) => c).join(", ")}) values
  ${listedRows.join(",\n  ")};

-- One audition never placed per listed value (online: with a point of its
-- own); then the rows the migration must place otherwise, or not at all.
create temp table backfill_fixture (
  id uuid primary key default gen_random_uuid(), role text not null, n int,
  location text not null, online boolean not null, citycode text, place jsonb
) on commit drop;
insert into backfill_fixture (role, n, location, online, citycode, place)
  select 'listed', n, location, online, citycode,
         case when online then pg_catalog.jsonb_build_object('lat', 10 + n / 1000.0, 'lng', 20 + n / 1000.0) end
    from backfill_listed;
${extra.length ? `insert into backfill_fixture (role, n, location, online, citycode, place) values\n  ${extra.join(",\n  ")};\n` : ""}
-- One month each, months no real row has (online rows are one per town hall and month).
insert into public.auditions (id, title, "date", location, content, status, audition_en_ligne, citycode, place)
select f.id, 'Backfill fixture',
       (date '1800-01-01' + pg_catalog.make_interval(months => (row_number() over (order by f.id))::int))::date,
       f.location, 'Backfill fixture', 'published', f.online, f.citycode, f.place
  from backfill_fixture f;
update public.auditions a
   set lieu_key = 'backfill fixture', place_precision = 'unplaced', placed_location = a.location
  from backfill_fixture f
 where f.id = a.id and f.role = 'placed';

\\ir ${include}

do $$
declare bad text;
begin
  select string_agg(l.location, ' | ' order by l.n) into bad
    from backfill_fixture f
    join public.auditions a on a.id = f.id
    join backfill_listed l on l.n = f.n
   where f.role = 'listed' and not l.online
     and not (a.place_unit is not distinct from l.unit
          and a.place_path is not distinct from l.path
          and a.locality_id is not distinct from l.locality
          and a.lieu_key is not distinct from l.key
          and a.lat is not distinct from l.lat
          and a.lng is not distinct from l.lng
          and a.place_precision is not distinct from l.prec
          and a.place_candidates is not distinct from l.cand
          and a.placed_location is not distinct from a.location
          and a.placed_rules is not distinct from ${lit(b.rules)}
          and a.geo_release is not distinct from l.release
          and not a.place_stale);
  if bad is not null then
    raise exception 'backfill: not placed as listed: %', bad;
  end if;
  -- Online: the town hall's units at the row's own point, or no point without one.
  select string_agg(l.citycode || ' (' || f.location || ')', ' | ' order by l.n, f.location) into bad
    from backfill_fixture f
    join public.auditions a on a.id = f.id
    join backfill_listed l on l.n = f.n
    cross join lateral (select l.path is not null and f.place ? 'lat' as here) p
   where f.role in ('listed', 'renamed', 'pointless') and l.online
     and not (a.place_unit is not distinct from (case when p.here then l.unit end)
          and a.place_path is not distinct from (case when p.here then l.path end)
          and a.locality_id is not distinct from (case when p.here then l.locality end)
          and a.lieu_key is not distinct from a.location
          and a.lat is not distinct from (case when p.here then (f.place->>'lat')::double precision end)
          and a.lng is not distinct from (case when p.here then (f.place->>'lng')::double precision end)
          and a.place_precision is not distinct from (case when p.here then l.prec else 'unplaced' end)
          and a.place_candidates is null
          and a.placed_location is not distinct from a.location
          and a.placed_rules is null
          and a.geo_release is not distinct from (case when p.here then l.release end)
          and not a.place_stale);
  if bad is not null then
    raise exception 'backfill: an online row not placed at its own point under its town hall: %', bad;
  end if;
  select string_agg(f.role || ': ' || f.location, ' | ') into bad
    from backfill_fixture f join public.auditions a on a.id = f.id
   where f.role in ('changed', 'untouched', 'far')
     and not (a.place_stale and a.placed_location is null and a.place_path is null
              and a.lieu_key is null and a.place_precision is null and a.lat is null);
  if bad is not null then
    raise exception 'backfill: a row it must leave alone was placed: %', bad;
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
