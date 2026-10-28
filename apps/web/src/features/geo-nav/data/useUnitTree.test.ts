// The server's tree store (map phase 1, design E2) against a fake API: a
// filter key swaps in once it knows the scope's chain — also a key still held
// from before —, what failed is asked for again when wanted again, a key let
// go stops asking, and a dropped key's answers leave the query cache. Run
// with `node --import tsx --test` (root "test:scripts"): the store's two app
// imports are mapped here (the API client to a stub: no Supabase, no fetch).

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
    return next(specifier, context);
  },
});
const g = globalThis as unknown as { window: unknown; __TEST_TOOLS__: boolean };
g.window = globalThis;
g.__TEST_TOOLS__ = false;

const { useUnitTree } = await import("./useUnitTree");
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

/** The fake API: answers, or the failure `fail` gives for a request. */
function fakeApi() {
  const calls: Call[] = [];
  let fail: ((c: Call) => Error | null) | null = null;
  const fetch = async (units: readonly string[], req: CountsRequest, signal?: AbortSignal) => {
    const call = { key: req.key, units: [...units] };
    calls.push(call);
    await new Promise((r) => setTimeout(r, 5));
    if (signal?.aborted) throw new DOMException("abandoned", "AbortError");
    const err = fail?.(call);
    if (err) throw err;
    return { answers: units.map((u) => answerFor(u, req.key)), ignored: null };
  };
  return {
    calls,
    fetch,
    failWith(f: ((c: Call) => Error | null) | null) {
      fail = f;
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
