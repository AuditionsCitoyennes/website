// Migrations on top of seeded data. CI builds its database by applying every
// migration to an empty one and only then loading the seed, so a migration
// that rewrites existing rows never meets any there. This rebuilds a local
// database as it stood before map phase 1, loads the seed into it with psql,
// in the shape of its rows then (SEED_SHAPE=legacy: no place column, no
// geo_units; profile SEED_PROFILE, all by default), then applies the newer
// migrations over the rows, as staging and production will see them, and
// checks the result.
//
//   npm run db:check:seeded -- --yes --workdir <dir>   (<dir>/supabase/config.toml)
//   … --seed <file>                                    another seed of that shape
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

const [r] = sql<{ total: number; underived: number; auditions: number; placed: number }>(`
select pg_catalog.jsonb_build_object(
  'total', count(*),
  'underived', count(*) filter (where derive_version is distinct from 1),
  'auditions', (select count(*) from public.auditions),
  'placed', (select count(*) from public.auditions
              where not place_stale or placed_location is not null or place_path is not null))
  from public.testimonies;`);
const errors: string[] = [];
if (r.total === 0) errors.push("the seed left no testimony");
if (r.underived > 0)
  errors.push(`${r.underived} of ${r.total} testimonies lack derive_version = 1`);
// Rows written before the place columns are never placed: stale, for the
// API to place. (The reviewed backfill, design B4, will place the rows it lists.)
if (r.auditions === 0) errors.push("the seed left no audition");
if (r.placed > 0) {
  errors.push(`${r.placed} of ${r.auditions} seeded auditions came out placed or not stale`);
}
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(
  `ok: ${r.total} seeded testimonies, every one derived by the migrations; ` +
    `${r.auditions} seeded auditions, every one stale`,
);
