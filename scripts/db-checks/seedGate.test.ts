import assert from "node:assert/strict";
import { test } from "node:test";
import { RULES_HASH } from "../seed/fixtures/fr";
import { seedSql } from "../seed/generate";
import { seedGate } from "./seedGate";

const now = { fingerprint: "f00d", rules: "1ccc94a6" };

test("a database as the seed left it, under the same rules, is compared", () => {
  for (const ci of [false, true]) {
    assert.deepEqual(seedGate({ places: "f00d", rules: "1ccc94a6" }, now, ci), { compare: true });
  }
});

test("a database written since the seed was loaded is skipped locally, refused in CI", () => {
  const local = seedGate({ places: "beef", rules: "1ccc94a6" }, now, false);
  assert.ok(!local.compare);
  assert.equal(local.error, null);
  assert.match(local.note, /changed since the seed was loaded/);
  const ci = seedGate({ places: "beef", rules: "1ccc94a6" }, now, true);
  assert.ok(!ci.compare);
  assert.match(ci.error ?? "", /fingerprint differs/);
});

// A LOCATION_RULES change that moves no seed lieu leaves the fixtures as they
// are, and a database seeded before it untouched (same fingerprint): its rows
// stand under the old hash, which the check must not take for an error.
test("a database seeded before a LOCATION_RULES change is skipped locally, refused in CI", () => {
  const local = seedGate({ places: "f00d", rules: "6c6fb15e" }, now, false);
  assert.ok(!local.compare);
  assert.equal(local.error, null);
  assert.match(local.note, /seeded under LOCATION_RULES 6c6fb15e, 1ccc94a6 now/);
  assert.match(local.note, /npm run db:reset/);
  const ci = seedGate({ places: "f00d", rules: "6c6fb15e" }, now, true);
  assert.ok(!ci.compare);
  assert.match(
    ci.error ?? "",
    /loaded under LOCATION_RULES 6c6fb15e, the check runs under 1ccc94a6/,
  );
});

test("a seed that recorded no rules (an older one) is skipped locally, refused in CI", () => {
  const local = seedGate({ places: "f00d" }, now, false);
  assert.ok(!local.compare);
  assert.equal(local.error, null);
  assert.match(local.note, /LOCATION_RULES not recorded/);
  const ci = seedGate({ places: "f00d" }, now, true);
  assert.ok(!ci.compare);
  assert.match(ci.error ?? "", /LOCATION_RULES not recorded/);
});

test("the seed records the LOCATION_RULES its rows are stamped with", () => {
  const { sql } = seedSql("france", "places");
  const at = sql.lastIndexOf("values ('fake_seed_loaded'");
  assert.ok(at > 0, "the seed leaves its marker");
  assert.ok(sql.slice(at).includes(`'rules', '${RULES_HASH}'`), "the marker names the rules hash");
  // The rows the seed placed are stamped with that same hash.
  assert.ok(sql.slice(0, at).includes(`'${RULES_HASH}'`));
  // The legacy shape has no place columns, so nothing to record.
  assert.ok(!seedSql("france", "legacy").sql.includes("'rules'"));
});
