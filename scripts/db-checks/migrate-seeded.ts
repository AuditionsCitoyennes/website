// Migrations on top of seeded data. CI builds its database by applying every
// migration to an empty one and only then loading the seed, so a migration
// that rewrites existing rows never meets any there. This rebuilds a local
// database as it stood before map phase 1, loads the seed into it with psql,
// in the shape of its rows then (SEED_SHAPE=legacy: no place column, no
// geo_units; profile SEED_PROFILE, all by default), then applies the newer
// migrations over the rows, as staging and production will see them, and
// checks the result: every testimony derived; the auditions the reviewed
// backfill lists placed exactly as it lists them (online rows at their own
// point), every other one stale; and the backfill run again changes nothing.
//
//   npm run db:check:seeded -- --yes --workdir <dir>
//     <dir>/supabase/config.toml, migrations/ (a copy, or a symlink)
//   … --seed <file>
//     another seed of that shape, instead of the one generated
//
// The expected list (backfill_places_fr.expected.json) is the one beside the
// migrations applied: supabase/tests next to the directory migrations/
// resolves to, else this repository's; BACKFILL_ROOT=<dir> names another (a
// generator's dry run). It must name the backfill the migrations hold.
//
// It wipes that stack's database: --yes is required. Outside CI it refuses the
// project's own stack (the project_id of supabase/config.toml, shared by every
// checkout and worktree, which holds a developer's local accounts): copy
// supabase/ to a scratch directory, give its config.toml its own project_id
// and ports, then `supabase db start --workdir <dir>`.
//
// The supabase CLI and psql reach the same stack: psql runs inside its
// database container (supabase_db_<project_id>), so PSQL and DATABASE_URL do
// not apply here. Supabase CLI 2.75: `db reset --version <v> --no-seed`, then
// `migration up`; both act on the local stack (--local is their default).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedSql, type Profile } from "../seed/generate";
import { expectedFor } from "./backfill";
import { sqlJson } from "./psql";

/** The last migration before phase 1: the shape the seed was written for. */
const BEFORE_PHASE_1 = "20261024234316";

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function projectId(config: string): string {
  const m = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(config, "utf8"));
  if (!m) fail(`${config} names no project_id.`);
  return m[1];
}

if (!process.argv.includes("--yes")) {
  fail("This wipes a local database: run it again with --yes.");
}
const workdir =
  option("--workdir") ??
  fail("Name the stack to reset with --workdir <dir> (see the script's header).");
const id = projectId(resolve(workdir, "supabase/config.toml"));
const ownId = projectId(fileURLToPath(new URL("../../supabase/config.toml", import.meta.url)));
if (id === ownId && process.env.CI !== "true") {
  fail(
    `${workdir} is the project's own stack (project_id ${id}): resetting it would wipe your ` +
      "local data. Run this on a scratch copy (see the script's header).",
  );
}
const container = `supabase_db_${id}`;
const state = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", container], {
  encoding: "utf8",
});
if (state.stdout?.trim() !== "true") {
  fail(`${container} is not running: supabase db start --workdir ${workdir}`);
}
const psql = `docker exec -i ${container} psql -U postgres -d postgres`;
if (process.env.PSQL || process.env.DATABASE_URL) {
  console.log(`PSQL and DATABASE_URL are ignored: the database is ${container}'s.`);
}
const from = option("--from") ?? BEFORE_PHASE_1;
const seedFile = option("--seed");
const profile = (process.env.SEED_PROFILE ?? "all") as Profile;
if (!seedFile && !["france", "world", "all"].includes(profile)) {
  fail(`SEED_PROFILE must be france, world or all (got "${profile}")`);
}
const migrations = resolve(workdir, "supabase/migrations");
let expected: ReturnType<typeof expectedFor>["list"];
try {
  const found = expectedFor(migrations);
  expected = found.list;
  console.log(`Expected list: ${found.file}`);
} catch (e) {
  fail((e as Error).message);
}
const backfill = expected.migration && resolve(migrations, expected.migration);

function supabase(...args: string[]) {
  const argv = [...args, "--workdir", workdir];
  console.log(`$ supabase ${argv.join(" ")}`);
  const r = spawnSync("supabase", argv, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function sql<T>(script: string): T[] {
  try {
    return sqlJson<T>(script, psql);
  } catch (e) {
    fail((e as Error).message);
  }
}

const seed = seedFile
  ? { sql: readFileSync(resolve(seedFile), "utf8"), summary: resolve(seedFile) }
  : seedSql(profile, "legacy");
supabase("db", "reset", "--version", from, "--no-seed");
console.log(`$ ${psql} < ${seedFile ? seed.summary : "the legacy-shaped seed"}`);
if (!seedFile) console.log(seed.summary);
sql(seed.sql);
supabase("migration", "up");

const [r] = sql<{ total: number; underived: number }>(`
select pg_catalog.jsonb_build_object(
  'total', count(*),
  'underived', count(*) filter (where derive_version is distinct from 1))
  from public.testimonies;`);
const errors: string[] = [];
if (r.total === 0) errors.push("the seed left no testimony");
if (r.underived > 0)
  errors.push(`${r.underived} of ${r.total} testimonies lack derive_version = 1`);

// Rows written before the place columns are never placed (stale, for the
// API to place), but those the reviewed backfill lists: placed as it lists
// them — an online row at the point it stored, on no point without one.
interface PlaceRow {
  id: string;
  location: string;
  online: boolean;
  citycode: string | null;
  place: unknown;
  path: string[] | null;
  precision: string | null;
  lat: number | null;
  lng: number | null;
  placed: string | null;
  stale: boolean;
  rules: string | null;
  key: string | null;
}
const [rows] = sql<PlaceRow[]>(`
select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'id', id, 'location', location, 'online', audition_en_ligne, 'citycode', citycode,
  'place', place, 'path', place_path, 'precision', place_precision, 'lat', lat, 'lng', lng,
  'placed', placed_location, 'stale', place_stale, 'rules', placed_rules, 'key', lieu_key)
  order by id), '[]'::jsonb)
  from public.auditions;`);

/** An online row's stored point, as the API reads it (onlinePlaceOf); 'far' when out of range. */
function ownPoint(place: unknown): { lat: number; lng: number } | "far" | null {
  const p = place && typeof place === "object" ? (place as { lat?: unknown; lng?: unknown }) : {};
  if (typeof p.lat !== "number" || typeof p.lng !== "number") return null;
  return Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 ? { lat: p.lat, lng: p.lng } : "far";
}
if (rows.length === 0) errors.push("the seed left no audition");
const sameList = (a: string[] | null, b: string[] | null) =>
  JSON.stringify(a) === JSON.stringify(b);
let listed = 0;
for (const row of rows) {
  const list = row.online ? expected.online : expected.offline;
  const at = row.online ? row.citycode : row.location;
  if (at === null || !Object.hasOwn(list, at)) {
    if (!row.stale || row.placed !== null || row.path !== null) {
      errors.push(`${row.id} (${row.location}): not listed by the backfill, yet placed`);
    }
    continue;
  }
  const own = row.online ? ownPoint(row.place) : null;
  if (row.online && list[at].length && own === "far") {
    // Out of range: the backfill leaves it alone, as the API could not store it.
    if (!row.stale || row.placed !== null) {
      errors.push(`${row.id} (${row.location}): a point out of range, yet placed`);
    }
    continue;
  }
  listed++;
  const path = list[at].length && (!row.online || own) ? list[at] : null;
  const point = row.online && path && own && own !== "far" ? own : null;
  const ok =
    !row.stale &&
    row.placed === row.location &&
    sameList(row.path, path) &&
    (path === null) === (row.precision === "unplaced") &&
    row.rules === (row.online ? null : expected.rules) &&
    (!row.online ||
      (row.key === row.location &&
        row.lat === (point?.lat ?? null) &&
        row.lng === (point?.lng ?? null)));
  if (!ok) errors.push(`${row.id} (${row.location}): not placed as the backfill lists it`);
}

// The backfill once more: nothing changes.
if (backfill) {
  const snapshot = `
select pg_catalog.jsonb_build_object(
  'auditions', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(
       row(a.id, a.place_unit, a.place_path, a.locality_id, a.lieu_key, a.lat, a.lng,
         a.place_precision, a.place_candidates, a.placed_location, a.placed_rules, a.geo_release)::text,
       ',' order by a.id), '')) from public.auditions a),
  'units', (select pg_catalog.md5(coalesce(pg_catalog.string_agg(g::text, ',' order by g.id), ''))
              from public.geo_units g));`;
  const [before] = sql<object>(snapshot);
  console.log(`$ ${psql} < ${backfill}`);
  sql(readFileSync(backfill, "utf8"));
  const [again] = sql<object>(snapshot);
  if (JSON.stringify(before) !== JSON.stringify(again)) {
    errors.push(`${expected.migration} run again changed auditions or geo_units`);
  }
}

if (errors.length) {
  for (const e of errors.slice(0, 50)) console.error(`✗ ${e}`);
  if (errors.length > 50) console.error(`… and ${errors.length - 50} more`);
  process.exit(1);
}
console.log(
  `ok: ${r.total} seeded testimonies, every one derived by the migrations; ` +
    `${rows.length} seeded auditions, ` +
    (backfill
      ? `${listed} placed as ${expected.migration} lists them, the others stale; run again, it changed nothing`
      : "every one stale (no backfill listed yet)"),
);
