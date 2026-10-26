// Migrations on top of seeded data. CI builds its database by applying every
// migration to an empty one and only then loading the seed, so a migration
// that rewrites existing rows never meets any there. This rebuilds the local
// database as it stood before map phase 1, loads the seed into it with psql,
// then applies the newer migrations over the rows, as staging and production
// will see them, and checks the result.
//
//   npm run db:check:seeded -- --yes                    the stack of ./supabase
//   npm run db:check:seeded -- --yes --workdir <dir>    another stack (its own seed.sql)
//
// It wipes that database: --yes is required. PSQL or DATABASE_URL as for
// db:check. Supabase CLI 2.75: `db reset --version <v> --no-seed`, then
// `migration up`; both act on the local stack only (--local is their default).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sqlJson } from "./psql";

/** The last migration before phase 1: the shape the seed was written for. */
const BEFORE_PHASE_1 = "20261024234316";

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!process.argv.includes("--yes")) {
  console.error("This resets the local database: run it again with --yes.");
  process.exit(1);
}
const workdir = option("--workdir");
const from = option("--from") ?? BEFORE_PHASE_1;
const seed = resolve(option("--seed") ?? `${workdir ?? "."}/supabase/seed.sql`);
const where = workdir ? ["--workdir", workdir] : [];

function supabase(...args: string[]) {
  console.log(`$ supabase ${[...args, ...where].join(" ")}`);
  const r = spawnSync("supabase", [...args, ...where], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function sql<T>(script: string): T[] {
  try {
    return sqlJson<T>(script);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

sql("select 1;"); // refuses a hosted database before anything is reset
supabase("db", "reset", "--version", from, "--no-seed");
console.log(`$ psql < ${seed}`);
sql(readFileSync(seed, "utf8"));
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
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(`ok: ${r.total} seeded testimonies, every one derived by the migrations`);
