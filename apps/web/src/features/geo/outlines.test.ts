// The outline files' check and store (outlines.ts): the response classes, the
// rows, identity by `id@tier`, one write per call, the LRU. Run with
// `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no alias.
// The fixtures are cut from the real build o20261101-1.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkResponse,
  fileKey,
  fileUrl,
  isReleaseSkew,
  keyOf,
  OutlineStore,
  parseBody,
  rootUrl,
  validateBody,
  type FileEntryV1,
  type FileSelfV1,
  type KFileV1,
  type OutlineFileV1,
  type OutlineGeometry,
  type OutlineKind,
  type RootV1,
  type UFileV1,
} from "./outlines";

const BUILD = "o20261101-1";
const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/outlines/${path}`, import.meta.url), "utf8"));
const ROOT = () => fixture("root.json") as RootV1;
const LYON = () => fixture("k/fr_com_69123.json") as KFileV1;
const PARIS = () => fixture("u/fr_dep_75.json") as UFileV1;

const square = (): OutlineGeometry => ({
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
});
const self = (id: string, n = 5): FileSelfV1 => ({
  id,
  bbox: [1, 2, 3, 4],
  center: [3, 2],
  n,
  g: square(),
});
const entry = (id: string, level: FileEntryV1["level"], n = 5): FileEntryV1 => ({
  ...self(id, n),
  name: id,
  level,
  k: 1,
  u: 0,
});
const kFile = (id: string, tier: string, units: FileEntryV1[], n = 5): KFileV1 => ({
  v: 1,
  build: BUILD,
  kind: "k",
  id,
  tier,
  tolM: 0,
  self: self(id, n),
  units,
});
const uFile = (id: string, tier: string, n = 5): UFileV1 => ({
  v: 1,
  build: BUILD,
  kind: "u",
  id,
  tier,
  tolM: 0,
  self: self(id, n),
});
const raw = <T extends object>(o: T): T => o;

test("the response's head: missing, network, html", () => {
  const head = (status: number, contentType: string | null) => ({
    ok: status < 300,
    status,
    contentType,
  });
  assert.equal(checkResponse(head(404, "text/html")), "missing");
  assert.equal(checkResponse(head(410, null)), "missing");
  assert.equal(checkResponse(head(503, "text/html")), "network");
  assert.equal(checkResponse(null), "network"); // a rejected fetch, a timeout
  assert.equal(checkResponse(head(200, "text/html; charset=utf-8")), "html"); // the SPA's index.html
  assert.equal(checkResponse(head(200, null)), "html");
  assert.equal(checkResponse(head(200, "application/json; charset=utf-8")), null);
  // A JSON content-type over a body that does not parse: the host serves something else.
  assert.deepEqual(parseBody('{"v":1,"build"'), { ok: false, reason: "html" });
  assert.deepEqual(parseBody("<!doctype html>"), { ok: false, reason: "html" });
});

test("the body: version, skew, then shape; the real files pass", () => {
  const k = (over: Record<string, unknown>) => ({ ...kFile("fr:dep:69", "e50", []), ...over });
  const want: { build: string; kind: OutlineKind; id: string } = {
    build: BUILD,
    kind: "k",
    id: "fr:dep:69",
  };
  const reason = (body: unknown, expect = want) => {
    const r = validateBody(body, expect);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(reason(k({})), "ok");
  assert.equal(reason(k({ v: 2 })), "version");
  assert.equal(reason(["not", "an", "object"]), "version");
  assert.equal(reason(k({ build: "o20250101-1" })), "skew");
  assert.equal(reason(k({}), { ...want, id: "fr:dep:01" }), "shape"); // a mis-routed file
  assert.equal(reason(k({}), { ...want, kind: "u" }), "shape");
  assert.equal(reason(k({ self: self("fr:dep:01") })), "shape");
  assert.equal(reason(k({ units: undefined })), "shape");
  assert.equal(reason(k({ self: { ...self("fr:dep:69"), bbox: [1, 2, 3] } })), "shape");
  assert.equal(
    reason(k({ self: { ...self("fr:dep:69"), g: { type: "Point", coordinates: [] } } })),
    "shape",
  );
  assert.equal(reason(k({ units: [{ ...entry("fr:com:1", "city"), level: "lieu" }] })), "shape");
  assert.equal(reason(k({ units: [{ ...entry("fr:com:1", "city"), k: 2 }] })), "shape");
  assert.equal(reason(k({ self: { ...self("fr:dep:69"), n: -1 } })), "shape");

  assert.equal(reason(LYON(), { build: BUILD, kind: "k", id: "fr:com:69123" }), "ok");
  assert.equal(reason(PARIS(), { build: BUILD, kind: "u", id: "fr:dep:75" }), "ok");
  const root = { build: BUILD, kind: "root" as const };
  assert.ok(validateBody(ROOT(), root).ok);
  assert.equal(
    (validateBody({ ...ROOT(), kind: "k" }, root) as { reason: string }).reason,
    "shape",
  );
  const badRow = { ...ROOT(), units: [{ ...ROOT().units[0], g: undefined }] };
  assert.equal((validateBody(badRow, root) as { reason: string }).reason, "shape");

  assert.deepEqual(
    (["missing", "network", "html", "version", "skew", "shape"] as const).filter(isReleaseSkew),
    ["html", "version", "skew"],
  );
});

test("rows: root rows are authoritative, an entry only adds a row for an id without one", () => {
  const s = new OutlineStore();
  s.putRoot(ROOT());
  assert.deepEqual(s.rowOf("fr:reg:84")?.bounds, {
    minLat: 44.11549,
    maxLat: 46.80429,
    minLng: 2.06288,
    maxLng: 7.18556,
  });
  s.put(kFile("FR", "fr1000", [entry("fr:reg:84", "region"), entry("fr:com:99999", "city")]), raw);
  assert.equal(s.rowOf("fr:reg:84")?.st, "e50");
  assert.equal(s.rowOf("fr:reg:84")?.fromRoot, true);
  assert.deepEqual(s.rowOf("fr:com:99999"), {
    id: "fr:com:99999",
    parent: "FR",
    level: "city",
    name: "fr:com:99999",
    bounds: { minLat: 2, maxLat: 4, minLng: 1, maxLng: 3 },
    center: [3, 2],
    st: "fr1000",
    k: 1,
    u: 0,
    g: 0,
    wrap: false,
    fromRoot: false,
  });
});

test("identity: one object per id@tier, the entry IS the self below the région", () => {
  const s = new OutlineStore();
  s.putRoot(ROOT());
  s.put(kFile("FR", "fr1000", [entry("fr:reg:84", "region")]), raw);
  assert.ok(s.selfOf("FR"));
  assert.equal(s.entryOf("FR"), undefined);
  assert.equal(s.selfOf("fr:reg:84"), undefined); // its self is e50, its k/FR entry fr1000
  assert.ok(s.entryOf("fr:reg:84"));
  s.put(uFile("fr:reg:84", "e50"), raw);
  assert.ok(s.selfOf("fr:reg:84"));
  assert.notEqual(s.selfOf("fr:reg:84"), s.entryOf("fr:reg:84"));

  const dep = s.put(kFile("fr:reg:84", "e50", [entry("fr:dep:69", "dep")]), raw);
  assert.equal(dep.dedupeHits, 1); // the région's self, already in from u/fr_reg_84
  const first = s.entryOf("fr:dep:69");
  assert.equal(s.selfOf("fr:dep:69"), first);
  const bundle = kFile("fr:dep:69", "e50", [entry("fr:com:69123", "city", 160)]);
  assert.notEqual(bundle.self.g, first);
  assert.deepEqual(s.put(bundle, raw), { added: 1, dedupeHits: 1, conflicts: 0, evicted: 0 });
  assert.equal(s.selfOf("fr:dep:69"), first);
  assert.equal(s.entryOf("fr:dep:69"), first);

  const lyon = s.entryOf("fr:com:69123");
  assert.ok(lyon);
  assert.equal(s.put(LYON(), raw).dedupeHits, 1);
  assert.equal(s.selfOf("fr:com:69123"), lyon);
  assert.equal(s.rowOf("fr:com:69381")?.parent, "fr:com:69123");
  assert.ok(s.entryOf("fr:com:69381"));
  assert.deepEqual([s.stats().dedupeHits, s.stats().conflicts], [3, 0]);
});

test("unitsOf: a loaded bundle's entries by id, the stored objects, gone with the file", () => {
  const s = new OutlineStore({ capVertices: 20 });
  s.putRoot(ROOT());
  assert.equal(s.unitsOf("fr:reg:84"), undefined);
  s.put(uFile("fr:dep:69", "e50"), raw); // its self, from another file first
  s.put(kFile("fr:reg:84", "e50", [entry("fr:dep:01", "dep"), entry("fr:dep:69", "dep")]), raw);
  const units = s.unitsOf("fr:reg:84");
  assert.deepEqual([...(units?.keys() ?? [])], ["fr:dep:01", "fr:dep:69"]);
  assert.equal(units?.get("fr:dep:69"), s.selfOf("fr:dep:69")); // the object already stored
  assert.equal(s.unitsOf("fr:dep:69"), undefined); // a u/ file has no entries
  s.put(kFile("fr:reg:11", "e50", [entry("fr:dep:75", "dep", 30)]), raw); // evicts the older files
  assert.equal(s.unitsOf("fr:reg:84"), undefined);
  assert.ok(s.unitsOf("fr:reg:11")?.get("fr:dep:75"));
});

test("writes: one version bump per call that changed something, atomic", () => {
  const s = new OutlineStore();
  s.putRoot(ROOT());
  const v0 = s.version;
  s.put(PARIS(), raw);
  assert.equal(s.version, v0 + 1);
  assert.deepEqual(s.put(PARIS(), raw), { added: 0, dedupeHits: 0, conflicts: 0, evicted: 0 });
  assert.equal(s.version, v0 + 1);

  const three = [uFile("fr:reg:11", "e50"), uFile("fr:reg:84", "e50"), uFile("fr:dep:69", "e50")];
  assert.equal(s.putMany(three, raw).added, 3);
  assert.equal(s.version, v0 + 2);

  const other = kFile("fr:reg:84", "e50", [], 6); // its self differs by one vertex
  const kept = s.selfOf("fr:reg:84");
  assert.equal(s.put(other, raw).conflicts, 1);
  assert.equal(s.selfOf("fr:reg:84"), kept);
  assert.equal(s.stats().conflicts, 1);

  const before = { ...s.stats(), version: s.version };
  const broken = { ...uFile("fr:dep:01", "e50"), self: { ...self("fr:dep:01"), bbox: [1] } };
  assert.throws(() => s.putMany([uFile("fr:dep:03", "e50"), broken as OutlineFileV1], raw));
  assert.deepEqual({ ...s.stats(), version: s.version }, before);
  assert.equal(s.loaded("u", "fr:dep:03"), false);
});

test("wrap sees every stored geometry exactly once", () => {
  const seen: object[] = [];
  const wrap = <T extends object>(o: T): T => (seen.push(o), o);
  const s = new OutlineStore();
  s.putRoot(ROOT());
  s.put(kFile("fr:dep:69", "e50", [entry("fr:com:69123", "city", 160)]), wrap);
  s.put(LYON(), wrap); // its self is the entry already wrapped
  s.put(LYON(), wrap);
  assert.equal(seen.length, s.stats().objects);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 2 + 9);
});

test("LRU: whole files out, pinned files and the call's own files kept", () => {
  const s = new OutlineStore({ capVertices: 100 });
  s.putRoot(ROOT());
  s.put(PARIS(), raw); // 143 vertices: above the cap, but its own call never evicts it
  assert.ok(s.has("fr:dep:75", "e50"));
  const paris = s.selfOf("fr:dep:75");
  const r = s.put(LYON(), raw);
  assert.equal(r.evicted, 1);
  assert.equal(s.has("fr:dep:75", "e50"), false);
  assert.equal(s.loaded("u", "fr:dep:75"), false);
  assert.ok(s.loaded("k", "fr:com:69123"));
  s.put(PARIS(), raw); // a refetch: new objects
  assert.ok(s.selfOf("fr:dep:75"));
  assert.notEqual(s.selfOf("fr:dep:75"), paris);
  assert.equal(s.loaded("k", "fr:com:69123"), false);

  // Pinned files above the cap: all kept, nothing thrown.
  assert.equal(s.pin(["fr:dep:75"]), 143);
  s.put(LYON(), raw);
  assert.ok(s.loaded("u", "fr:dep:75") && s.loaded("k", "fr:com:69123"));
  assert.ok(s.stats().vertices > 100);
  s.pin([]);
  s.put(uFile("fr:dep:69", "e50", 10), raw);
  assert.equal(s.loaded("u", "fr:dep:75") || s.loaded("k", "fr:com:69123"), false);
  assert.ok(s.loaded("u", "fr:dep:69"));
  assert.equal(s.stats().evicted, 4);
});

test("LRU: an object held by two files survives the eviction of one", () => {
  const s = new OutlineStore({ capVertices: 100 });
  s.put(kFile("fr:reg:84", "e50", [entry("fr:dep:69", "dep", 30)], 40), raw);
  s.put(kFile("fr:dep:69", "e50", [entry("fr:com:69123", "city", 20)], 30), raw);
  const dep = s.selfOf("fr:dep:69") ?? s.entryOf("fr:dep:69");
  assert.equal(s.stats().vertices, 90);
  s.put(uFile("fr:dep:01", "e50", 50), raw);
  assert.equal(s.loaded("k", "fr:reg:84"), false);
  assert.equal(s.has("fr:reg:84", "e50"), false);
  assert.equal(s.entryOf("fr:dep:69"), dep);
  assert.equal(s.stats().vertices, 100);
});

test("globeOf: a country's g/ object, apart from its self; pinned with it", () => {
  const s = new OutlineStore({ capVertices: 100 });
  const g = (id: string, n: number) => ({ ...uFile(id, "w3000", n), kind: "g" as const });
  s.putRoot({
    ...ROOT(),
    units: [
      {
        id: "ES",
        parent: null,
        level: "country",
        name: "España",
        bbox: [-18, 27, 4, 44],
        center: [40, -3],
        st: "c300",
        k: 0,
        u: 1,
        g: 1,
      },
    ],
  });
  assert.equal(s.globeOf("ES"), undefined);
  s.put(g("ES", 60), raw);
  const globe = s.globeOf("ES");
  assert.ok(globe && s.loaded("g", "ES"));
  assert.equal(s.selfOf("ES"), undefined); // its self is the u/ file's (c300)
  s.put(uFile("ES", "c300", 30), raw);
  assert.ok(s.selfOf("ES") && s.selfOf("ES") !== globe);
  assert.equal(s.globeOf("ES"), globe);
  // Pinned by its id, the g/ file stays past the cap.
  s.pin(["ES"]);
  s.put(uFile("fr:dep:69", "e50", 50), raw);
  assert.ok(s.loaded("g", "ES") && s.loaded("u", "ES"));
  s.pin([]);
  s.put(uFile("fr:dep:75", "e50", 50), raw);
  assert.equal(s.loaded("g", "ES"), false);
  assert.equal(s.globeOf("ES"), undefined);
});

test("an overseas région's files are its département's; its row and k/FR entry stay its own", () => {
  const s = new OutlineStore();
  const root = ROOT();
  const row = (id: string, parent: string, level: "region" | "dep", name: string) => ({
    ...root.units.find((r) => r.id === "fr:dep:69")!,
    id,
    parent,
    level,
    name,
  });
  root.units.push(
    row("fr:reg:03", "FR", "region", "Guyane"),
    row("fr:dep:973", "fr:reg:03", "dep", "Guyane"),
  );
  s.putRoot(root);
  assert.equal(s.filesIdOf("fr:reg:03"), "fr:dep:973");
  // Île-de-France over Paris alone (another name), ARA, a département, a country.
  for (const id of ["fr:reg:11", "fr:reg:84", "fr:dep:973", "fr:dep:75", "FR"])
    assert.equal(s.filesIdOf(id), id, id);
  s.put(kFile("FR", "fr1000", [entry("fr:reg:03", "region")]), raw);
  const fromFR = s.entryOf("fr:reg:03");
  assert.ok(fromFR);
  assert.equal(s.unitsOf("fr:reg:03"), undefined);
  assert.equal(s.bundleLoaded("fr:reg:03"), false);
  s.put(kFile("fr:dep:973", "e50", [entry("fr:com:97302", "city")]), raw);
  assert.ok(s.bundleLoaded("fr:reg:03"));
  assert.deepEqual([...(s.unitsOf("fr:reg:03")?.keys() ?? [])], ["fr:com:97302"]);
  assert.equal(s.selfOf("fr:reg:03"), s.selfOf("fr:dep:973"));
  assert.ok(s.selfOf("fr:reg:03"));
  assert.equal(s.rowOf("fr:reg:03")?.level, "region");
  assert.equal(s.rowOf("fr:reg:03")?.name, "Guyane");
  assert.equal(s.entryOf("fr:reg:03"), fromFR);
  // Pinned: its entry's file and its département's.
  s.pin(["fr:reg:03"]);
  s.put(kFile("fr:reg:84", "e50", [entry("fr:dep:69", "dep", 500_000)]), raw);
  assert.ok(s.loaded("k", "FR") && s.loaded("k", "fr:dep:973"));
});

test("file names and URLs", () => {
  assert.equal(keyOf("fr:com:69123"), "fr_com_69123");
  assert.equal(keyOf("FR"), "FR");
  assert.equal(fileKey("u", "fr:dep:2A"), "u/fr_dep_2A");
  assert.equal(
    fileUrl("https://x.test/map-data/", BUILD, "k", "fr:dep:69"),
    `https://x.test/map-data/outlines/${BUILD}/k/fr_dep_69.json`,
  );
  assert.equal(rootUrl("/map-data/", BUILD), `/map-data/outlines/${BUILD}/root.json`);
});
