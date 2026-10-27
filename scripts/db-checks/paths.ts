// Place paths. place_path repeats the ancestry geo_units holds; only the
// API, the backfill, the seed and the remap write it, always from a
// geo_units chain, and this keeps them honest:
//
// - every stored place_path equals the geo_units parent chain of its
//   place_unit, root first, and locality_id lies on it (the database's rows);
// - the same query, on fixture rows in a rolled-back transaction, finds
//   exactly the broken ones (a chain that skips a level, another country, a
//   locality off the path, a cycle);
// - the CHECK constraints refuse malformed rows, and the generated columns
//   refuse writers;
// - a remap as the design does it (insert the new unit, repoint children and
//   rows, delete the old one) passes every CHECK and keeps the paths whole,
//   while renaming a referenced id in place is refused.

import { randomUUID } from "node:crypto";
import { insertUnits, lieuId, pathOf, textArray, UNITS } from "./places";
import { lit, sqlJson } from "./psql";

interface Problem {
  id: string;
  path: string[];
  chain: string[] | null;
  locality: string | null;
}

/** The placed auditions whose path is not their unit's chain, or whose
 *  locality is off the path; one jsonb array. */
const integrity = (where = "true") => `
with recursive up as (
  select a.id as audition, g.id as unit, g.parent_id as parent, array[g.id] as chain, 1 as depth
    from public.auditions a join public.geo_units g on g.id = a.place_unit
   where a.place_path is not null
  union all
  select u.audition, g.id, g.parent_id, g.id || u.chain, u.depth + 1
    from up u join public.geo_units g on g.id = u.parent
   where u.depth < 16
)
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         'id', a.id, 'path', a.place_path, 'chain', u.chain, 'locality', a.locality_id) order by a.id),
       '[]'::jsonb)
  from public.auditions a
  left join up u on u.audition = a.id and u.parent is null
 where a.place_path is not null and (${where})
   and (u.chain is distinct from a.place_path
        or (a.locality_id is not null and a.locality_id <> all (a.place_path)));`;

const show = (p: Problem) =>
  `${p.id}: path ${JSON.stringify(p.path)}, chain ${JSON.stringify(p.chain)}, locality ${p.locality}`;

/** Runs a statement and rolls it back: "accepted", or the SQLSTATE and the
 *  constraint that refused it. */
const ATTEMPT = `
create function pg_temp.attempt(p_sql text) returns text language plpgsql as $$
declare v_state text; v_constraint text;
begin
  execute p_sql;
  raise exception 'db:check accepted';
exception when others then
  if sqlerrm = 'db:check accepted' then return 'accepted'; end if;
  get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
  return v_state || coalesce(' ' || nullif(v_constraint, ''), '');
end $$;`;

/** The remap of design C7 (old → new, in one transaction): the number of
 *  auditions repointed. Here new copies old under another id. */
const REMAP = `
create function pg_temp.remap(p_old text, p_new text, p_release text) returns integer
language plpgsql as $$
declare n integer;
begin
  insert into public.geo_units (id, parent_id, level, country, name, code, lat, lng, polygon, wikidata, source, geo_release)
  select p_new, parent_id, level, country, name, code, lat, lng, polygon, wikidata, source, p_release
    from public.geo_units where id = p_old
  on conflict (id) do nothing;
  update public.geo_units set parent_id = p_new where parent_id = p_old;
  update public.auditions a set
      place_unit  = case when a.place_unit = p_old then p_new else a.place_unit end,
      place_path  = pg_catalog.array_replace(a.place_path, p_old, p_new),
      locality_id = case when a.locality_id = p_old then p_new else a.locality_id end,
      citycode    = case when a.audition_en_ligne and a.citycode = p_old
                          and not exists (select 1 from public.auditions b
                                           where b.audition_en_ligne and b.citycode = p_new and b."date" = a."date")
                         then p_new else a.citycode end,
      geo_release = p_release
   where a.place_path @> array[p_old];
  get diagnostics n = row_count;
  delete from public.geo_units where id = p_old;
  return n;
end $$;`;

type Columns = Record<string, string>;

const BASE: Columns = {
  title: "'db:check'",
  date: "current_date",
  location: "'Lyon'",
  content: "'Contrôle'",
};

/** A row placed at a unit, as the API would write it. */
function placedAt(unit: string, key = "Lyon", path = pathOf(unit)): Columns {
  return {
    place_unit: lit(unit),
    place_path: textArray(path),
    locality_id: lit(path.find((id) => id.startsWith("fr:com:")) ?? path[path.length - 1]),
    lieu_key: lit(key),
    lat: "45.76",
    lng: "4.83",
    place_precision: "'commune'",
    placed_location: "location",
  };
}

/** An insert of an audition; a column given as "location" copies location. */
function insertAudition(columns: Columns, id?: string): string {
  const c: Columns = { ...(id ? { id: lit(id) } : {}), ...BASE, ...columns };
  const values = Object.values(c).map((v) => (v === "location" ? c.location : v));
  return `insert into public.auditions (${Object.keys(c).join(", ")}) values (${values.join(", ")})`;
}

const LYON = placedAt("fr:com:69123");
const ok = "accepted";
const check = (name: string) => `23514 ${name}`;

/** Malformed rows and writes, each with what must refuse it. */
const ATTEMPTS: [label: string, sql: string, expected: string][] = [
  ["a placed row", insertAudition(LYON), ok],
  ["a row never placed", insertAudition({}), ok],
  [
    "a row unplaced after an attempt",
    insertAudition({
      place_precision: "'unplaced'",
      placed_location: "location",
      place_candidates: `'[{"name": "Saint-Denis", "departementCode": "93"}]'::jsonb`,
    }),
    ok,
  ],
  [
    "a row placed at its département",
    insertAudition({
      ...placedAt("fr:dep:69"),
      locality_id: "null",
      place_precision: "'departement'",
    }),
    ok,
  ],
  [
    "a precision outside the list",
    insertAudition({ ...LYON, place_precision: "'street'" }),
    check("auditions_place_precision"),
  ],
  ["lat without lng", insertAudition({ ...LYON, lng: "null" }), check("auditions_place_point")],
  ["lat beyond 90", insertAudition({ ...LYON, lat: "91" }), check("auditions_place_point")],
  ["lng beyond 180", insertAudition({ ...LYON, lng: "-181" }), check("auditions_place_point")],
  [
    "a NaN latitude",
    insertAudition({ ...LYON, lat: "'NaN'::double precision" }),
    check("auditions_place_point"),
  ],
  [
    "a path without its unit",
    insertAudition({ ...LYON, place_unit: "null" }),
    check("auditions_place_path"),
  ],
  [
    "a unit without a path",
    insertAudition({ place_unit: "'fr:com:69123'" }),
    check("auditions_place_path"),
  ],
  [
    "a path that does not end on its unit",
    insertAudition({ ...LYON, place_path: textArray(pathOf("fr:dep:69")) }),
    check("auditions_place_path"),
  ],
  [
    "a path that does not start at a country",
    insertAudition({ ...LYON, place_path: textArray(pathOf("fr:com:69123").slice(1)) }),
    check("auditions_place_path"),
  ],
  [
    "a path holding a NULL",
    insertAudition({ ...LYON, place_path: "array['FR', null, 'fr:com:69123']::text[]" }),
    check("auditions_place_path"),
  ],
  [
    "an empty path",
    insertAudition({ ...LYON, place_path: "'{}'::text[]" }),
    check("auditions_place_path"),
  ],
  [
    "a path deeper than 8",
    insertAudition({
      ...LYON,
      place_path: textArray(["FR", "a", "b", "c", "d", "e", "f", "g", "fr:com:69123"]),
    }),
    check("auditions_place_path"),
  ],
  [
    "a two-dimensional path",
    insertAudition({
      ...LYON,
      place_path: "'{{FR,fr:com:69123},{FR,fr:com:69123}}'::text[]",
    }),
    check("auditions_place_path"),
  ],
  [
    "a path indexed from 0",
    insertAudition({
      ...LYON,
      place_path: "'[0:3]={FR,fr:reg:84,fr:dep:69,fr:com:69123}'::text[]",
    }),
    check("auditions_place_path"),
  ],
  [
    "a precision without a path",
    insertAudition({ place_precision: "'commune'", placed_location: "location" }),
    check("auditions_place_placed"),
  ],
  [
    "a path without a precision",
    insertAudition({ ...LYON, place_precision: "null" }),
    check("auditions_place_placed"),
  ],
  [
    "a path marked unplaced",
    insertAudition({ ...LYON, place_precision: "'unplaced'" }),
    check("auditions_place_placed"),
  ],
  [
    "a path without a lieu key",
    insertAudition({ ...LYON, lieu_key: "null" }),
    check("auditions_place_lieu"),
  ],
  [
    "a path without a point",
    insertAudition({ ...LYON, lat: "null", lng: "null" }),
    check("auditions_place_lieu"),
  ],
  [
    "a unit missing from geo_units",
    insertAudition({
      ...LYON,
      place_unit: "'fr:com:00000'",
      place_path: textArray(["FR", "fr:reg:84", "fr:dep:69", "fr:com:00000"]),
    }),
    "23503 auditions_place_unit_fkey",
  ],
  ["place_stale written", insertAudition({ place_stale: "false" }), "428C9"],
  ["lieu_id written", insertAudition({ ...LYON, lieu_id: "'l:0000000000000000'" }), "428C9"],
  [
    "place_stale updated",
    "update public.auditions set place_stale = false where place_stale",
    "428C9",
  ],
  [
    "a région without a parent",
    "insert into public.geo_units (id, level, country, name, source, geo_release) values ('db-check-x', 'region', 'FR', 'X', 'insee', 'db-check')",
    check("geo_units_root"),
  ],
  [
    "a country with a parent",
    "insert into public.geo_units (id, parent_id, level, country, name, source, geo_release) values ('db-check-x', 'FR', 'country', 'FR', 'X', 'insee', 'db-check')",
    check("geo_units_root"),
  ],
  [
    "an unknown level",
    "insert into public.geo_units (id, parent_id, level, country, name, source, geo_release) values ('db-check-x', 'FR', 'city', 'FR', 'X', 'insee', 'db-check')",
    check("geo_units_level_check"),
  ],
  [
    "a lower-case country",
    "insert into public.geo_units (id, level, country, name, source, geo_release) values ('db-check-x', 'country', 'fr', 'X', 'insee', 'db-check')",
    check("geo_units_country_check"),
  ],
  [
    "an unknown source",
    "insert into public.geo_units (id, level, country, name, source, geo_release) values ('db-check-x', 'country', 'XX', 'X', 'osm', 'db-check')",
    check("geo_units_source_check"),
  ],
  [
    "a missing parent",
    "insert into public.geo_units (id, parent_id, level, country, name, source, geo_release) values ('db-check-x', 'db-check-none', 'region', 'FR', 'X', 'insee', 'db-check')",
    "23503 geo_units_parent_id_fkey",
  ],
  [
    "a unit an audition names, renamed in place",
    // To an id no database holds: a placed one has Lyon 8e already.
    "update public.geo_units set id = 'fr:com:00000' where id = 'fr:com:69387'",
    "23503 auditions_place_unit_fkey",
  ],
  [
    "a unit with children, renamed in place",
    "update public.geo_units set id = 'fr:reg:99' where id = 'fr:reg:84'",
    "23503 geo_units_parent_id_fkey",
  ],
  [
    "a unit an audition names, deleted",
    "delete from public.geo_units where id = 'fr:com:69387'",
    "23503 auditions_place_unit_fkey",
  ],
];

interface Fixture {
  label: string;
  id: string;
  sql: string;
  broken: boolean;
}

function fixtures(): Fixture[] {
  const row = (label: string, columns: Columns, broken: boolean, extra: Columns = {}) => {
    const id = randomUUID();
    return { label, id, sql: insertAudition({ ...columns, ...extra }, id), broken };
  };
  const berlin = "db-check-de-locality";
  return [
    row("Lyon 7e", placedAt("fr:com:69387", "Lyon 7e"), false),
    row("Lyon", LYON, false),
    row(
      "Rhône",
      { ...placedAt("fr:dep:69", "Rhône"), locality_id: "null", place_precision: "'departement'" },
      false,
    ),
    row("Berlin", { ...placedAt(berlin, "Berlin"), place_precision: "'locality'" }, false),
    row(
      "Berlin, online",
      { ...placedAt(berlin, "Berlin (Allemagne)"), place_precision: "'locality'" },
      false,
      {
        audition_en_ligne: "true",
        citycode: lit(berlin),
        place: `'{}'::jsonb`,
        date: "pg_catalog.date_trunc('month', current_date)::date",
      },
    ),
    row(
      "a path that skips the région",
      { ...LYON, place_path: textArray(["FR", "fr:dep:69", "fr:com:69123"]) },
      true,
    ),
    row(
      "a path that skips the commune",
      {
        ...placedAt("fr:com:69387"),
        locality_id: "null",
        place_path: textArray(["FR", "fr:reg:84", "fr:dep:69", "fr:com:69387"]),
      },
      true,
    ),
    row(
      "a path under another country",
      {
        ...placedAt("fr:dep:69"),
        locality_id: "null",
        place_precision: "'departement'",
        place_path: textArray(["DE", "fr:reg:84", "fr:dep:69"]),
      },
      true,
    ),
    row(
      "a locality off the path",
      { ...placedAt("fr:dep:69"), locality_id: "'fr:com:69123'", place_precision: "'departement'" },
      true,
    ),
    row(
      "a unit in a cycle",
      {
        ...placedAt("db-check-loop-a", "Boucle", ["DE", "db-check-loop-b", "db-check-loop-a"]),
        locality_id: "null",
        place_precision: "'region'",
      },
      true,
    ),
  ];
}

const CYCLE = `
insert into public.geo_units (id, parent_id, level, country, name, source, geo_release) values
  ('db-check-loop-a', 'db-check-loop-b', 'region', 'DE', 'Boucle A', 'overture', 'db-check'),
  ('db-check-loop-b', 'db-check-loop-a', 'region', 'DE', 'Boucle B', 'overture', 'db-check');`;

/** The remaps rehearsed: a commune with an arrondissement under it, and a
 *  locality abroad that names an online bucket (its citycode). */
const REMAPS: [from: string, to: string][] = [
  ["fr:com:69123", "fr:com:69900"],
  ["db-check-de-locality", "db-check-de-locality-2"],
];

interface Placed {
  unit: string;
  path: string[];
  locality: string | null;
  citycode: string | null;
  key: string;
  lieu: string;
  release: string | null;
}

/** The place columns of some auditions, by id: one jsonb object. */
const snapshot = (ids: string) => `
select coalesce(pg_catalog.jsonb_object_agg(a.id, pg_catalog.jsonb_build_object(
         'unit', a.place_unit, 'path', a.place_path, 'locality', a.locality_id, 'citycode', a.citycode,
         'key', a.lieu_key, 'lieu', a.lieu_id, 'release', a.geo_release)), '{}'::jsonb)
  from public.auditions a where a.id = any (${ids});`;

export function checkPaths(): string[] {
  const errors: string[] = [];

  const [stored] = sqlJson<Problem[]>(integrity());
  for (const p of stored) errors.push(`stored path is not its unit's chain: ${show(p)}`);

  const rows = fixtures();
  const uuids = (rs: Fixture[]) =>
    `array[${rs.map((r) => `${lit(r.id)}::uuid`).join(", ")}]::uuid[]`;
  const all = uuids(rows);
  const good = uuids(rows.filter((r) => !r.broken));
  const touched = [...REMAPS.flat(), "fr:com:69387"];
  const out = sqlJson<unknown>(`
begin;
${ATTEMPT}
${REMAP}
${insertUnits(UNITS)}
${CYCLE}
${rows.map((r) => `${r.sql};`).join("\n")}
${integrity(`a.id = any (${all})`)}
select pg_catalog.jsonb_object_agg(label, pg_temp.attempt(statement))
  from (values ${ATTEMPTS.map(([label, sql]) => `(${lit(label)}, ${lit(sql)})`).join(",\n    ")}) as c(label, statement);
${snapshot(good)}
select pg_catalog.jsonb_build_array(${REMAPS.map(([from, to]) => `pg_temp.remap(${lit(from)}, ${lit(to)}, 'db-check-remap')`).join(", ")});
${integrity(`a.id = any (${all})`)}
${snapshot(good)}
select pg_catalog.jsonb_object_agg(x.id, case when g.id is null then 'gone' else coalesce(g.parent_id, 'root') end)
  from pg_catalog.unnest(${textArray(touched)}) as x(id)
  left join public.geo_units g on g.id = x.id;
rollback;`);
  const [found, attempts, placed, repointed, foundAfter, placedAfter, units] = out as [
    Problem[],
    Record<string, string>,
    Record<string, Placed>,
    number[],
    Problem[],
    Record<string, Placed>,
    Record<string, string>,
  ];

  const broken = new Set(rows.filter((r) => r.broken).map((r) => r.id));
  const label = new Map(rows.map((r) => [r.id, r.label]));
  const compareFound = (when: string, problems: Problem[]) => {
    const seen = new Set(problems.map((p) => p.id));
    for (const p of problems) {
      if (!broken.has(p.id)) errors.push(`${when}: "${label.get(p.id)}" flagged: ${show(p)}`);
    }
    for (const id of broken) {
      if (!seen.has(id)) errors.push(`${when}: "${label.get(id)}" not flagged`);
    }
  };
  compareFound("path integrity, fixture", found);

  for (const [what, sql, want] of ATTEMPTS) {
    const got = attempts[what];
    if (got !== want) errors.push(`${what}: ${got ?? "not run"}, expected ${want} (${sql})`);
  }

  // After the remaps: the paths are still whole (the same rows flagged), each
  // well-placed row names the new ids wherever it named the old ones, its
  // lieu id follows its unit, and the old units are gone.
  compareFound("path integrity, after the remap", foundAfter);
  const moved = new Map(REMAPS);
  const m = (id: string | null) => (id === null ? null : (moved.get(id) ?? id));
  REMAPS.forEach(([from], i) => {
    const holding = Object.values(placed).filter((p) => p.path.includes(from)).length;
    if (!(repointed[i] >= holding)) {
      errors.push(
        `the remap of ${from} repointed ${repointed[i]} auditions, fewer than ${holding}`,
      );
    }
  });
  for (const [id, was] of Object.entries(placed)) {
    const shifted = was.path.some((u) => moved.has(u));
    const want: Placed = {
      unit: m(was.unit)!,
      path: was.path.map((u) => m(u)!),
      locality: m(was.locality),
      citycode: m(was.citycode),
      key: was.key,
      lieu: lieuId(m(was.unit)!, was.key),
      release: shifted ? "db-check-remap" : was.release,
    };
    const now = placedAfter[id];
    for (const k of Object.keys(want) as (keyof Placed)[]) {
      if (JSON.stringify(now?.[k]) !== JSON.stringify(want[k])) {
        errors.push(
          `after the remap, "${label.get(id)}" ${k}: ${JSON.stringify(now?.[k])}, expected ${JSON.stringify(want[k])}`,
        );
      }
    }
  }
  const parents: Record<string, string> = {
    "fr:com:69123": "gone",
    "fr:com:69900": "fr:dep:69",
    "fr:com:69387": "fr:com:69900",
    "db-check-de-locality": "gone",
    "db-check-de-locality-2": "db-check-de-region",
  };
  for (const [id, parent] of Object.entries(parents)) {
    if (units[id] !== parent)
      errors.push(`after the remap, ${id}: ${units[id]}, expected ${parent}`);
  }
  return errors;
}
