import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeEnv } from "../../testing/fakes";

// Production's map reads the stored places alone (map phase 1, PR L): an API
// booted there without the placement job says so as a warning — the old
// app's writes and a LOCATION_RULES change would never reach the map.

const cacheDir = await mkdtemp(join(tmpdir(), "ac-job-off-production-"));
fakeEnv(cacheDir, { APP_ENV: "production", MAP_SOURCE: "db" });
after(() => rm(cacheDir, { recursive: true, force: true }));

test("production without PLACEMENT_JOB: the job stays off, with a warning", async () => {
  const infos: string[] = [];
  const warnings: string[] = [];
  const { startPlacementJob } = await import("./placementJob");
  startPlacementJob({
    info: (_obj, msg) => infos.push(msg),
    warn: (_obj, msg) => warnings.push(msg),
    error: () => {},
  });
  assert.deepEqual(infos, []);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^placement job off: PLACEMENT_JOB is not true: the map shows neither the old app's writes nor a LOCATION_RULES change/,
  );
});
