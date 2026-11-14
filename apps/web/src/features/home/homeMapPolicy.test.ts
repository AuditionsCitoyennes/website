// The home card's policies (homeMapPolicy.ts), run with `node --import tsx
// --test` (root "test:scripts"): « auto » is today's "proche" on a full
// device and the still picture on a weak one or without WebGL 2, the other
// policies are kept as chosen, the probe is asked for only when it can change
// the answer, and the switch is read back like the others.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { localStorage?: unknown };
const policy = await import("./homeMapPolicy");
const { HOME_MAP_POLICIES, needsProbe, resolveHomeMap, storedHomeMap } = policy;

const TIERS = ["full", "light", "minimal"] as const;

test("« auto »: proche on a full device, the still picture on a weak one or without WebGL 2", () => {
  assert.deepEqual(
    TIERS.map((t) => resolveHomeMap("auto", t)),
    ["proche", "statique", "statique"],
  );
  assert.equal(resolveHomeMap("auto", "full", true), "proche");
  assert.equal(resolveHomeMap("auto", "full", false), "statique");
});

test("a chosen policy is kept on every device", () => {
  for (const p of HOME_MAP_POLICIES.filter((p) => p !== "auto"))
    for (const t of TIERS)
      for (const w of [true, false, undefined])
        assert.equal(resolveHomeMap(p, t, w), p, `${p}/${t}/${w}`);
});

test("the probe is asked for under « auto » on a device the hints call full, only", () => {
  assert.equal(needsProbe("auto", "full"), true);
  assert.equal(needsProbe("auto", "light"), false);
  assert.equal(needsProbe("proche", "full"), false);
  assert.equal(needsProbe("statique", "full"), false);
});

test("the default is « auto »; the stored policy is read back, garbage and blocked storage as it", () => {
  assert.equal(policy.DEFAULT_HOME_MAP, "auto");
  assert.deepEqual([...HOME_MAP_POLICIES], ["auto", "proche", "tot", "contact", "statique"]);
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null };
  assert.equal(storedHomeMap(), "auto");
  kept.set("ac:home-map", "statique");
  assert.equal(storedHomeMap(), "statique");
  kept.set("ac:home-map", "proche");
  assert.equal(storedHomeMap(), "proche");
  kept.set("ac:home-map", "nonsense");
  assert.equal(storedHomeMap(), "auto");
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(storedHomeMap(), "auto");
  delete g.localStorage;
});
