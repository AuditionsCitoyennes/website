// The reviewed backfill of production's places (design B4, B7 step 8): its
// SQL places the listed rows exactly as listed, online rows at their own
// point under their own label, leaves a row changed since the review stale and
// a row already placed as it is (offline or online), and a second run changes
// nothing; its NOTICEs count what each run placed and left as the table does —
// each fixture test run in a transaction rolled back.
//
// - The generator's SQL, rendered from a fixed sample (Lyon, a keyword-rule
//   collapse, a generic text, same-named communes, a town hall, one geo.api
//   does not know): the shape of
//   any backfill, on the real schema, before a production list exists.
// - The committed backfill, when supabase/tests/backfill_places_fr.expected.json
//   names one: its own fixture test (supabase/tests/backfill_places_fr.sql),
//   generated with it.
//
// BACKFILL_ROOT=<dir> reads the expected list, the test and the migration
// under <dir> instead of the repository (a generator's dry run).

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_FILE,
  inlineIncludes,
  migrationSql,
  noticeErrors,
  testSql,
  type Backfill,
  type ExpectedList,
} from "../place-backfill/sql";
import { runSqlLogged } from "./psql";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const LYON = ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69123"];
const unit = (
  id: string,
  parent: string | null,
  level: string,
  name: string,
  code: string | null,
) => ({
  id,
  parent_id: parent,
  level,
  country: "FR",
  name,
  code,
  lat: null,
  lng: null,
  source: "insee",
  geo_release: "geoapi-2026",
});
const place = (path: string[], lat: number, lng: number, precision: string) => ({
  unit: path[path.length - 1],
  path,
  locality: path.find((id) => id.startsWith("fr:com:")) ?? null,
  lat,
  lng,
  precision,
  candidates: null,
  release: "geoapi-2026",
});
const NOWHERE = {
  unit: null,
  path: null,
  locality: null,
  lat: null,
  lng: null,
  precision: "unplaced",
  release: null,
};

/** A backfill as the generator writes one; its lieux sound like the seed's, on purpose. */
export const SAMPLE: Backfill = {
  version: "20261026200000",
  generated: "2026-10-26T20:00:00Z",
  source: "db-check sample",
  rules: "0123abcd",
  units: [
    unit("FR", null, "country", "France", null),
    unit("fr:reg:84", "FR", "region", "Auvergne-Rhône-Alpes", "84"),
    unit("fr:dep:69", "fr:reg:84", "county", "Rhône", "69"),
    unit("fr:com:69123", "fr:dep:69", "locality", "Lyon", "69123"),
    unit("fr:com:69266", "fr:dep:69", "locality", "Villeurbanne", "69266"),
    unit("fr:com:69382", "fr:com:69123", "locality", "Lyon 2e", "69382"),
    unit("fr:com:69383", "fr:com:69123", "locality", "Lyon 3e", "69383"),
  ],
  values: [
    {
      online: false,
      location: "Place Bellecour, Lyon",
      citycode: null,
      key: "Place Bellecour, Lyon",
      ...place([...LYON, "fr:com:69382"], 45.7578, 4.832, "address"),
    },
    {
      online: false,
      location: "Gare Part-Dieu, Lyon",
      citycode: null,
      key: "Part-Dieu, Lyon",
      ...place([...LYON, "fr:com:69383"], 45.7606, 4.859, "address"),
    },
    {
      online: false,
      location: "part-dieu",
      citycode: null,
      key: "Part-Dieu, Lyon",
      ...place([...LYON, "fr:com:69383"], 45.7606, 4.859, "address"),
    },
    {
      online: false,
      location: "France",
      citycode: null,
      key: "France",
      candidates: null,
      ...NOWHERE,
    },
    {
      online: false,
      location: "Saint-Denis",
      citycode: null,
      key: "Saint-Denis",
      ...NOWHERE,
      candidates: [
        { name: "Saint-Denis", departementCode: "974", citycode: "97411", lat: -20.88, lng: 55.45 },
        { name: "Saint-Denis", departementCode: "93", citycode: "93066", lat: 48.93, lng: 2.35 },
      ],
    },
    {
      online: true,
      location: "Mairie de Villeurbanne",
      citycode: "69266",
      key: null,
      ...place(["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"], 45.7667, 4.8799, "address"),
      lat: null,
      lng: null,
    },
    {
      online: true,
      location: "Mairie inconnue",
      citycode: "00000",
      key: null,
      ...NOWHERE,
      candidates: null,
    },
  ],
};

/** An expected list (a missing or malformed one is an error: CI reads the committed one). */
function readExpectedAt(file: string): ExpectedList {
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing. It is committed with the repository (supabase/tests): link or copy ` +
        "supabase/tests beside the migrations, or set BACKFILL_ROOT to a generator's output.",
    );
  }
  const list = JSON.parse(readFileSync(file, "utf8")) as ExpectedList;
  const shape =
    typeof list.offline === "object" &&
    typeof list.online === "object" &&
    (list.migration === null) === (list.test === null) &&
    (list.migration === null || /^\d{14}_backfill_places_fr\.sql$/.test(list.migration));
  if (!shape) throw new Error(`${file}: not an expected list as scripts/place-backfill writes one`);
  return list;
}

/** The expected list under `root` (BACKFILL_ROOT, else the repository). */
export function readExpected(root = process.env.BACKFILL_ROOT ?? REPO): ExpectedList {
  return readExpectedAt(resolve(root, "supabase/tests", EXPECTED_FILE));
}

/**
 * The expected list that goes with these migrations: BACKFILL_ROOT's when set;
 * else the one beside the migrations actually there (supabase/tests next to
 * the directory a symlinked migrations/ resolves to); else the repository's.
 * Throws when the migrations hold another backfill than the one it names.
 */
export function expectedFor(migrations: string): { file: string; list: ExpectedList } {
  const beside = resolve(realpathSync(migrations), "../tests", EXPECTED_FILE);
  const file = process.env.BACKFILL_ROOT
    ? resolve(process.env.BACKFILL_ROOT, "supabase/tests", EXPECTED_FILE)
    : existsSync(beside)
      ? beside
      : resolve(REPO, "supabase/tests", EXPECTED_FILE);
  const list = readExpectedAt(file);
  const held = readdirSync(migrations).filter((f) => f.endsWith("_backfill_places_fr.sql"));
  if (held.join() !== (list.migration ?? "")) {
    throw new Error(
      `${migrations} holds ${held.join(", ") || "no backfill"}, but ${file} names ` +
        `${list.migration ?? "none"}: the migrations and the expected list go together.`,
    );
  }
  return { file, list };
}

/** A psql script with its \ir lines read from disk, relative to `file`. */
function withIncludes(file: string): string {
  return inlineIncludes(readFileSync(file, "utf8"), (path) =>
    readFileSync(resolve(dirname(file), path), "utf8"),
  );
}

/** A fixture test: its checks pass, and the NOTICEs of its two runs say what the table says. */
function attempt(what: string, sql: string, errors: string[]): void {
  let out: { stdout: string; stderr: string };
  try {
    out = runSqlLogged(sql);
  } catch (e) {
    // psql prints the migration's notices first: the error is what matters.
    const lines = (e as Error).message.split("\n");
    const shown = lines.filter((l) => /ERROR|DETAIL|CONTEXT/.test(l));
    errors.push(`${what}: ${(shown.length ? shown : lines).slice(0, 4).join(" / ")}`);
    return;
  }
  for (const e of noticeErrors(out.stdout, out.stderr)) errors.push(`${what}: ${e}`);
}

export function checkBackfill(): string[] {
  const errors: string[] = [];
  const sample = inlineIncludes(testSql(SAMPLE, "sample"), () =>
    migrationSql(SAMPLE, "docs/backfill-places-sample.md"),
  );
  attempt("the generator's SQL (sample)", sample, errors);

  const root = process.env.BACKFILL_ROOT ?? REPO;
  const list = readExpected(root);
  if (list.migration === null) {
    console.log("  no backfill listed yet: the sample only");
    return errors;
  }
  const test = join(root, "supabase/tests", list.test!);
  const migration = join(root, "supabase/migrations", list.migration);
  for (const file of [test, migration]) {
    if (!existsSync(file)) errors.push(`${file}: listed by ${EXPECTED_FILE}, missing`);
  }
  if (errors.length) return errors;
  attempt(`${list.migration} (its fixture test)`, withIncludes(test), errors);
  console.log(
    `  ${list.migration}: ${Object.keys(list.offline).length} spellings, ` +
      `${Object.keys(list.online).length} town halls`,
  );
  return errors;
}
