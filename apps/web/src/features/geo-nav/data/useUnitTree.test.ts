// The server's tree store (map phase 1, design E2) against a fake API: a
// filter key swaps in once it knows the scope's chain — also a key still held
// from before —, what failed is asked for again when wanted again, a key let
// go stops asking, a dropped key's answers leave the query cache, and an
// audition created (reloadPlaces) is read whatever state the last reload is
// in; the place picker's tree read as it is opened, on the lazy path. Run
// with `node --import tsx --test` (root "test:scripts"): the store's two app
// imports are mapped here (the API client to a stub: no Supabase, no fetch),
// and the filters' barrel to the picker's tree alone.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import type { PlaceCounts, PlaceLieuRow, PlaceUnitRow } from "@ac/shared";

const SRC = new URL("../../../", import.meta.url);
const CLIENT_STUB = `data:text/javascript,${encodeURIComponent(`
export class ApiError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export const api = { get: () => Promise.reject(new Error("no network in the tests")) };
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/shared/api/client") {
      return { url: CLIENT_STUB, format: "module", shortCircuit: true };
    }
    if (specifier === "@/features/geo") {
      return next(new URL("features/geo/index.ts", SRC).href, context);
    }
    if (specifier === "@/features/filters") {
      return next(new URL("features/filters/placeTree.ts", SRC).href, context);
    }
    return next(specifier, context);
  },
});
const g = globalThis as unknown as { window: unknown; __TEST_TOOLS__: boolean };
g.window = globalThis;
g.__TEST_TOOLS__ = false;

const { useUnitTree } = await import("./useUnitTree");
const { reloadPlaces } = await import("../keys");
const { buildTreeFromUnits } = await import("@/features/geo");
const { buildPlaceTree } = await import("@/features/filters");
const { ApiError } = (await import("@/shared/api/client")) as unknown as {
  ApiError: new (m: string, status: number, retryAfter?: number | null) => Error;
};
type CountsRequest = import("./placesApi").CountsRequest;

// ---- A small France and a fake /api/places over it ------------------------------

const UNITS: Record<string, { parent: string | null; level: string; name: string }> = {
  FR: { parent: null, level: "country", name: "France" },
  "fr:reg:84": { parent: "FR", level: "region", name: "Auvergne-Rhône-Alpes" },
  "fr:dep:69": { parent: "fr:reg:84", level: "county", name: "Rhône" },
  "fr:com:69123": { parent: "fr:dep:69", level: "locality", name: "Lyon" },
  "fr:com:69387": { parent: "fr:com:69123", level: "locality", name: "Lyon 7e" },
  "fr:com:69266": { parent: "fr:dep:69", level: "locality", name: "Villeurbanne" },
};
const LIEUX: Record<string, { unit: string; key: string }> = {
  "l:0000000000000001": { unit: "fr:com:69387", key: "Place Jean Macé" },
  "l:0000000000000002": { unit: "fr:com:69266", key: "Marché des Gratte-Ciel" },
};
const parentOf = (id: string) => (id === "world" ? null : (UNITS[id]?.parent ?? "world"));
function pathOf(id: string): string[] {
  const out: string[] = [];
  for (let u: string | null = id; u; u = parentOf(u)) out.unshift(u);
  return out;
}

/** Per filter key: the lieux that match, and whether a world answer is whole. */
const KEYS: Record<string, { lieux: string[]; complete: boolean }> = {
  "": { lieux: Object.keys(LIEUX), complete: false },
  empty: { lieux: Object.keys(LIEUX), complete: false },
  ll: { lieux: ["l:0000000000000002"], complete: true },
  whole: { lieux: Object.keys(LIEUX), complete: true },
  qmace: { lieux: ["l:0000000000000001"], complete: false },
};
const keyOf = (k: string) => KEYS[k] ?? { lieux: Object.keys(LIEUX), complete: false };

function answerFor(unit: string, fkey: string): PlaceCounts {
  const { lieux, complete } = keyOf(fkey);
  const under = (u: string, l: string) => pathOf(LIEUX[l].unit).includes(u);
  const n = (u: string) => lieux.filter((l) => under(u, l)).length;
  const depthBelow = (id: string) => pathOf(id).length - pathOf(unit).length;
  const units: PlaceUnitRow[] = Object.keys(UNITS)
    .filter((id) => pathOf(id).includes(unit) && id !== unit && n(id) > 0)
    .filter((id) => complete || depthBelow(id) <= 2)
    .map((id) => ({
      id,
      parent: UNITS[id].parent,
      level: UNITS[id].level,
      name: UNITS[id].name,
      code: null,
      country: "FR",
      polygon: true,
      d: depthBelow(id),
      n: n(id),
      auditions: n(id),
      rank: "2026-10-01",
      tie: "t",
      bbox: [45, 4, 46, 5],
      wrap: false,
    }));
  const lieuRows = lieux
    .filter((l) => under(unit, l))
    .filter((l) => complete || depthBelow(LIEUX[l].unit) <= 1)
    .map((l): PlaceLieuRow => ({
      id: l,
      unit: LIEUX[l].unit,
      key: LIEUX[l].key,
      city: null,
      lat: 45.7,
      lng: 4.8,
      precision: "address",
      n: 1,
      auditions: 1,
      rank: "2026-10-01",
      tie: "t",
    }));
  return {
    unit,
    self: { n: n(unit) || lieux.length, auditions: 1, rank: "2026-10-01", bbox: [45, 4, 46, 5] },
    complete,
    units,
    lieux: lieuRows,
  } as PlaceCounts;
}

interface Call {
  key: string;
  units: readonly string[];
}

/** The fake API: answers as the data stood when asked (after `delay` ms), or
 *  the failure `fail` gives for a request. */
function fakeApi() {
  const calls: Call[] = [];
  let fail: ((c: Call) => Error | null) | null = null;
  let delay = 5;
  const fetch = async (units: readonly string[], req: CountsRequest, signal?: AbortSignal) => {
    const call = { key: req.key, units: [...units] };
    calls.push(call);
    const answers = units.map((u) => answerFor(u, req.key));
    await new Promise((r) => setTimeout(r, delay));
    if (signal?.aborted) throw new DOMException("abandoned", "AbortError");
    const err = fail?.(call);
    if (err) throw err;
    return { answers, ignored: null };
  };
  return {
    calls,
    fetch,
    failWith(f: ((c: Call) => Error | null) | null) {
      fail = f;
    },
    slow(ms: number) {
      delay = ms;
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FR = { id: "FR", ancestors: ["world"] };
const VILLEURBANNE = {
  id: "fr:com:69266",
  ancestors: ["world", "FR", "fr:reg:84", "fr:dep:69"],
};

function store(fake: ReturnType<typeof fakeApi>) {
  const queryClient = new QueryClient();
  const tree = useUnitTree({ queryClient, fetch: fake.fetch });
  return { tree, queryClient };
}

test("back to a key still held, its world loaded but not the scope's chain: it asks for the chain and swaps in", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  assert.equal(tree.shownKey(), "");
  tree.request({ key: "ll", params: { l: "l:0000000000000002" } });
  await wait(80);
  assert.equal(tree.shownKey(), "ll");
  assert.equal(tree.complete(), true);
  tree.setScope(VILLEURBANNE);
  await wait(80);
  const before = fake.calls.length;
  tree.request({ key: "", params: {} });
  await wait(120);
  assert.equal(tree.shownKey(), "", "the unfiltered tree is back");
  assert.equal(tree.wantedKey(), "");
  const asked = fake.calls.slice(before);
  assert.equal(asked.length, 1, "one request");
  assert.deepEqual([...asked[0].units].sort(), ["fr:com:69266", "fr:dep:69", "fr:reg:84"]);
});

test("a key that failed is asked for again when picked again", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  fake.failWith((c) => (c.key === "m256" ? new ApiError("boom", 500) : null));
  tree.request({ key: "m256", params: { t: "8" } });
  await wait(80);
  assert.equal(tree.failed(), true, "the error line");
  tree.request({ key: "m64", params: { t: "6" } });
  await wait(80);
  assert.equal(tree.shownKey(), "m64");
  fake.failWith(null);
  const before = fake.calls.length;
  tree.request({ key: "m256", params: { t: "8" } });
  assert.equal(tree.failed(), false, "no error line at once");
  await wait(120);
  assert.ok(
    fake.calls.slice(before).some((c) => c.key === "m256"),
    "asked again",
  );
  assert.equal(tree.shownKey(), "m256");
});

test("the place picker's tree is asked for again when wanted again after failing", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  fake.failWith((c) => (c.key === "empty" ? new ApiError("down", 500) : null));
  tree.wantEmpty();
  await wait(80);
  assert.equal(tree.emptyData(), null);
  fake.failWith(null);
  tree.wantEmpty();
  await wait(120);
  assert.ok(tree.emptyData(), "the picker's tree is in");
});

test("a key let go while waiting to retry asks no more", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  fake.failWith((c) => (c.key === "m32" ? new ApiError("slow down", 429, 0.05) : null));
  tree.request({ key: "m32", params: { t: "5" } });
  await wait(40);
  assert.equal(fake.calls.filter((c) => c.key === "m32").length, 1);
  tree.request({ key: "m64", params: { t: "6" } });
  await wait(600);
  assert.equal(fake.calls.filter((c) => c.key === "m32").length, 1, "no retry once let go");
  assert.equal(tree.shownKey(), "m64");
});

test("a refused read is retried after Retry-After, then the tree swaps in", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  let refusals = 2;
  fake.failWith((c) =>
    c.key === "m64" && refusals-- > 0 ? new ApiError("slow down", 429, 0.05) : null,
  );
  tree.request({ key: "m64", params: { t: "6" } });
  await wait(900);
  assert.equal(fake.calls.filter((c) => c.key === "m64").length, 3);
  assert.equal(tree.shownKey(), "m64");
  assert.equal(tree.failed(), false);
});

test("a key dropped from the LRU leaves the query cache too", async () => {
  const fake = fakeApi();
  const { tree, queryClient } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  const keys = ["m1", "m2", "m4", "m8", "m16", "m32"];
  for (const key of keys) {
    tree.request({ key, params: { t: String(Math.log2(Number(key.slice(1)))) } });
    await wait(80);
  }
  const cached = new Set(
    queryClient
      .getQueryCache()
      .findAll({ queryKey: ["places"] })
      .map((q) => q.queryKey[1] as string),
  );
  assert.deepEqual([...cached].sort(), ["m16", "m32", "m4", "m8"]);
  assert.deepEqual(tree.stats().keys.sort(), ["m16", "m32", "m4", "m8"]);
});

test("the scope's own answer, refused once, is asked for again (its units' children with it)", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  // FR is loaded (the world's answer), its régions' children are not: asked deep.
  let refusals = 1;
  fake.failWith((c) =>
    c.units.includes("FR") && refusals-- > 0 ? new ApiError("busy", 503, 0.05) : null,
  );
  tree.ensure(["FR"], true);
  await wait(500);
  const asked = fake.calls.filter((c) => c.units.includes("FR"));
  assert.equal(asked.length, 2, "asked again after the refusal");
  assert.equal(
    tree.stats().loaded,
    tree.stats().units - 1,
    "its régions loaded (only Lyon 7e not)",
  );
});

test("a key that failed, left for the tree on screen, is asked for again when typed again", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(FR);
  fake.failWith((c) => (c.key === "qmarche" ? new ApiError("slow down", 429, 0.01) : null));
  tree.request({ key: "qmarche", params: { q: "marché" } });
  // Tried 4 times, 250 ms apart.
  await wait(1100);
  assert.equal(tree.failed(), true, "the error line");
  // The text cleared: back to the tree on screen; then typed again.
  tree.request({ key: "", params: {} });
  assert.equal(tree.failed(), false);
  fake.failWith(null);
  const before = fake.calls.length;
  tree.request({ key: "qmarche", params: { q: "marché" } });
  await wait(120);
  assert.ok(
    fake.calls.slice(before).some((c) => c.key === "qmarche"),
    "asked again",
  );
  assert.equal(tree.shownKey(), "qmarche");
  assert.equal(tree.failed(), false);
});

// ---- An audition created (PR L) -------------------------------------------------

const NEW_LIEU = "l:0000000000000003";
/** An audition created at a new lieu in Villeurbanne: in the keys without
 *  filters ("whole": a world answer that is the whole tree, production's). */
function createAudition() {
  LIEUX[NEW_LIEU] = { unit: "fr:com:69266", key: "Parc de la Feyssine" };
  for (const k of ["", "whole"]) KEYS[k].lieux.push(NEW_LIEU);
}
function forgetAudition() {
  delete LIEUX[NEW_LIEU];
  for (const k of ["", "whole"]) KEYS[k].lieux = KEYS[k].lieux.filter((l) => l !== NEW_LIEU);
}
const holds = (tree: ReturnType<typeof useUnitTree>, id: string) => !!tree.data()?.lieux.has(id);

test("an audition created while the last reload is on its way is read by a second reload", async (t) => {
  t.after(forgetAudition);
  const fake = fakeApi();
  const { tree, queryClient } = store(fake);
  // The whole tree in one answer: a reload asks for the world alone, the
  // query its first reload is still reading.
  tree.request({ key: "whole", params: {} });
  await wait(80);
  tree.setScope(VILLEURBANNE);
  await wait(80);
  fake.slow(200);
  reloadPlaces(queryClient);
  await wait(150);
  assert.equal(tree.stats().refreshes, 1);
  assert.ok(tree.stats().inflight > 0, "the first reload on its way");
  // A second audition, written after the first reload's read.
  createAudition();
  reloadPlaces(queryClient);
  await wait(600);
  assert.equal(tree.stats().refreshes, 2, "reloaded again");
  assert.equal(tree.shownKey(), "whole");
  assert.equal(holds(tree, NEW_LIEU), true, "the second audition's lieu is on screen");
});

test("an audition created after a reload failed is read", async (t) => {
  t.after(forgetAudition);
  const fake = fakeApi();
  const { tree, queryClient } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(VILLEURBANNE);
  await wait(80);
  fake.failWith((c) => (c.key === "" ? new ApiError("boom", 500) : null));
  reloadPlaces(queryClient);
  await wait(200);
  assert.equal(tree.failed(), true, "the reload failed: the error line");
  fake.failWith(null);
  createAudition();
  reloadPlaces(queryClient);
  await wait(250);
  assert.equal(tree.stats().refreshes, 2);
  assert.equal(tree.failed(), false);
  assert.equal(holds(tree, NEW_LIEU), true);
});

test("a reload's answer read before the next audition, landing before the next reload, is not reused", async (t) => {
  t.after(forgetAudition);
  const fake = fakeApi();
  const { tree, queryClient } = store(fake);
  tree.request({ key: "", params: {} });
  await wait(80);
  tree.setScope(VILLEURBANNE);
  await wait(80);
  fake.slow(60);
  reloadPlaces(queryClient);
  await wait(130);
  // The first reload's world is on its way, read before this audition.
  createAudition();
  reloadPlaces(queryClient);
  await wait(50);
  assert.equal(tree.stats().refreshes, 1);
  assert.equal(holds(tree, NEW_LIEU), false, "the first reload's answer, from before");
  const before = fake.calls.length;
  await wait(300);
  assert.equal(tree.stats().refreshes, 2);
  assert.ok(fake.calls.length > before, "asked again, not served from the query cache");
  assert.equal(holds(tree, NEW_LIEU), true);
});

// ---- Lieux known from a list (PR K) ---------------------------------------------

const GRATTE_CIEL = {
  id: "l:0000000000000002",
  key: "Marché des Gratte-Ciel",
  unit: "fr:com:69266",
  path: ["FR", "fr:reg:84", "fr:dep:69", "fr:com:69266"],
  lat: 45.77,
  lng: 4.88,
  city: "Villeurbanne",
  n: 1,
};
const listed = (tree: ReturnType<typeof useUnitTree>, id: string) =>
  buildTreeFromUnits(tree.data()!).index.get(id);

test("a lieu a list holds goes into a lazy tree as a stub, never into a whole one", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.setScope(FR);
  tree.request({ key: "qa", params: { q: "a" } });
  await wait(80);
  assert.equal(tree.shownKey(), "qa");
  assert.equal(listed(tree, GRATTE_CIEL.id), undefined, "Villeurbanne's lieux not known yet");
  assert.equal(tree.addStub(GRATTE_CIEL), true);
  assert.equal(listed(tree, GRATTE_CIEL.id)?.parentId, "fr:dep:69", "under the deepest unit held");
  await wait(80);
  assert.equal(
    listed(tree, GRATTE_CIEL.id)?.parentId,
    "fr:com:69266",
    "its path asked: its own row",
  );

  tree.request({ key: "ll", params: { l: GRATTE_CIEL.id } });
  await wait(80);
  assert.equal(tree.shownKey(), "ll");
  assert.equal(tree.complete(), true);
  assert.equal(tree.addStub({ ...GRATTE_CIEL, id: "l:00000000000000ff" }), false, "whole: no stub");
});

test("the open lieu goes along into a key swapped in without it, until that key knows its unit", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.setScope(FR);
  tree.request({ key: "qa", params: { q: "a" } });
  await wait(80);
  tree.addStub(GRATTE_CIEL);
  tree.setCarry(() => GRATTE_CIEL.id);

  // A key that holds it: there at once (a stub), then as its own row.
  tree.request({ key: "", params: {} });
  for (let i = 0; i < 40 && tree.shownKey() !== ""; i++) await wait(2);
  assert.equal(tree.shownKey(), "");
  assert.ok(listed(tree, GRATTE_CIEL.id), "selected still: in the tree from the swap on");
  await wait(80);
  assert.equal(listed(tree, GRATTE_CIEL.id)?.parentId, "fr:com:69266");

  // A key it does not match: there until that key knows Villeurbanne's lieux.
  tree.request({ key: "qmace", params: { q: "mace" } });
  for (let i = 0; i < 40 && tree.shownKey() !== "qmace"; i++) await wait(2);
  assert.equal(tree.shownKey(), "qmace");
  assert.ok(listed(tree, GRATTE_CIEL.id), "carried over");
  await wait(80);
  assert.equal(listed(tree, GRATTE_CIEL.id), undefined, "its unit known without it: gone");

  // Nothing carried once let go.
  tree.setCarry(null);
  tree.request({ key: "qb", params: { q: "b" } });
  for (let i = 0; i < 40 && tree.shownKey() !== "qb"; i++) await wait(2);
  assert.equal(tree.data()!.stubs?.size ?? 0, 0);
});

// ---- The place picker's tree, read as it is opened (L2) -------------------------

type PickerNode = ReturnType<typeof buildPlaceTree>[number];
const picker = (tree: ReturnType<typeof useUnitTree>) =>
  buildPlaceTree(tree.emptyData()!, {
    arrondissements: false,
    statusOf: (id) => tree.emptyStatus(id),
  });
const shape = (nodes: PickerNode[]): unknown =>
  nodes.map((n) => [n.token, n.label, n.count, n.lazy ?? null, shape(n.children ?? [])]);

test("the place picker's tree read as it is opened: the units opened together go out as one empty=1 request, until it is the whole tree", async (t) => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.wantEmpty();
  await wait(80);
  assert.deepEqual(
    picker(tree).map((n) => [n.label, n.lazy]),
    [["Auvergne-Rhône-Alpes", "idle"]],
    "the world's answer: France's régions, their children not known",
  );

  let before = fake.calls.length;
  tree.loadEmpty(["fr:reg:84"]);
  assert.equal(picker(tree)[0].lazy, "loading");
  await wait(80);
  assert.deepEqual(fake.calls.slice(before), [{ key: "empty", units: ["fr:reg:84"] }]);
  const rhone = picker(tree)[0].children![0];
  assert.equal(rhone.label, "Rhône");
  assert.deepEqual(
    rhone.children!.map((c) => [c.label, c.lazy]),
    [
      ["Lyon", "idle"],
      ["Villeurbanne", "idle"],
    ],
  );

  before = fake.calls.length;
  tree.loadEmpty(["fr:com:69123"]);
  tree.loadEmpty(["fr:com:69266"]);
  await wait(80);
  assert.deepEqual(
    fake.calls.slice(before),
    [{ key: "empty", units: ["fr:com:69123", "fr:com:69266"] }],
    "one request",
  );

  // The same tree as a whole answer gives (production's), which asks for nothing.
  KEYS.empty.complete = true;
  t.after(() => {
    KEYS.empty.complete = false;
  });
  const wholeFake = fakeApi();
  const whole = store(wholeFake);
  whole.tree.wantEmpty();
  await wait(80);
  assert.deepEqual(shape(picker(tree)), shape(picker(whole.tree)));
  assert.equal(JSON.stringify(shape(picker(whole.tree))).includes("idle"), false);
  const asked = wholeFake.calls.length;
  whole.tree.loadEmpty(["fr:reg:84", "fr:com:69123"]);
  await wait(80);
  assert.equal(wholeFake.calls.length, asked, "a whole tree asks for nothing");
});

test("a place picker read refused is retried after Retry-After; failed after its retries, asked again when opened again", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  tree.wantEmpty();
  await wait(80);

  let refusals = 1;
  fake.failWith((c) =>
    c.units.includes("fr:reg:84") && refusals-- > 0 ? new ApiError("slow down", 429, 0.3) : null,
  );
  tree.loadEmpty(["fr:reg:84"]);
  await wait(120);
  assert.equal(tree.emptyStatus("fr:reg:84"), "loading", "waiting to be asked again");
  await wait(400);
  assert.equal(fake.calls.filter((c) => c.units.includes("fr:reg:84")).length, 2);
  assert.equal(picker(tree)[0].lazy, undefined, "its children in");

  fake.failWith((c) =>
    c.units.includes("fr:com:69123") ? new ApiError("slow down", 429, 0.01) : null,
  );
  tree.loadEmpty(["fr:com:69123"]);
  await wait(1400);
  assert.equal(fake.calls.filter((c) => c.units.includes("fr:com:69123")).length, 4);
  const lyon = () => picker(tree)[0].children![0].children![0];
  assert.equal(lyon().lazy, "failed");
  fake.failWith(null);
  tree.loadEmpty(["fr:com:69123"]);
  assert.equal(lyon().lazy, "loading");
  await wait(80);
  assert.equal(lyon().lazy, undefined);
  assert.deepEqual(
    lyon().children!.map((c) => c.label),
    ["Place Jean Macé"],
  );
});

test("an audition created on the lazy path: the places opened in the picker come back with its reload, in the world's request, the tree before read meanwhile", async (t) => {
  // The new audition's lieu, in Villeurbanne, matches the picker's key too.
  t.after(() => {
    forgetAudition();
    KEYS.empty.lieux = KEYS.empty.lieux.filter((l) => l !== NEW_LIEU);
  });
  const fake = fakeApi();
  const { tree, queryClient } = store(fake);
  tree.request({ key: "", params: {} });
  tree.wantEmpty();
  await wait(80);
  tree.loadEmpty(["fr:reg:84"]);
  await wait(80);
  tree.loadEmpty(["fr:com:69123", "fr:com:69266"]);
  await wait(80);
  const before = tree.emptyData();
  const deep = shape(picker(tree));
  assert.equal(JSON.stringify(deep).includes("idle"), false, "opened down to the lieux");

  createAudition();
  KEYS.empty.lieux.push(NEW_LIEU);
  fake.slow(60);
  const n = fake.calls.length;
  reloadPlaces(queryClient);
  await wait(140);
  assert.equal(tree.emptyData(), before, "the tree before, while its reload is on its way");
  assert.deepEqual(shape(picker(tree)), deep);
  await wait(150);
  assert.deepEqual(
    fake.calls.slice(n).filter((c) => c.key === "empty"),
    [{ key: "empty", units: ["world", "fr:reg:84", "fr:com:69123", "fr:com:69266"] }],
    "one request",
  );
  assert.notEqual(tree.emptyData(), before, "its reload in place");
  const villeurbanne = picker(tree)[0].children![0].children!.find(
    (c) => c.token === "fr:com:69266",
  )!;
  assert.deepEqual(
    villeurbanne.children!.map((c) => c.label),
    ["Marché des Gratte-Ciel", "Parc de la Feyssine"],
    "as deep as before, the new audition's lieu in it",
  );
  assert.equal(JSON.stringify(shape(picker(tree))).includes("idle"), false);
});

test("an audition created with a whole place picker tree (production's): its reload asks for the world alone", async (t) => {
  KEYS.empty.complete = true;
  t.after(() => {
    KEYS.empty.complete = false;
  });
  const fake = fakeApi();
  const { tree, queryClient } = store(fake);
  tree.request({ key: "", params: {} });
  tree.wantEmpty();
  await wait(80);
  tree.loadEmpty(["fr:reg:84", "fr:com:69123"]);
  await wait(80);
  const n = fake.calls.length;
  reloadPlaces(queryClient);
  await wait(250);
  assert.deepEqual(
    fake.calls.slice(n).filter((c) => c.key === "empty"),
    [{ key: "empty", units: ["world"] }],
  );
});

test("the filter dialog closed: a place picker read refused is not retried, the world's is; opened again, it is asked again", async () => {
  const fake = fakeApi();
  const { tree } = store(fake);
  const reads = (id: string) => fake.calls.filter((c) => c.units.includes(id)).length;

  // The world refused once with the dialog closed: retried all the same (the
  // chips read it).
  let worldRefusals = 1;
  fake.failWith((c) =>
    c.units.includes("world") && worldRefusals-- > 0 ? new ApiError("slow down", 429, 0.2) : null,
  );
  tree.idleEmpty();
  tree.wantEmpty();
  await wait(400);
  assert.equal(reads("world"), 2);
  assert.ok(tree.emptyData(), "the world in");

  // Refused, waiting to be asked again when the dialog closes: let go.
  fake.failWith((c) =>
    c.units.includes("fr:reg:84") ? new ApiError("slow down", 429, 0.2) : null,
  );
  tree.loadEmpty(["fr:reg:84"]);
  await wait(80);
  assert.equal(tree.emptyStatus("fr:reg:84"), "loading", "waiting to be asked again");
  tree.idleEmpty();
  assert.equal(tree.emptyStatus("fr:reg:84"), null);
  assert.equal(picker(tree)[0].lazy, "idle");
  await wait(400);
  assert.equal(reads("fr:reg:84"), 1, "not asked again");

  // On its way when the dialog closes, then refused: not asked again either.
  tree.loadEmpty(["fr:reg:84"]);
  tree.idleEmpty();
  await wait(400);
  assert.equal(reads("fr:reg:84"), 2);
  assert.equal(tree.emptyStatus("fr:reg:84"), null);

  // Opened again: asked again, and retried.
  let refusals = 1;
  fake.failWith((c) =>
    c.units.includes("fr:reg:84") && refusals-- > 0 ? new ApiError("slow down", 429, 0.2) : null,
  );
  tree.loadEmpty(["fr:reg:84"]);
  await wait(400);
  assert.equal(reads("fr:reg:84"), 4);
  assert.equal(picker(tree)[0].lazy, undefined, "its children in");
});
