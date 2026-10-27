// npm run db:seed (and db:reset): writes supabase/seed.sql, the fake data of
// SEED_PROFILE (france, world or all) in SEED_SHAPE (places or legacy). See
// generate.ts.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROFILES, seedSql, SHAPES, type Profile, type Shape } from "./generate";

const profile = (process.env.SEED_PROFILE ?? "france") as Profile;
if (!PROFILES.includes(profile)) {
  console.error(`SEED_PROFILE must be france, world or all (got "${profile}")`);
  process.exit(1);
}
const shape = (process.env.SEED_SHAPE ?? "places") as Shape;
if (!SHAPES.includes(shape)) {
  console.error(`SEED_SHAPE must be places or legacy (got "${shape}")`);
  process.exit(1);
}
try {
  const { sql, summary } = seedSql(profile, shape);
  writeFileSync(fileURLToPath(new URL("../../supabase/seed.sql", import.meta.url)), sql);
  console.log(summary);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
