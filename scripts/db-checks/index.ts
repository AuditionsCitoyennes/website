// Database checks, run by CI on the stack built from the migrations and the
// seed ("Database from scratch"), and by hand on a local one:
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run db:check
//   PSQL="docker exec -i supabase_db_<project_id> psql -U postgres -d postgres" npm run db:check
//
//   npm run db:check -- grants parity      only some of them (grants, rpcs, parity, writes, places, paths, seed, backfill)
//   npm run db:check -- --allowlist        print allowlist.json as the database stands
//
// Local databases only (psql.ts). Every write happens in a rolled-back transaction.

import { checkBackfill } from "./backfill";
import { checkGrants, currentAllowlist } from "./grants";
import { checkParity } from "./parity";
import { checkPaths } from "./paths";
import { checkRpcs } from "./rpcs";
import { checkPartialPlaces, checkPlacementSupport, checkPlaceWrites } from "./places";
import { checkSeed } from "./seed";
import { checkWrites } from "./writes";

const CHECKS: Record<string, { title: string; run: () => string[] }> = {
  grants: { title: "Grant guard", run: checkGrants },
  rpcs: { title: "Read RPCs: the service role's alone, bounded", run: checkRpcs },
  parity: {
    title: "Derived columns match @ac/shared",
    run: () => {
      const { errors, checked } = checkParity();
      console.log(`  ${checked} rows compared (database and edge fixture)`);
      return errors;
    },
  },
  writes: { title: "Old-app-shaped writes keep the derived columns", run: checkWrites },
  places: {
    title: "Audition writes and online buckets leave the place columns right",
    run: () => [...checkPlaceWrites(), ...checkPartialPlaces(), ...checkPlacementSupport()],
  },
  paths: { title: "Place paths are their units' chains", run: checkPaths },
  seed: { title: "The fake seed is placed as its fixtures say", run: checkSeed },
  backfill: {
    title: "The reviewed backfill places the listed rows only, once",
    run: checkBackfill,
  },
};

function main(args: string[]): number {
  if (args.includes("--allowlist")) {
    process.stdout.write(JSON.stringify(currentAllowlist(), null, 2) + "\n");
    return 0;
  }
  const unknown = args.filter((a) => !(a in CHECKS));
  if (unknown.length) {
    console.error(
      `Unknown check(s): ${unknown.join(", ")} (known: ${Object.keys(CHECKS).join(", ")})`,
    );
    return 1;
  }
  let failed = 0;
  for (const name of args.length ? args : Object.keys(CHECKS)) {
    const { title, run } = CHECKS[name];
    console.log(`${title}…`);
    const errors = run();
    if (errors.length === 0) {
      console.log("  ok");
      continue;
    }
    failed++;
    for (const e of errors.slice(0, 50)) console.error(`  ✗ ${e}`);
    if (errors.length > 50) console.error(`  … and ${errors.length - 50} more`);
  }
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
