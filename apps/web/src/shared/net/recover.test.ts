// The recovery after a network failure (recoverSwitch.ts, reconnect.ts), run
// with `node --import tsx --test` (root "test:scripts"): the waits between
// attempts, the switch read only with the testing tools (garbage and blocked
// storage read as the default), and the moments the network may be back.

import assert from "node:assert/strict";
import { test } from "node:test";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const sw = await import("./recoverSwitch");
const { browserOffline, onReconnect } = await import("./reconnect");

test("the waits: 2, 5, 10, 20 then 30 s, nothing past them", () => {
  assert.deepEqual(sw.RECOVER_DELAYS_MS, [2000, 5000, 10_000, 20_000, 30_000]);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((n) => sw.recoverDelay(n)),
    [2000, 5000, 10_000, 20_000, 30_000],
  );
  assert.equal(sw.recoverDelay(5), null);
  assert.equal(sw.recoverDelay(-1), null);
});

test("the default is « auto », and a build without the testing tools reads no storage", () => {
  assert.equal(sw.DEFAULT_RECOVER, "auto");
  assert.deepEqual(sw.RECOVERS, ["auto", "ancien"]);
  assert.equal(sw.recover, "auto");
});

test("the stored mode is read back, garbage and blocked storage as the default", () => {
  const kept = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => kept.get(k) ?? null };
  assert.equal(sw.storedRecover(), "auto");
  kept.set("ac:recover", "ancien");
  assert.equal(sw.storedRecover(), "ancien");
  kept.set("ac:recover", "nope");
  assert.equal(sw.storedRecover(), "auto");
  g.localStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(sw.storedRecover(), "auto");
  delete g.localStorage;
});

test("onReconnect: the browser online, the page shown again; not hidden; unsubscribed", () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let n = 0;
  const off = onReconnect(() => n++, { win, doc });
  win.dispatchEvent(new Event("online"));
  assert.equal(n, 1);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(n, 1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(n, 2);
  win.dispatchEvent(new Event("offline"));
  assert.equal(n, 2);
  off();
  win.dispatchEvent(new Event("online"));
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(n, 2);
});

test("browserOffline only when the browser says so", () => {
  assert.equal(browserOffline({ onLine: false }), true);
  assert.equal(browserOffline({ onLine: true }), false);
  assert.equal(browserOffline({}), false);
});
