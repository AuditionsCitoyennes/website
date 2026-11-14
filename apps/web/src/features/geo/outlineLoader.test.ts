// The outline loader (outlineLoader.ts) against a scripted host and a fake
// clock: one request per URL, declared files only, one write per batch, the
// failure classes and the session fallback, the timeout, the give-up timer,
// the prefetch, the low (decorative) batches: their turns, their priority,
// their deferred write. Run with `node --import tsx --test` (root "test:scripts").
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
    init: { signal: AbortSignal; cache?: "reload"; priority?: "low" },
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
