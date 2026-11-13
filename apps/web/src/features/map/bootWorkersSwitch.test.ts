// The workers' start switch (bootWorkersSwitch.ts): where each mode starts the
// relief and mesh workers, and the kept mode read back from storage (a garbage
// value, an empty or blocked storage give the default). Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue component,
// no DOM.

import assert from "node:assert/strict";
import { test } from "node:test";

(globalThis as unknown as { __TEST_TOOLS__: boolean }).__TEST_TOOLS__ = false;
const { BOOT_WORKERS, DEFAULT_BOOT_WORKERS, bootWorkers, storedBootWorkers, workersStartAt } =
  await import("./bootWorkersSwitch");

/** A localStorage stand-in for one test, removed after it. */
function withStorage(storage: unknown, run: () => void) {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.prototype.hasOwnProperty.call(g, "localStorage");
  const before = g.localStorage;
  Object.defineProperty(g, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    if (had) Object.defineProperty(g, "localStorage", { value: before, configurable: true });
    else delete g.localStorage;
  }
}
const kept = (value: string | null) => ({
  getItem: (k: string) => (k === "ac:boot-workers" ? value : null),
});

test("the default starts early, and a build without the testing tools uses it", () => {
  assert.equal(DEFAULT_BOOT_WORKERS, "early");
  assert.deepEqual([...BOOT_WORKERS], ["early", "load"]);
  assert.equal(bootWorkers, DEFAULT_BOOT_WORKERS);
});

test("« early » starts the workers with the map object, « load » in its load handler", () => {
  assert.equal(workersStartAt("early"), "mount");
  assert.equal(workersStartAt("load"), "load");
});

test("the kept mode is read back; anything else gives the default", () => {
  withStorage(kept("load"), () => assert.equal(storedBootWorkers(), "load"));
  withStorage(kept("early"), () => assert.equal(storedBootWorkers(), "early"));
  withStorage(kept(null), () => assert.equal(storedBootWorkers(), "early"));
  withStorage(kept("tot"), () => assert.equal(storedBootWorkers(), "early"));
  withStorage(
    {
      getItem() {
        throw new Error("blocked");
      },
    },
    () => assert.equal(storedBootWorkers(), "early"),
  );
});
