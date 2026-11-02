// The outline loader (outlineLoader.ts) against a scripted host and a fake
// clock: one request per URL, declared files only, one write per batch, the
// failure classes and the session fallback, the timeout, the give-up timer,
// the prefetch. Run with `node --import tsx --test` (root "test:scripts").
// Pure: no Vue, no DOM, no alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { OutlineLoader, type OutlineLoaderOptions, type OutlineResponse } from "./outlineLoader";
import {
  OutlineStore,
  type FileEntryV1,
  type FileSelfV1,
  type OutlineFileV1,
  type OutlineKind,
  type RootRowV1,
  type RootV1,
} from "./outlines";

const BUILD = "o20261101-1";
const BASE = "http://h.test/";
const url = (path: string) => `${BASE}outlines/${BUILD}/${path}.json`;

const unit = (id: string): FileSelfV1 => ({
  id,
  bbox: [0, 0, 1, 1],
  center: [0, 0],
  n: 5,
  g: { type: "Polygon", coordinates: [] },
});
const file = (kind: OutlineKind, id: string, tier = "e50", units: FileEntryV1[] = []) =>
  ({ v: 1, build: BUILD, kind, id, tier, tolM: 0, self: unit(id), units }) as OutlineFileV1;
const entry = (id: string, level: FileEntryV1["level"], k: 0 | 1 = 1): FileEntryV1 => ({
  ...unit(id),
  name: id,
  level,
  k,
  u: 0,
});
const row = (id: string, parent: string | null, over: Partial<RootRowV1> = {}): RootRowV1 => ({
  id,
  parent,
  level: "dep",
  name: id,
  bbox: [0, 0, 1, 1],
  center: [0, 0],
  st: "e50",
  k: 1,
  u: 1,
  g: 0,
  ...over,
});
const DEPS = ["fr:dep:01", "fr:dep:03", "fr:dep:07", "fr:dep:15", "fr:dep:69"];
const ROOT: RootV1 = {
  v: 1,
  build: BUILD,
  tiers: { e50: { tolM: 0, source: "etalab-50m" } },
  units: [
    row("FR", null, { level: "country", st: "fr1000", u: 0 }),
    row("fr:reg:84", "FR", { level: "region" }),
    ...DEPS.map((d) => row(d, "fr:reg:84")),
    ...["ES", "IT", "DE"].map((c) => row(c, null, { level: "country", st: "c100", k: 0, g: 1 })),
  ],
};
const BUNDLES: Record<string, OutlineFileV1> = {
  root: ROOT as unknown as OutlineFileV1,
  "k/FR": file("k", "FR", "fr1000", [entry("fr:reg:84", "region")]),
  "k/fr_reg_84": file(
    "k",
    "fr:reg:84",
    "e50",
    DEPS.map((d) => entry(d, "dep")),
  ),
  "k/fr_dep_69": file("k", "fr:dep:69", "e50", [entry("fr:com:69001", "city", 0)]),
};

type Reply = number | "html" | "hang" | "late" | "reject" | "json" | { body: unknown };

/** A scripted host (each URL's replies in turn, the last one repeats) and a fake clock. */
function setup(script: Record<string, Reply[]> = {}, more: Partial<OutlineLoaderOptions> = {}) {
  const requests: { url: string; cache?: string; signal: AbortSignal }[] = [];
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const armed: number[] = [];
  let now = 0;
  let next = 0;
  const writes: number[] = [];
  const modes: unknown[][] = [];
  const spans: Record<string, unknown>[] = [];
  let sets = 0;
  const fetchFn = async (u: string, init: { signal: AbortSignal; cache?: "reload" }) => {
    requests.push({ url: u, cache: init.cache, signal: init.signal });
    const path = u.slice(`${BASE}outlines/${BUILD}/`.length, -".json".length);
    const list = script[path] ?? ["json"];
    let r = list[Math.min(requests.filter((q) => q.url === u).length, list.length) - 1];
    // "late": the answer comes 10 ms later on the fake clock.
    if (r === "late")
      await new Promise<void>((done) => timers.set(++next, { at: now + 10, fn: done, ms: 10 }));
    if (r === "json" || r === "late")
      r = {
        body: BUNDLES[path] ?? file(path[0] as OutlineKind, path.slice(2).replaceAll("_", ":")),
      };
    if (r === "reject") throw new TypeError("fetch failed");
    if (r === "hang")
      return new Promise<OutlineResponse>((_, fail) =>
        init.signal.addEventListener("abort", () => fail(new DOMException("aborted"))),
      );
    const ok = typeof r !== "number";
    const text = typeof r === "object" ? JSON.stringify(r.body) : "<!doctype html>";
    const type = typeof r === "object" ? "application/json" : "text/html";
    return {
      ok,
      status: typeof r === "number" ? r : 200,
      headers: { get: () => type },
      text: () => Promise.resolve(text),
    };
  };
  const store = new OutlineStore();
  const loader = new OutlineLoader({
    store,
    fetchFn,
    base: BASE,
    build: BUILD,
    wrap: (o) => o,
    setTimer: (fn, ms) => {
      timers.set(++next, { at: now + ms, fn, ms });
      armed.push(ms);
      return next;
    },
    clearTimer: (id) => void timers.delete(id as number),
    onWrite: (v) => void writes.push(v),
    onSets: () => void sets++,
    onMode: (...a) => void modes.push(a),
    span: (name, detail) => {
      const s = { name, ...detail };
      spans.push(s);
      return (more) => void Object.assign(s, more);
    },
    ...more,
  });
  const flush = () => new Promise((done) => setImmediate(done));
  /** Moves the clock, firing the timers due on the way. */
  const tick = async (ms: number) => {
    const end = now + ms;
    await flush();
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = end;
  };
  const boot = async () => {
    const r = loader.ensureRoot();
    await tick(0);
    assert.equal(await r, "loaded");
    requests.length = 0;
    writes.length = 0;
    spans.length = 0;
  };
  /** The `outline.decode` spans of the writes. */
  const written = () => spans.filter((s) => s.name === "outline.decode" && s.phase === "write");
  return { loader, store, requests, writes, modes, armed, tick, boot, written, sets: () => sets };
}

test("(1) two concurrent ensureBundle of one unit: one request, one write", async () => {
  const t = setup();
  await t.boot();
  assert.deepEqual(t.modes, [["fichiers", "ok", undefined]]);
  const both = Promise.all([
    t.loader.ensureBundle("fr:dep:69"),
    t.loader.ensureBundle("fr:dep:69"),
  ]);
  await t.tick(0);
  assert.deepEqual(await both, ["loaded", "loaded"]);
  assert.deepEqual(
    t.requests.map((r) => r.url),
    [url("k/fr_dep_69")],
  );
  assert.equal(t.writes.length, 1);
  assert.deepEqual(
    t.written().map((s) => s.key),
    ["k/fr_dep_69"],
  );
});

test("(2) undeclared files are never requested", async () => {
  const t = setup();
  await t.boot();
  await t.loader.ensureBundle("fr:dep:69");
  t.requests.length = 0;
  assert.equal(t.store.rowOf("fr:com:69001")?.k, 0);
  assert.equal(await t.loader.ensureBundle("fr:com:69001"), "absent");
  assert.equal(await t.loader.ensureSelf("fr:com:99999"), "absent");
  assert.equal(await t.loader.ensureBundle("fr:com:99999"), "absent");
  assert.deepEqual(await t.loader.ensureGlobe(["fr:dep:69", "XX"]), ["absent", "absent"]);
  assert.equal(t.requests.length, 0);
});

test("(3) a département whose entry is stored: its self needs no request", async () => {
  const t = setup();
  await t.boot();
  await t.loader.ensureBundle("fr:reg:84");
  t.requests.length = 0;
  t.writes.length = 0;
  assert.equal(await t.loader.ensureSelf("fr:dep:01"), "loaded");
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "loaded");
  assert.equal(t.requests.length, 0);
  assert.equal(t.writes.length, 0);
});

test("(4) batchSelf: one request per file, one write; a failure marks only its file", async () => {
  const t = setup();
  await t.boot();
  const all = t.loader.batchSelf(DEPS);
  await t.tick(0);
  assert.deepEqual(
    await all,
    DEPS.map(() => "loaded"),
  );
  assert.equal(t.requests.length, 5);
  assert.equal(t.writes.length, 1);

  const u = setup({ "u/fr_dep_15": [503] });
  await u.boot();
  const some = u.loader.batchSelf(DEPS);
  await u.tick(1_000); // the one retry
  assert.deepEqual(await some, ["loaded", "loaded", "loaded", "failed", "loaded"]);
  assert.equal(u.requests.length, 6);
  assert.equal(u.writes.length, 1);
  // The write's span names the files written, not the one that failed.
  assert.deepEqual(
    u.written().map((s) => [s.key, s.vertices]),
    [[["u/fr_dep_01", "u/fr_dep_03", "u/fr_dep_07", "u/fr_dep_69"].join(" "), 20]],
  );
  assert.ok(u.store.has("fr:dep:69", "e50") && !u.store.has("fr:dep:15", "e50"));
  assert.deepEqual([...u.loader.failed], ["u/fr_dep_15"]);
  assert.ok(u.loader.isFailed("u", "fr:dep:15") && u.loader.selfSettled("fr:dep:15"));
});

test("(5) root.json or k/FR failing ends the session on the API, once", async () => {
  const cases: [Record<string, Reply[]>, string, string, number][] = [
    [{ root: ["html"] }, "html", "root", 2],
    [{ root: [{ body: { ...ROOT, build: "o20250101-1" } }] }, "skew", "root", 2],
    [{ root: [404] }, "missing", "root", 1],
    [{ root: ["reject"] }, "network", "root", 2],
    [{ "k/FR": [503] }, "network", "k/FR", 3],
  ];
  for (const [script, reason, key, requests] of cases) {
    const t = setup(script);
    const r = t.loader.ensureRoot();
    await t.tick(1_000);
    assert.equal(await r, "fallback");
    assert.deepEqual(t.modes, [["fallback", "fallback", { reason, key }]], reason);
    assert.equal(t.requests.length, requests, reason);
    assert.equal(t.loader.ready, "fallback");
    t.requests.length = 0;
    assert.equal(await t.loader.ensureBundle("fr:reg:84"), "fallback");
    assert.equal(await t.loader.ensureSelf("fr:dep:69"), "fallback");
    assert.deepEqual(
      await t.loader.batchSelf(DEPS),
      DEPS.map(() => "fallback"),
    );
    assert.deepEqual(await t.loader.ensureGlobe(["ES"]), ["fallback"]);
    t.loader.prefetch("k", "fr:reg:84");
    await t.tick(5_000);
    assert.equal(t.requests.length, 0);
    assert.equal(t.modes.length, 1);
  }
});

test("(6) a release skew on any file: confirmed past the cache once, then fallback", async () => {
  const t = setup({ "k/fr_reg_84": ["html"] });
  await t.boot();
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "fallback");
  assert.deepEqual(
    t.requests.map((r) => r.cache),
    [undefined, "reload"],
  );
  assert.deepEqual(t.modes.at(-1), [
    "fallback",
    "fallback",
    { reason: "html", key: "k/fr_reg_84" },
  ]);

  const u = setup({ "k/fr_reg_84": ["html", "json"] });
  await u.boot();
  assert.equal(await u.loader.ensureBundle("fr:reg:84"), "loaded");
  assert.equal(u.loader.mode, "fichiers");
  assert.equal(u.requests.length, 2);

  // A skew seen on the network retry is confirmed the same way.
  for (const [then, status] of [
    ["json", "loaded"],
    ["html", "fallback"],
  ] as const) {
    const w = setup({ "k/fr_reg_84": [503, "html", then] });
    await w.boot();
    const r = w.loader.ensureBundle("fr:reg:84");
    await w.tick(1_000);
    assert.equal(await r, status);
    assert.deepEqual(
      w.requests.map((q) => q.cache),
      [undefined, undefined, "reload"],
    );
    assert.equal(w.loader.mode, status === "loaded" ? "fichiers" : "fallback");
  }
});

test("(7) a missing file fails at once, a 503 after exactly one retry; both final", async () => {
  const t = setup({ "k/fr_reg_84": [404], "u/fr_dep_69": [503] });
  await t.boot();
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "failed");
  assert.equal(t.requests.length, 1);
  const self = t.loader.ensureSelf("fr:dep:69");
  await t.tick(1_000);
  assert.equal(await self, "failed");
  assert.equal(t.requests.length, 3);
  assert.deepEqual([...t.loader.failed], ["k/fr_reg_84", "u/fr_dep_69"]);
  t.requests.length = 0;
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "failed");
  assert.equal(await t.loader.ensureSelf("fr:dep:69"), "failed");
  assert.deepEqual(await t.loader.batchSelf(["fr:dep:69"]), ["failed"]);
  t.loader.prefetch("k", "fr:reg:84");
  t.loader.prefetch("u", "fr:dep:69");
  await t.tick(5_000);
  assert.equal(t.requests.length, 0);
  assert.equal(t.loader.mode, "fichiers");
});

test("(8) a hung request aborts at the timeout and counts as a network failure", async () => {
  const t = setup({ "k/fr_reg_84": ["hang", "json"] });
  await t.boot();
  const r = t.loader.ensureBundle("fr:reg:84");
  await t.tick(14_999);
  assert.equal(t.requests[0].signal.aborted, false);
  await t.tick(1);
  assert.equal(t.requests[0].signal.aborted, true);
  await t.tick(1_000);
  assert.equal(await r, "loaded");
  assert.equal(t.requests.length, 2);
});

test("(9) the give-up timer: at 1200 ms, armed once per request, not after a landing", async () => {
  const t = setup({ "u/fr_dep_69": [503, "hang"] });
  await t.boot();
  void t.loader.ensureSelf("fr:dep:69");
  await t.tick(1_199);
  assert.equal(t.loader.isGaveUp("u", "fr:dep:69"), false);
  assert.equal(t.requests.length, 2); // the retry began at 1000 ms
  await t.tick(1);
  assert.deepEqual([...t.loader.gaveUp], ["u/fr_dep_69"]);
  assert.ok(t.loader.selfSettled("fr:dep:69"));
  assert.equal(t.armed.filter((ms) => ms === 1_200).length, 1);

  const u = setup();
  await u.boot();
  const sets = u.sets();
  assert.equal(await u.loader.ensureSelf("fr:dep:69"), "loaded");
  await u.tick(5_000);
  assert.equal(u.loader.gaveUp.size, 0);
  assert.equal(u.sets(), sets);
});

test("(10) a prefetch joins the click's request and never writes", async () => {
  const t = setup({ "k/fr_dep_69": ["late"] });
  await t.boot();
  t.loader.prefetch("k", "fr:dep:69");
  await t.tick(5);
  const click = t.loader.ensureBundle("fr:dep:69");
  await t.tick(4);
  assert.equal(t.writes.length, 0);
  await t.tick(1);
  assert.equal(await click, "loaded");
  assert.equal(t.requests.length, 1);
  assert.equal(t.writes.length, 1);

  t.loader.prefetch("k", "fr:reg:84");
  await t.tick(0);
  assert.equal(t.requests.length, 2);
  assert.equal(t.writes.length, 1);
  assert.equal(t.store.bundleLoaded("fr:reg:84"), false);
  t.loader.prefetch("k", "fr:reg:84"); // already prefetched
  t.loader.prefetch("k", "fr:dep:69"); // loaded
  t.loader.prefetch("k", "fr:com:69001"); // k:0
  t.loader.prefetch("u", "fr:dep:99"); // no row
  await t.tick(0);
  assert.equal(t.requests.length, 2);
});

test("(11) ensureGlobe of three countries: one write", async () => {
  const t = setup();
  await t.boot();
  const r = t.loader.ensureGlobe(["ES", "IT", "DE"]);
  await t.tick(0);
  assert.deepEqual(await r, ["loaded", "loaded", "loaded"]);
  assert.equal(t.requests.length, 3);
  assert.equal(t.writes.length, 1);
  assert.ok(t.store.globeOf("ES") && t.store.loaded("g", "IT"));
});

test("(12) once the session fell back, a request under way makes no further attempt", async () => {
  const t = setup({ "u/fr_dep_01": ["html"], "u/fr_dep_03": [503] });
  await t.boot();
  const both = Promise.all([t.loader.ensureSelf("fr:dep:01"), t.loader.ensureSelf("fr:dep:03")]);
  await t.tick(0);
  assert.equal(t.loader.mode, "fallback");
  assert.equal(t.requests.length, 3); // 01, its reload confirm, 03
  await t.tick(5_000); // past 03's retry time
  assert.deepEqual(await both, ["fallback", "fallback"]);
  assert.equal(t.requests.length, 3);
  assert.equal(t.modes.length, 2);
});

test("(13) bootMs: a stalled root falls back at the deadline; a boot in time disarms it", async () => {
  const t = setup({ root: ["hang"] }, { bootMs: 6000 });
  const r = t.loader.ensureRoot();
  await t.tick(5999);
  assert.deepEqual([t.loader.mode, t.loader.ready], ["fichiers", "loading"]);
  await t.tick(1);
  assert.deepEqual(t.modes, [["fallback", "fallback", { reason: "network", key: "root" }]]);
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "fallback");
  await t.tick(20_000); // the hung request times out: no retry, the session is over
  assert.equal(await r, "fallback");
  assert.equal(t.requests.length, 1);

  const ok = setup({}, { bootMs: 6000 });
  await ok.boot();
  await ok.tick(10_000);
  assert.deepEqual(ok.modes, [["fichiers", "ok", undefined]]);
});
