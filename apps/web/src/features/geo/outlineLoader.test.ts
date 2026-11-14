// The outline loader (outlineLoader.ts) against a scripted host and a fake
// clock: one request per URL, declared files only, one write per batch, the
// failure classes and the session fallback, the timeout, the give-up timer,
// the prefetch, the low (decorative) batches: their turns, their priority,
// their deferred write, the late files kept until the map is still. Run with
// `node --import tsx --test` (root "test:scripts").
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
    row("fr:reg:03", "FR", { level: "region", name: "Guyane" }),
    row("fr:dep:973", "fr:reg:03", { name: "Guyane" }),
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
  "k/fr_dep_973": file("k", "fr:dep:973", "e50", [entry("fr:com:97302", "city", 0)]),
};

type Reply = number | "html" | "hang" | "late" | "defer" | "reject" | "json" | { body: unknown };

/** A scripted host (each URL's replies in turn, the last one repeats) and a fake clock. */
function setup(script: Record<string, Reply[]> = {}, more: Partial<OutlineLoaderOptions> = {}) {
  const requests: { url: string; cache?: string; priority?: string; signal: AbortSignal }[] = [];
  const timers = new Map<number, { at: number; fn: () => void; ms: number }>();
  const armed: number[] = [];
  let now = 0;
  let next = 0;
  const writes: number[] = [];
  const modes: unknown[][] = [];
  const spans: Record<string, unknown>[] = [];
  let sets = 0;
  /** "defer" replies waiting for release(). */
  const deferred: (() => void)[] = [];
  const fetchFn = async (
    u: string,
    init: { signal: AbortSignal; cache?: "reload"; priority?: "high" | "low" },
  ) => {
    requests.push({ url: u, cache: init.cache, priority: init.priority, signal: init.signal });
    const path = u.slice(`${BASE}outlines/${BUILD}/`.length, -".json".length);
    const list = script[path] ?? ["json"];
    const at = Math.min(requests.filter((q) => q.url === u).length, list.length) - 1;
    let r = list[at];
    // "late": the answer comes 10 ms later on the fake clock.
    if (r === "late")
      await new Promise<void>((done) => timers.set(++next, { at: now + 10, fn: done, ms: 10 }));
    // "defer": the answer (the next reply, or the default file) comes when the
    // test releases it.
    if (r === "defer") {
      await new Promise<void>((done) => deferred.push(done));
      r = list[at + 1] ?? "json";
    }
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
  const release = () => deferred.splice(0).forEach((done) => done());
  return {
    loader,
    store,
    requests,
    writes,
    modes,
    armed,
    tick,
    boot,
    written,
    spans: () => spans,
    release,
    sets: () => sets,
  };
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

test("(7) a missing file fails at once, a 503 after exactly one retry; both failed then", async () => {
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
  let settled = false;
  void t.loader.prefetch("k", "fr:dep:69").then(() => (settled = true));
  await t.tick(5);
  const click = t.loader.ensureBundle("fr:dep:69");
  await t.tick(4);
  assert.equal(t.writes.length, 0);
  assert.equal(settled, false); // settles with its request
  await t.tick(1);
  assert.equal(await click, "loaded");
  assert.equal(settled, true);
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

test("(11b) ensureGlobe with micro-states' selves: one write, no wait armed", async () => {
  const t = setup({ "u/IT": ["late"] });
  await t.boot();
  const r = t.loader.ensureGlobe(["ES", "DE"], ["IT"]);
  await t.tick(0);
  await t.tick(2_000); // past OUTLINE_WAIT_MS: nothing given up
  assert.deepEqual(await r, ["loaded", "loaded", "loaded"]);
  assert.deepEqual(t.requests.map((q) => q.url).slice(-3), [url("g/ES"), url("g/DE"), url("u/IT")]);
  assert.equal(t.writes.length, 1);
  assert.ok(t.store.globeOf("ES") && t.store.loaded("u", "IT") && !t.store.loaded("g", "IT"));
  assert.equal(t.armed.filter((ms) => ms === 1_200).length, 0);
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

test("(13) bootMs: a root past the deadline turns the session late, then ok when it lands; a boot in time disarms it", async () => {
  const t = setup({ root: ["defer"] }, { bootMs: 6000 });
  const r = t.loader.ensureRoot();
  await t.tick(5999);
  assert.deepEqual([t.loader.mode, t.loader.ready], ["fichiers", "loading"]);
  const waiting = t.loader.ensureBundle("fr:reg:84"); // waits for the boot
  await t.tick(1);
  assert.deepEqual(t.modes, [["fichiers", "late", undefined]]);
  // Not a failure: the request goes on, nothing is asked again, the waiters wait.
  assert.equal(t.requests[0].signal.aborted, false);
  await t.tick(4_000);
  assert.deepEqual([t.requests.length, t.loader.ready], [1, "late"]);
  t.release(); // root.json lands at 10 s
  await t.tick(0);
  assert.deepEqual(await Promise.all([r, waiting]), ["loaded", "loaded"]);
  assert.deepEqual(t.modes, [
    ["fichiers", "late", undefined],
    ["fichiers", "ok", undefined],
  ]);
  assert.ok(t.store.bundleLoaded("FR") && t.store.bundleLoaded("fr:reg:84"));
  assert.deepEqual(
    t.requests.map((q) => q.url),
    [url("root"), url("k/FR"), url("k/fr_reg_84")],
  );

  // A root that fails after the deadline still ends the session.
  const bad = setup({ root: ["defer", 404] }, { bootMs: 6000 });
  const rb = bad.loader.ensureRoot();
  await bad.tick(6000);
  assert.deepEqual(bad.modes, [["fichiers", "late", undefined]]);
  bad.release();
  await bad.tick(0);
  assert.equal(await rb, "fallback");
  assert.deepEqual(bad.modes.at(-1), ["fallback", "fallback", { reason: "missing", key: "root" }]);

  const ok = setup({}, { bootMs: 6000 });
  await ok.boot();
  await ok.tick(10_000);
  assert.deepEqual(ok.modes, [["fichiers", "ok", undefined]]);
});

test('(13b) bootCap "fallback": a stalled root falls back at the deadline, its request aborted', async () => {
  const t = setup({ root: ["hang"] }, { bootMs: 6000, bootCap: "fallback" });
  const r = t.loader.ensureRoot();
  await t.tick(5999);
  assert.deepEqual([t.loader.mode, t.loader.ready], ["fichiers", "loading"]);
  const waiting = t.loader.ensureBundle("fr:reg:84"); // waits for the boot
  await t.tick(1);
  assert.deepEqual(t.modes, [["fallback", "fallback", { reason: "network", key: "root" }]]);
  // The hung request is aborted at the deadline: the boot and its waiters settle now.
  assert.equal(t.requests[0].signal.aborted, true);
  assert.deepEqual(await Promise.all([r, waiting]), ["fallback", "fallback"]);
  await t.tick(20_000); // no retry: the session is over
  assert.equal(t.requests.length, 1);
});

test("(14) a network failure is asked again by the next ensure after failedMs; a missing file never", async () => {
  const t = setup({ "k/fr_dep_69": ["reject", "reject", "json"], "k/fr_reg_84": [404, "json"] });
  await t.boot();
  const first = t.loader.ensureBundle("fr:dep:69");
  await t.tick(1_000); // the one retry
  assert.equal(await first, "failed");
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "failed");
  assert.equal(t.requests.length, 3);
  await t.tick(4_999);
  assert.equal(await t.loader.ensureBundle("fr:dep:69"), "failed"); // not yet
  await t.tick(1);
  assert.equal(t.requests.length, 3); // nothing asked by the clock alone
  const sets = t.sets();
  const again = t.loader.ensureBundle("fr:dep:69");
  await t.tick(0);
  assert.equal(t.sets(), sets + 1); // left `failed` before its request
  assert.equal(await again, "loaded");
  assert.ok(t.store.bundleLoaded("fr:dep:69") && !t.loader.isFailed("k", "fr:dep:69"));
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "failed");
  assert.equal(t.requests.length, 4);
  assert.equal(t.loader.mode, "fichiers");
});

test("(15) an overseas région reads its département's files: its bundle, its self, its prefetch", async () => {
  const t = setup();
  await t.boot();
  assert.equal(await t.loader.ensureBundle("fr:reg:03"), "loaded");
  assert.deepEqual(
    t.requests.map((r) => r.url),
    [url("k/fr_dep_973")],
  );
  assert.ok(t.store.bundleLoaded("fr:reg:03"));
  assert.ok(t.store.unitsOf("fr:reg:03")?.has("fr:com:97302"));
  assert.equal(await t.loader.ensureSelf("fr:reg:03"), "loaded");
  assert.equal(t.loader.selfSettled("fr:reg:03"), true);
  assert.equal(t.requests.length, 1);

  const p = setup({ "k/fr_dep_973": [404] });
  await p.boot();
  await p.loader.prefetch("k", "fr:reg:03");
  assert.deepEqual(
    p.requests.map((r) => r.url),
    [url("k/fr_dep_973")],
  );
  assert.equal(await p.loader.ensureBundle("fr:reg:03"), "failed");
  assert.equal(p.loader.isFailed("k", "fr:reg:03"), true);
  assert.deepEqual(await p.loader.batchSelf(["fr:reg:03"]), ["loaded"]);
  assert.ok(p.requests.every((r) => !r.url.includes("fr_reg_03")));
  assert.equal(p.requests[p.requests.length - 1].url, url("u/fr_dep_973"));
});

test("(16) a low batch: low priority, at most lowParallel at once, each timer armed at its start", async () => {
  const t = setup({ "g/ES": ["defer"], "g/IT": ["defer"], "g/DE": ["hang"] }, { lowParallel: 2 });
  await t.boot();
  t.armed.length = 0;
  const r = t.loader.ensureGlobe(["ES", "IT", "DE"], [], true);
  await t.tick(0);
  assert.deepEqual(
    t.requests.map((q) => [q.url, q.priority]),
    [
      [url("g/ES"), "low"],
      [url("g/IT"), "low"],
    ],
  );
  // DE waits its turn: no request, no abort timer for it yet.
  assert.equal(t.armed.filter((ms) => ms === 15_000).length, 2);
  await t.tick(14_000);
  assert.equal(t.requests.length, 2);
  t.release(); // ES and IT land at 14 s: DE's turn
  await t.tick(0);
  assert.deepEqual(t.requests.at(-1)?.url, url("g/DE"));
  assert.equal(t.requests.at(-1)?.priority, "low");
  assert.equal(t.armed.filter((ms) => ms === 15_000).length, 3);
  // Its 15 s count from its start (14 s), not from the batch's (0 s).
  await t.tick(1_500);
  assert.equal(t.requests.at(-1)?.signal.aborted, false);
  await t.tick(13_600); // 15 s after DE started: aborted, retried once 1 s later
  assert.equal(t.requests.filter((q) => q.url === url("g/DE"))[0].signal.aborted, true);
  await t.tick(16_000);
  assert.deepEqual(await r, ["loaded", "loaded", "failed"]);
  assert.equal(t.writes.length, 1);
});

test("(16b) without lowParallel a low batch is not capped; a batch not low has no priority", async () => {
  const t = setup();
  await t.boot();
  const low = t.loader.ensureGlobe(["ES", "IT", "DE"], [], true);
  await t.tick(0);
  assert.deepEqual(await low, ["loaded", "loaded", "loaded"]);
  assert.deepEqual(
    t.requests.map((q) => q.priority),
    ["low", "low", "low"],
  );
  t.requests.length = 0;
  const plain = t.loader.batchSelf(["fr:dep:01", "fr:dep:03"]);
  await t.tick(0);
  assert.deepEqual(await plain, ["loaded", "loaded"]);
  assert.deepEqual(
    t.requests.map((q) => q.priority),
    [undefined, undefined],
  );
});

test("(17) applyLow: a low batch is written when the page says, a batch not low at once", async () => {
  const pending: (() => void)[] = [];
  const t = setup({}, { applyLow: (write) => void pending.push(write) });
  await t.boot();
  let settled = false;
  const r = t.loader.batchSelf(["fr:dep:01", "fr:dep:03"], true).then((s) => {
    settled = true;
    return s;
  });
  await t.tick(0);
  assert.equal(t.requests.length, 2);
  assert.equal(pending.length, 1);
  assert.equal(t.writes.length, 0);
  assert.equal(settled, false);
  assert.ok(!t.store.loaded("u", "fr:dep:01"));
  pending.shift()!();
  assert.deepEqual(await r, ["loaded", "loaded"]);
  assert.equal(t.writes.length, 1);
  assert.ok(t.store.loaded("u", "fr:dep:01") && t.store.loaded("u", "fr:dep:03"));
  // Not low: written at once, applyLow never asked.
  const plain = t.loader.ensureGlobe(["ES"]);
  await t.tick(0);
  assert.deepEqual(await plain, ["loaded"]);
  assert.equal(pending.length, 0);
  assert.equal(t.writes.length, 2);
  // A low batch with nothing to write does not ask either.
  assert.deepEqual(await t.loader.ensureGlobe(["ES"], [], true), ["loaded"]);
  assert.equal(pending.length, 0);
});

test("(18) a caller that is not low starts a low request still waiting its turn, at the default priority", async () => {
  const t = setup({ "u/fr_dep_01": ["defer"] }, { lowParallel: 1 });
  await t.boot();
  const batch = t.loader.batchSelf(["fr:dep:01", "fr:dep:69"], true);
  await t.tick(0);
  assert.deepEqual(
    t.requests.map((q) => q.url),
    [url("u/fr_dep_01")],
  );
  // The visitor's own selection asks fr:dep:69's self: it starts now.
  const self = t.loader.ensureSelf("fr:dep:69");
  await t.tick(0);
  assert.deepEqual(
    t.requests.map((q) => [q.url, q.priority]),
    [
      [url("u/fr_dep_01"), "low"],
      [url("u/fr_dep_69"), undefined],
    ],
  );
  assert.equal(await self, "loaded");
  t.release();
  await t.tick(0);
  assert.deepEqual(await batch, ["loaded", "loaded"]);
  assert.equal(t.requests.length, 2); // one request per URL still
  // The turn held by fr:dep:01 was given back: a next low batch runs.
  const next = t.loader.ensureGlobe(["ES"], [], true);
  await t.tick(0);
  assert.deepEqual(await next, ["loaded"]);
});

test("(19) a low request waiting its turn when the session falls back is never sent", async () => {
  const t = setup({ "g/ES": ["defer"], "k/fr_reg_84": ["html"] }, { lowParallel: 1 });
  await t.boot();
  const first = t.loader.ensureGlobe(["ES"], [], true);
  const second = t.loader.ensureGlobe(["IT"], [], true);
  await t.tick(0);
  assert.deepEqual(
    t.requests.map((q) => q.url),
    [url("g/ES")],
  );
  // A release skew elsewhere ends the session while g/IT waits its turn.
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "fallback");
  t.release();
  await t.tick(0);
  assert.deepEqual(await first, ["fallback"]);
  assert.deepEqual(await second, ["fallback"]);
  assert.ok(!t.requests.some((q) => q.url === url("g/IT")));
});

test("(20) bootRetryMs: a boot failed on the network turns late, is asked again after each wait, and lands", async () => {
  // root.json: refused twice (its own retry included), then answered.
  const t = setup({ root: ["reject", "reject", "json"] }, { bootRetryMs: [2000, 5000] });
  const r = t.loader.ensureRoot();
  const waiting = t.loader.ensureBundle("fr:reg:84"); // waits for the boot
  await t.tick(1_000); // the request's own retry
  assert.deepEqual(t.modes, [["fichiers", "late", undefined]]);
  assert.equal(t.requests.length, 2);
  await t.tick(1_999);
  assert.equal(t.requests.length, 2, "not before the first wait");
  await t.tick(1);
  assert.deepEqual(await Promise.all([r, waiting]), ["loaded", "loaded"]);
  assert.deepEqual(t.modes, [
    ["fichiers", "late", undefined],
    ["fichiers", "ok", undefined],
  ]);
  assert.deepEqual(
    t.requests.map((q) => q.url),
    [url("root"), url("root"), url("root"), url("k/FR"), url("k/fr_reg_84")],
  );
});

test("(20b) bootRetryMs: k/FR failed is asked again alone; past the waits, reconnect() alone brings an attempt", async () => {
  const t = setup({ "k/FR": [503] }, { bootRetryMs: [2000] });
  const r = t.loader.ensureRoot();
  await t.tick(1_000);
  assert.deepEqual([t.loader.mode, t.loader.ready], ["fichiers", "late"]);
  assert.equal(t.writes.length, 1, "root.json is in");
  await t.tick(2_000 + 1_000); // the one wait, then the request and its own retry
  assert.equal(t.requests.filter((q) => q.url === url("root")).length, 1, "root.json once");
  assert.equal(t.requests.filter((q) => q.url === url("k/FR")).length, 4);
  await t.tick(600_000);
  assert.equal(t.requests.length, 5, "nothing past the waits");
  assert.equal(t.loader.mode, "fichiers");
  // The network comes back: one attempt now, the waits started over.
  const t2 = setup({ "k/FR": [503, 503, 503, 503, "json"] }, { bootRetryMs: [2000] });
  const r2 = t2.loader.ensureRoot();
  await t2.tick(1_000 + 2_000 + 1_000 + 60_000);
  assert.equal(t2.requests.length, 5);
  t2.loader.reconnect();
  await t2.tick(0);
  assert.equal(await r2, "loaded");
  assert.deepEqual(t2.modes.at(-1), ["fichiers", "ok", undefined]);
  t.loader.reconnect();
  await t.tick(1_000);
  assert.equal(t.requests.length, 7, "asked again on reconnect");
  void r;
});

test("(20c) bootRetryMs: a skew or a missing root still ends the session; so does the cap's fallback during a wait", async () => {
  const cases: [Record<string, Reply[]>, string][] = [
    [{ root: [404] }, "missing"],
    [{ root: ["html"] }, "html"],
  ];
  for (const [script, reason] of cases) {
    const t = setup(script, { bootRetryMs: [2000] });
    const r = t.loader.ensureRoot();
    await t.tick(1_000);
    assert.equal(await r, "fallback");
    assert.deepEqual(t.modes, [["fallback", "fallback", { reason, key: "root" }]]);
  }
  const t = setup(
    { root: ["reject"] },
    { bootRetryMs: [60_000], bootMs: 6000, bootCap: "fallback" },
  );
  const r = t.loader.ensureRoot();
  await t.tick(6_000);
  assert.equal(await r, "fallback");
  assert.equal(t.loader.mode, "fallback");
  await t.tick(120_000);
  assert.equal(t.requests.length, 2, "never asked again");
});

test("(20d) reconnect(): a file failed on the network is asked again by the next ensure, without its wait", async () => {
  const t = setup({ "k/fr_dep_69": ["reject", "reject", "json"], "k/fr_reg_84": [404, "json"] });
  await t.boot();
  const first = t.loader.ensureBundle("fr:dep:69");
  await t.tick(1_000);
  assert.equal(await first, "failed");
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "failed");
  t.loader.reconnect();
  const again = t.loader.ensureBundle("fr:dep:69");
  await t.tick(0);
  assert.equal(await again, "loaded");
  assert.equal(await t.loader.ensureBundle("fr:reg:84"), "failed", "a missing file stays failed");
  t.loader.reconnect(); // nothing waits: a no-op
  assert.equal(t.loader.mode, "fichiers");
});

// ---- The late files (`late`: the page's ac:late-files "quiet") ----

/** A loader with the late rules: `urgent` the keys a plateau waits for,
 *  `still()` the map coming to rest (the jobs asked of whenStill run). */
function quiet(script: Record<string, Reply[]> = {}, more: Partial<OutlineLoaderOptions> = {}) {
  const urgent = new Set<string>();
  const jobs: (() => void)[] = [];
  let heldChanges = 0;
  const t = setup(script, {
    late: {
      urgent: (key) => urgent.has(key),
      whenStill: (job) => void jobs.push(job),
      onHeld: () => void heldChanges++,
    },
    ...more,
  });
  const still = async () => {
    for (const job of jobs.splice(0)) job();
    await t.tick(0);
  };
  const parsed = () =>
    t
      .spans()
      .filter((s) => s.name === "outline.parse")
      .map((s) => s.key);
  return { ...t, urgent, still, parsed, armed: () => jobs.length, heldChanges: () => heldChanges };
}

// ---- The low batches and the late files together ----

test("(LD1) a low request whose text is kept gives its turn back: the next starts before the map is still", async () => {
  const pending: (() => void)[] = [];
  const t = quiet({}, { lowParallel: 1, applyLow: (write) => void pending.push(write) });
  await t.boot();
  t.requests.length = 0;
  let settled = false;
  const r = t.loader.ensureGlobe(["ES", "IT", "DE"], [], true).then((s) => {
    settled = true;
    return s;
  });
  await t.tick(0);
  // One at a time, yet all three went out, the map never still: each kept
  // text gave its turn back as it landed.
  assert.deepEqual(
    t.requests.map((q) => [q.url, q.priority]),
    [
      [url("g/ES"), "low"],
      [url("g/IT"), "low"],
      [url("g/DE"), "low"],
    ],
  );
  assert.deepEqual([...t.loader.held].sort(), ["g/DE", "g/ES", "g/IT"]);
  assert.equal(settled, false);
  const writes = t.writes.length;
  await t.still(); // the flush: ONE write for the three
  assert.equal(t.writes.length, writes + 1);
  assert.ok(t.store.loaded("g", "ES") && t.store.loaded("g", "IT") && t.store.loaded("g", "DE"));
  // The batch's own write is still asked of the page, and finds them stored.
  assert.equal(pending.length, 1);
  pending.shift()!();
  assert.deepEqual(await r, ["loaded", "loaded", "loaded"]);
  assert.equal(t.writes.length, writes + 1);
  // Every turn went back: a next low batch runs.
  const next = t.loader.batchSelf(["fr:dep:01"], true);
  await t.tick(0);
  assert.equal(t.requests.at(-1)?.url, url("u/fr_dep_01"));
  await t.still();
  pending.shift()!();
  assert.deepEqual(await next, ["loaded"]);
});

test("(LD2) a low request waiting its turn that a plateau comes to wait for starts at once, at high priority, and is written as it lands", async () => {
  const pending: (() => void)[] = [];
  const t = quiet(
    { "u/fr_dep_01": ["defer"] },
    { lowParallel: 1, applyLow: (write) => void pending.push(write) },
  );
  await t.boot();
  t.requests.length = 0;
  const batch = t.loader.batchSelf(["fr:dep:01", "fr:dep:07"], true);
  await t.tick(0);
  assert.deepEqual(
    t.requests.map((q) => [q.url, q.priority]),
    [[url("u/fr_dep_01"), "low"]],
  );
  // The visitor selects fr:dep:07: its plateau waits for the file.
  t.urgent.add("u/fr_dep_07");
  const self = t.loader.ensureSelf("fr:dep:07");
  await t.tick(0);
  assert.deepEqual(
    t.requests.map((q) => [q.url, q.priority]),
    [
      [url("u/fr_dep_01"), "low"],
      [url("u/fr_dep_07"), "high"],
    ],
  );
  assert.equal(await self, "loaded"); // not kept: written as it landed
  assert.ok(t.store.loaded("u", "fr:dep:07"));
  t.release();
  await t.tick(0);
  await t.still();
  pending.shift()!();
  assert.deepEqual(await batch, ["loaded", "loaded"]);
  assert.equal(t.requests.length, 2); // one request per URL still
});

test("(L1) without the late rules no request carries a fetch priority", async () => {
  const t = setup();
  await t.boot();
  await Promise.all([t.loader.ensureBundle("fr:dep:69", true), t.tick(0)]);
  await Promise.all([t.loader.batchSelf(["fr:dep:01"]), t.tick(0)]);
  assert.deepEqual(
    t.requests.map((r) => r.priority),
    [undefined, undefined],
  );
});

test("(L2) fetch priority: none at boot, high for a due file, low for the others", async () => {
  const t = quiet();
  const boot = t.loader.ensureRoot();
  await t.tick(0);
  assert.equal(await boot, "loaded");
  assert.deepEqual(
    t.requests.map((r) => r.priority),
    [undefined, undefined], // root.json, k/FR: as before
  );
  t.requests.length = 0;
  t.urgent.add("u/fr_dep_07");
  void t.loader.ensureSelf("fr:dep:07"); // a plateau waits for it
  void t.loader.ensureBundle("fr:dep:69"); // a unit's children
  void t.loader.batchSelf(["fr:dep:01"]); // a neighbour
  void t.loader.ensureGlobe(["ES"]); // the world's outlines
  void t.loader.prefetch("u", "fr:dep:03"); // a hover
  await t.tick(0);
  assert.deepEqual(t.requests.map((r) => [r.url, r.priority]).sort(), [
    [url("g/ES"), "low"],
    [url("k/fr_dep_69"), "low"],
    [url("u/fr_dep_01"), "low"],
    [url("u/fr_dep_03"), "low"],
    [url("u/fr_dep_07"), "high"],
  ]);
  await t.still();
});

test("(L3) a file nothing waits for is kept as text: parsed and written when the map is still", async () => {
  const t = quiet();
  await t.boot();
  let status = "";
  void t.loader.ensureBundle("fr:dep:69").then((s) => (status = s));
  await t.tick(0);
  // Landed: neither parsed nor written, its caller still waiting.
  assert.deepEqual([...t.loader.held], ["k/fr_dep_69"]);
  assert.equal(t.store.bundleLoaded("fr:dep:69"), false);
  assert.ok(!t.parsed().includes("k/fr_dep_69"));
  assert.equal(status, "");
  assert.equal(t.armed(), 1);
  const writes = t.writes.length;
  await t.still();
  assert.equal(status, "loaded");
  assert.equal(t.store.bundleLoaded("fr:dep:69"), true);
  assert.ok(t.parsed().includes("k/fr_dep_69"));
  assert.equal(t.writes.length, writes + 1);
  assert.deepEqual([...t.loader.held], []);
});

test("(L4) the kept files are written in ONE write, whoever asked them", async () => {
  const t = quiet();
  await t.boot();
  const all = Promise.all([
    t.loader.ensureBundle("fr:dep:69"),
    t.loader.batchSelf(["fr:dep:01", "fr:dep:03"]),
  ]);
  await t.tick(0);
  assert.equal(t.loader.held.size, 3);
  assert.equal(t.writes.length, 0);
  assert.equal(t.armed(), 1); // one flush asked for the three
  await t.still();
  assert.deepEqual(await all, ["loaded", ["loaded", "loaded"]]);
  assert.equal(t.writes.length, 1);
  assert.deepEqual(
    t.written().map((s) => s.key),
    ["k/fr_dep_69 u/fr_dep_01 u/fr_dep_03"],
  );
});

test("(L5) a file a plateau waits for is written as it lands", async () => {
  const t = quiet();
  await t.boot();
  t.urgent.add("k/fr_reg_84");
  const r = t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(0);
  assert.equal(await r, "loaded");
  assert.equal(t.store.bundleLoaded("fr:reg:84"), true);
  assert.equal(t.armed(), 0);
  assert.equal(t.loader.abandonedDone, 0);
});

test("(L6) a file asked due for a unit since left is kept too, and counted as abandoned", async () => {
  const t = quiet({ "k/fr_reg_84": ["defer"] });
  await t.boot();
  t.urgent.add("k/fr_reg_84");
  let status = "";
  void t.loader.ensureBundle("fr:reg:84", true).then((s) => (status = s));
  await t.tick(0);
  assert.equal(t.loader.abandoned(), false); // on the network, and waited for
  t.urgent.clear(); // the visitor went elsewhere
  assert.equal(t.loader.abandoned(), true);
  t.release();
  await t.tick(0);
  assert.equal(t.loader.abandoned(), false);
  assert.equal(t.loader.abandonedDone, 1);
  assert.deepEqual([...t.loader.held], ["k/fr_reg_84"]);
  assert.equal(t.store.bundleLoaded("fr:reg:84"), false);
  assert.equal(t.requests.filter((q) => q.signal.aborted).length, 0); // nothing aborted
  await t.still();
  assert.equal(status, "loaded");
});

test("(L7) a kept file a plateau comes to wait for is written at once: a due ask, or flushDue", async () => {
  const t = quiet();
  await t.boot();
  void t.loader.ensureBundle("fr:reg:84");
  void t.loader.batchSelf(["fr:dep:01"]);
  await t.tick(0);
  assert.equal(t.loader.held.size, 2);
  // The selection comes back: its chain asks it due.
  const r = t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(0);
  assert.equal(await r, "loaded");
  assert.deepEqual([...t.loader.held], ["u/fr_dep_01"]); // the other stays kept
  assert.equal(t.requests.filter((q) => q.url === url("k/fr_reg_84")).length, 1);
  // …or the rule turns, with no new ask.
  t.urgent.add("u/fr_dep_01");
  t.loader.flushDue();
  await t.tick(0);
  assert.equal(t.loader.held.size, 0);
  assert.equal(t.store.has("fr:dep:01", "e50"), true);
  // The flush asked earlier finds nothing left.
  const writes = t.writes.length;
  await t.still();
  assert.equal(t.writes.length, writes);
});

test("(L8) the flush waits once for the late files still on the network: one write for the batch", async () => {
  const t = quiet({ "u/fr_dep_03": ["defer"] });
  await t.boot();
  void t.loader.ensureBundle("fr:reg:84");
  await t.tick(0);
  t.writes.length = 0;
  void t.loader.ensureBundle("fr:dep:69");
  const batch = t.loader.batchSelf(["fr:dep:01", "fr:dep:03"]);
  await t.tick(0);
  await t.still(); // still, but u/fr_dep_03 is on its way: not yet
  assert.equal(t.writes.length, 0);
  t.release();
  await t.tick(399);
  assert.equal(t.armed(), 0);
  await t.tick(1);
  assert.equal(t.armed(), 1); // asked again after LATE_BATCH_MS
  await t.still();
  assert.deepEqual(await batch, ["loaded", "loaded"]);
  assert.equal(t.writes.length, 1);
  assert.deepEqual(
    t.written().map((s) => s.key),
    ["k/fr_reg_84 k/fr_dep_69 u/fr_dep_01 u/fr_dep_03"],
  );
});

test("(L8b) …and only once: a file still not in after the wait comes with the next flush", async () => {
  const t = quiet({ "u/fr_dep_03": ["defer"] });
  await t.boot();
  void t.loader.ensureBundle("fr:reg:84");
  void t.loader.batchSelf(["fr:dep:03"]);
  await t.tick(0);
  t.writes.length = 0;
  await t.still();
  await t.tick(400);
  await t.still(); // the second still moment: whatever is in
  assert.equal(t.writes.length, 1);
  assert.equal(t.store.bundleLoaded("fr:reg:84"), true);
  t.release();
  await t.tick(0);
  await t.still();
  assert.equal(t.writes.length, 2);
});

test("(L8c) the files of one batch are written together, however late the last one", async () => {
  const t = quiet({ "u/fr_dep_03": ["defer"], "u/fr_dep_07": ["defer", 404] });
  await t.boot();
  const batch = t.loader.batchSelf(["fr:dep:01", "fr:dep:03", "fr:dep:07"]);
  void t.loader.ensureBundle("fr:dep:69"); // not of the batch
  await t.tick(0);
  await t.still();
  await t.tick(400);
  await t.still(); // the wait is over: the bundle goes, the batch's first file stays kept
  assert.deepEqual(
    t.written().map((s) => s.key),
    ["k/fr_dep_69"],
  );
  assert.deepEqual([...t.loader.held], ["u/fr_dep_01"]);
  // Its other files come much later — one of them missing: the batch is whole.
  await t.tick(3000);
  t.release();
  await t.tick(0);
  await t.still();
  await t.tick(400);
  await t.still();
  assert.deepEqual(await batch, ["loaded", "loaded", "failed"]);
  assert.deepEqual(
    t.written().map((s) => s.key),
    ["k/fr_dep_69", "u/fr_dep_01 u/fr_dep_03"],
  );
});

test("(L9) a request only a prefetch made is never kept and never writes", async () => {
  const t = quiet();
  await t.boot();
  await Promise.all([t.loader.prefetch("k", "fr:reg:84"), t.tick(0)]);
  assert.equal(t.loader.held.size, 0);
  assert.equal(t.armed(), 0);
  assert.equal(t.store.bundleLoaded("fr:reg:84"), false);
  assert.equal(t.writes.length, 0);
});

test("(L10) a session that falls back drops the kept files: their callers answer fallback", async () => {
  const t = quiet({ "u/fr_dep_01": ["html"] });
  await t.boot();
  const kept = t.loader.ensureBundle("fr:dep:69");
  await t.tick(0);
  assert.equal(t.loader.held.size, 1);
  // A release skew on another file (confirmed past the cache) ends the session.
  t.urgent.add("u/fr_dep_01");
  const skew = t.loader.ensureSelf("fr:dep:01");
  await t.tick(0);
  assert.equal(await skew, "fallback");
  await t.still();
  assert.equal(await kept, "fallback");
  assert.equal(t.store.bundleLoaded("fr:dep:69"), false);
  assert.equal(t.loader.held.size, 0);
});

test("(L11) a kept self is not given up; a wait an abandoned file crossed goes on once", async () => {
  const t = quiet({ "k/fr_reg_84": ["defer"], "u/fr_dep_01": ["defer"] });
  await t.boot();
  // A neighbour's self kept as text past the wait: in, not given up.
  void t.loader.batchSelf(["fr:dep:03"]);
  await t.tick(1300);
  assert.deepEqual([...t.loader.held], ["u/fr_dep_03"]);
  assert.equal(t.loader.isGaveUp("u", "fr:dep:03"), false);
  // A due file abandoned on the network while another self is waited for.
  t.urgent.add("k/fr_reg_84");
  void t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(0);
  t.urgent.clear();
  t.urgent.add("u/fr_dep_01");
  void t.loader.ensureSelf("fr:dep:01");
  await t.tick(1200);
  assert.equal(t.loader.isGaveUp("u", "fr:dep:01"), false); // one more wait
  await t.tick(1200);
  assert.equal(t.loader.isGaveUp("u", "fr:dep:01"), true); // bounded
});

test("(S1) a self ahead of its bundle: high and low priority, written alone once the grace is over; the bundle then adds the children and keeps the self's object", async () => {
  const t = quiet({ "k/fr_reg_84": ["defer"] }, { selfGraceMs: 80 });
  await t.boot();
  t.urgent.add("u/fr_reg_84").add("k/fr_reg_84"); // its plateau is pending
  let self = "";
  let bundle = "";
  void t.loader.ensureSelf("fr:reg:84").then((s) => (self = s));
  void t.loader.ensureBundle("fr:reg:84").then((s) => (bundle = s));
  await t.tick(0);
  assert.deepEqual(t.requests.map((r) => [r.url, r.priority]).sort(), [
    [url("k/fr_reg_84"), "low"],
    [url("u/fr_reg_84"), "high"],
  ]);
  // In, and waiting for the bundle: nothing written yet.
  assert.equal(t.store.selfOf("fr:reg:84"), undefined);
  await t.tick(79);
  assert.equal(self, "");
  await t.tick(1);
  assert.equal(self, "loaded");
  const own = t.store.selfOf("fr:reg:84");
  assert.ok(own);
  assert.equal(t.store.bundleLoaded("fr:reg:84"), false);
  assert.equal(t.writes.length, 1);
  // The plateau rose: nothing waits for the bundle, which lands and is kept.
  t.urgent.clear();
  t.release();
  await t.tick(0);
  assert.deepEqual([...t.loader.held], ["k/fr_reg_84"]);
  await t.still();
  assert.equal(bundle, "loaded");
  assert.equal(t.writes.length, 2);
  assert.equal(t.store.selfOf("fr:reg:84"), own); // the same object: no new shape
  assert.equal(t.store.unitsOf("fr:reg:84")?.size, DEPS.length);
  assert.equal(t.store.stats().dedupeHits, 1);
});

test("(S2) a bundle landing within the grace is written first, in one write, and the self writes nothing", async () => {
  const t = quiet({ "k/fr_reg_84": ["late"] }, { selfGraceMs: 80 });
  await t.boot();
  t.urgent.add("u/fr_reg_84").add("k/fr_reg_84");
  let self = "";
  void t.loader.ensureSelf("fr:reg:84").then((s) => (self = s));
  void t.loader.ensureBundle("fr:reg:84");
  await t.tick(9);
  assert.equal(t.writes.length, 0);
  await t.tick(1);
  assert.equal(self, "loaded");
  assert.equal(t.writes.length, 1);
  assert.equal(t.store.bundleLoaded("fr:reg:84"), true);
  assert.ok(t.store.selfOf("fr:reg:84"));
  assert.equal(t.store.loaded("u", "fr:reg:84"), false);
  await t.tick(200);
  assert.equal(t.writes.length, 1);
  assert.deepEqual([...t.loader.gaveUp], []);
});

test("(S3) no bundle on the network, or no grace: the self is written as it lands", async () => {
  const alone = quiet({}, { selfGraceMs: 80 });
  await alone.boot();
  alone.urgent.add("u/fr_reg_84");
  void alone.loader.ensureSelf("fr:reg:84");
  await alone.tick(0);
  assert.ok(alone.store.selfOf("fr:reg:84"));

  const none = quiet({ "k/fr_reg_84": ["defer"] });
  await none.boot();
  none.urgent.add("u/fr_reg_84");
  void none.loader.ensureSelf("fr:reg:84");
  void none.loader.ensureBundle("fr:reg:84");
  await none.tick(0);
  assert.ok(none.store.selfOf("fr:reg:84"));
  none.release();
  await none.tick(0);
  await none.still();
});

test("(S4) a self that fails while its bundle comes: the bundle still brings it", async () => {
  const t = quiet({ "u/fr_reg_84": [404], "k/fr_reg_84": ["late"] }, { selfGraceMs: 80 });
  await t.boot();
  t.urgent.add("u/fr_reg_84").add("k/fr_reg_84");
  let self = "";
  void t.loader.ensureSelf("fr:reg:84").then((s) => (self = s));
  void t.loader.ensureBundle("fr:reg:84");
  await t.tick(0);
  assert.equal(self, "failed");
  assert.equal(t.loader.isFailed("u", "fr:reg:84"), true);
  await t.tick(10);
  assert.ok(t.store.selfOf("fr:reg:84"));
  assert.equal(t.loader.selfSettled("fr:reg:84"), true);
});

// ---- reask: the attempts a plateau waits for, dropped and made again ----

test("(R1) a hung attempt asked again: dropped, made again at once, none of the request's two", async () => {
  const t = setup({ "k/fr_reg_84": ["hang", "hang", "json"] });
  await t.boot();
  const r = t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(5_000);
  assert.deepEqual(
    t.loader.reask(() => true),
    ["k/fr_reg_84"],
  );
  await t.tick(0);
  assert.equal(t.requests[0].signal.aborted, true);
  assert.equal(t.requests.length, 2); // no retry pause: asked at once
  assert.deepEqual(
    t.loader.reask(() => true),
    ["k/fr_reg_84"],
  );
  await t.tick(0);
  assert.equal(await r, "loaded");
  assert.equal(t.requests.length, 3);
  assert.equal(t.armed.includes(1_000), false);
  assert.equal(t.loader.failed.size, 0);
  assert.equal(t.writes.length, 1);
});

test("(R2) an attempt asked again that then fails on the network keeps the request's own retry", async () => {
  const t = setup({ "k/fr_reg_84": ["hang", 503, "json"] });
  await t.boot();
  const r = t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(0);
  t.loader.reask(() => true);
  await t.tick(999);
  assert.equal(t.requests.length, 2);
  await t.tick(1);
  assert.equal(await r, "loaded");
  assert.equal(t.requests.length, 3);
});

test("(R3) only the files named are asked again; with nothing on the network, nothing is", async () => {
  const t = setup({ "k/fr_reg_84": ["hang", "json"], "u/fr_dep_69": ["hang"] });
  await t.boot();
  assert.deepEqual(
    t.loader.reask(() => true),
    [],
  );
  const bundle = t.loader.ensureBundle("fr:reg:84", true);
  void t.loader.ensureSelf("fr:dep:69");
  await t.tick(0);
  assert.deepEqual(
    t.loader.reask((key) => key === "k/fr_reg_84"),
    ["k/fr_reg_84"],
  );
  await t.tick(0);
  assert.equal(await bundle, "loaded");
  const self = t.requests.filter((q) => q.url.includes("u/fr_dep_69"));
  assert.equal(self.length, 1);
  assert.equal(self[0].signal.aborted, false);
});

test("(R4) the attempt made again keeps its fetch priority, and a file kept as text is left alone", async () => {
  const t = quiet({ "k/fr_reg_84": ["hang", "json"] });
  await t.boot();
  t.urgent.add("k/fr_reg_84");
  const r = t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(0);
  assert.deepEqual(
    t.loader.reask((key) => t.urgent.has(key)),
    ["k/fr_reg_84"],
  );
  await t.tick(0);
  assert.equal(await r, "loaded");
  assert.deepEqual(
    t.requests.map((q) => q.priority),
    ["high", "high"],
  );
  // A late file, in as text and waiting for a still map: nothing to ask again.
  void t.loader.ensureBundle("fr:dep:69");
  await t.tick(0);
  assert.equal(t.loader.held.has("k/fr_dep_69"), true);
  assert.deepEqual(
    t.loader.reask(() => true),
    [],
  );
  await t.still();
  assert.equal(t.store.bundleLoaded("fr:dep:69"), true);
  assert.equal(t.requests.filter((q) => q.url.includes("k/fr_dep_69")).length, 1);
});

test("(R5) a session that fell back asks nothing again", async () => {
  const t = setup({ "k/fr_reg_84": ["hang"], "u/fr_dep_69": ["html"] });
  await t.boot();
  void t.loader.ensureBundle("fr:reg:84", true);
  await t.tick(0);
  assert.equal(await t.loader.ensureSelf("fr:dep:69"), "fallback"); // a release skew
  assert.deepEqual(
    t.loader.reask(() => true),
    [],
  );
  assert.equal(t.requests.filter((q) => q.url.includes("k/fr_reg_84")).length, 1);
});
