// Generates the reviewed backfill of a database's places (map phase 1, design
// §B4): reads its auditions with the publishable key, places them with the
// API's own code, text only, and writes
//
//   supabase/migrations/<version>_backfill_places_fr.sql  the migration
//   supabase/tests/backfill_places_fr.sql                  its fixture test
//   supabase/tests/backfill_places_fr.expected.json        what it places (database checks)
//   docs/backfill-places-<date>.md                         the review table
//
//   PLACE_BACKFILL_URL=https://<ref>.supabase.co PLACE_BACKFILL_KEY=sb_publishable_… \
//     npm run place-backfill -- --out <dir>
//
// README.md here: options, and the run against production (dry run, review,
// commit, push). It reads nothing from any .env, and refuses a secret or
// service-role key. The geocoder and the commune API are asked one request
// at a time; one that keeps not answering stops the run before anything is
// written.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPoint, loadContours, type ContourCheck, type Contours } from "./etalab";
import { backfillOf, buildPlan, type Plan } from "./plan";
import { reviewMarkdown } from "./review";
import { countOrphanTestimonies, readAuditions, refuseKey } from "./source";
import {
  expectedList,
  EXPECTED_FILE,
  MIGRATION_NAME,
  migrationFileOf,
  migrationSql,
  TEST_FILE,
  testSql,
} from "./sql";
import { DEFAULT_BAN, installGentleFetch, upstreamDeps, upstreamHosts } from "./upstream";

const HELP = `Usage: PLACE_BACKFILL_URL=<url> PLACE_BACKFILL_KEY=<publishable key> \\
  npm run place-backfill -- --out <dir> [options]

  --out <dir>          where the four files go, in the repository's layout
                       (the repository's root, or a scratch directory: a dry run)
  --migration <file>   the migration's path instead (also --test, --expected, --review)
  --version <v>        the migration's version, YYYYMMDDHHMMSS (default: now, UTC)
  --ban <url>          the BAN to ask (default ${DEFAULT_BAN})
  --etalab <dir>       the Etalab contours for the cross-check
                       (default ~/.cache/ac-map-data/raw; skipped when missing)
  --http-cache <file>  keep the geocoder's and the commune API's answers there`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.\n\n${HELP}`);
  return value;
}

const KNOWN = [
  "--out",
  "--migration",
  "--test",
  "--expected",
  "--review",
  "--version",
  "--ban",
  "--etalab",
  "--http-cache",
];

/** The last migration version in a directory ("" when none). */
function lastVersion(dir: string): string {
  if (!existsSync(dir)) return "";
  return (
    readdirSync(dir)
      .map((f) => /^(\d{14})_.*\.sql$/.exec(f)?.[1] ?? "")
      .sort()
      .at(-1) ?? ""
  );
}

/** Each placed lieu's point against its unit's Etalab polygon, by index in the plan. */
function contourChecks(plan: Plan, contours: Contours): Map<number, ContourCheck> {
  const checks = new Map<number, ContourCheck>();
  plan.lieux.forEach((l, i) => {
    const c = l.placement.columns;
    if (c.place_unit && c.lat !== null && c.lng !== null) {
      checks.set(i, checkPoint(contours, c.place_unit, [c.lat, c.lng]));
    }
  });
  return checks;
}

/** Now, UTC, as YYYYMMDDHHMMSS. */
const nowVersion = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    return;
  }
  const unknown = args.filter((a) => a.startsWith("--") && !KNOWN.includes(a));
  if (unknown.length) fail(`Unknown option(s): ${unknown.join(", ")}\n\n${HELP}`);

  const url = process.env.PLACE_BACKFILL_URL?.replace(/\/+$/, "");
  const key = process.env.PLACE_BACKFILL_KEY;
  if (!url || !key) {
    fail(
      "Set PLACE_BACKFILL_URL (the project's URL) and PLACE_BACKFILL_KEY (its publishable key) " +
        "in the environment: nothing is read from any .env.",
    );
  }
  const refused = refuseKey(key);
  if (refused) {
    fail(
      `PLACE_BACKFILL_KEY is ${refused}: the backfill reads what the public may read, with the ` +
        "project's publishable (or legacy anon) key, and needs nothing more.",
    );
  }
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    fail(`PLACE_BACKFILL_URL is not a URL: ${url}`);
  }

  const generated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const date = generated.slice(0, 10);
  const version = option("--version") ?? nowVersion();
  if (!/^\d{14}$/.test(version)) fail(`--version ${version}: YYYYMMDDHHMMSS`);
  const out = option("--out");
  const path = (flag: string, layout: string) => {
    const given = option(flag);
    if (given) return resolve(given);
    if (out) return resolve(out, layout);
    fail(`Give --out <dir>, or ${flag} <file>.\n\n${HELP}`);
  };
  const files = {
    migration: path("--migration", `supabase/migrations/${migrationFileOf(version)}`),
    test: path("--test", `supabase/tests/${TEST_FILE}`),
    expected: path("--expected", `supabase/tests/${EXPECTED_FILE}`),
    review: path("--review", `docs/backfill-places-${date}.md`),
  };
  // After every migration there is, the repository's and the output's.
  const repoMigrations = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
  const after = [lastVersion(repoMigrations), lastVersion(dirname(files.migration))].sort().at(-1)!;
  if (version <= after) fail(`--version ${version} must come after the last migration, ${after}.`);
  const other = existsSync(dirname(files.migration))
    ? readdirSync(dirname(files.migration)).filter(
        (f) => f.endsWith(`_${MIGRATION_NAME}.sql`) && f !== basename(files.migration),
      )
    : [];
  if (other.length) {
    fail(
      `${dirname(files.migration)} already holds ${other.join(", ")}: a second backfill would ` +
        "run after it. Remove it (or write this one elsewhere) first.",
    );
  }
  const ban = (option("--ban") ?? DEFAULT_BAN).replace(/\/+$/, "");
  const etalabDir = option("--etalab") ?? join(homedir(), ".cache/ac-map-data/raw");

  const target = { url, key };
  console.error(`Reading ${host}'s auditions with the publishable key…`);
  const rows = await readAuditions(target);
  const orphans = await countOrphanTestimonies(target);
  console.error(`  ${rows.length} auditions; placing their lieux (${ban}, geo.api.gouv.fr)…`);

  const restore = installGentleFetch(upstreamHosts(ban), option("--http-cache"));
  let plan;
  try {
    plan = await buildPlan(rows, upstreamDeps(ban), { log: (line) => console.error(line) });
  } finally {
    restore();
  }

  const contours = loadContours(etalabDir);
  const checks = contours
    ? contourChecks(plan, contours)
    : `${etalabDir} has no etalab-communes-50m.geojson (scripts/map-data builds it)`;

  const backfill = backfillOf(plan, { version, generated, source: host });
  const migrationPath = `supabase/migrations/${basename(files.migration)}`;
  const reviewPath = `docs/${basename(files.review)}`;
  const migration = migrationSql(backfill, reviewPath);
  const test = testSql(backfill, relative(dirname(files.test), files.migration));
  const expected = expectedList(backfill);
  expected.migration = basename(files.migration);
  expected.test = basename(files.test);
  const review = reviewMarkdown({
    plan,
    backfill,
    migrationPath,
    reviewPath,
    ban,
    rows: rows.length,
    nullCreatedAt: rows.filter((r) => r.created_at === null).length,
    nullStatus: rows.filter((r) => r.status === null).length,
    published: rows.filter((r) => r.status === "published").length,
    drafts: rows.filter((r) => r.status === "draft").length,
    orphans,
    contours: checks,
  });

  const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    const shown = relative(process.cwd(), file);
    console.error(`  wrote ${shown.startsWith("..") ? file : shown}`);
  };
  console.error("Done:");
  write(files.migration, migration);
  write(files.test, test);
  write(files.expected, JSON.stringify(expected, null, 2) + "\n");
  write(files.review, review);
  const placed = plan.lieux.filter((l) => l.placement.columns.place_path).length;
  console.error(
    `${plan.lieux.length} lieux (${placed} on the map), ${backfill.values.length} values, ` +
      `${plan.units.length} units. Read the review table before anything else.`,
  );
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
