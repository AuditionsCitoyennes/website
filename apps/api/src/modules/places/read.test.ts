import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { FakeDb, fakeEnv, fakeToken, installFakes, type Row } from "../../testing/fakes";

// The place reads over HTTP, against a PostgREST whose read RPCs are stubs:
// what each route sends the RPC, the per-unit cache and its batches, ETags
// and 304s, the error mapping, the visitors' limits, the service role; and
// the whole-table guards. SEARCH_MIN_CHARS=3 here, and the testing tools on
// (budget, /api/health?details=1).

const cacheDir = await mkdtemp(join(tmpdir(), "ac-place-reads-"));
fakeEnv(cacheDir, { TEST_TOOLS: "true", SEARCH_MIN_CHARS: "3" });
const db = new FakeDb();
const restore = installFakes({ db });

// A fetch that fails as an aborted one does, for the RPCs named here.
const abortRpcs = new Set<string>();
const fakeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const rpc = /\/rpc\/(.+)$/.exec(url.pathname)?.[1];
  if (rpc && abortRpcs.has(rpc)) {
    throw new DOMException("This operation was aborted", "AbortError");
  }
  return fakeFetch(input, init);
}) as typeof fetch;

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000bb";
const NOBODY = "00000000-0000-4000-8000-0000000000cc";
const AUDITION = "00000000-0000-4000-8000-000000000001";
const LIEU = "l:0123456789abcdef";

/** What the stubs were called with, per RPC. */
let calls: Record<string, Row[]> = {};
/** Bumped to change what the stubs answer. */
let version = 1;

function stub(name: string, answer: (args: Row) => unknown) {
  db.rpcs[name] = (args) => {
    (calls[name] ??= []).push(args);
    return answer(args);
  };
}

const countsOf = (unit: string, args: Row) => ({
  unit,
  complete: false,
  self: { n: version, auditions: 1, rank: "2025-01-01", bbox: null },
  units: [],
  lieux: [],
  echo: {
    filters: args.p_filters,
    depth: args.p_depth,
    facts: args.p_facts,
    budget: args.p_budget,
    empty: args.p_empty,
  },
});

stub("place_counts_many", (a) => (a.p_units as string[]).map((u) => countsOf(u, a)));
stub("lieu_auditions", (a) => ({
  lieu: { id: a.p_lieu, unit: "fr:com:69029" },
  auditions: [{ id: AUDITION, n: version }],
  echo: a,
}));
stub("audition_results", (a) => ({ auditions: [], next: null, echo: a }));
stub("testimony_page", (a) => ({ testimonies: [], next: null, echo: a }));
stub("place_facets", () => ({ themes: [{ i: 0, n: version }], dates: null }));
stub("admin_audition_filter", (a) => ({ matches: {}, themes: [], echo: a }));

db.users = {
  [SUPER]: { email: "root@example.test" },
  [ADMIN]: { email: "admin@example.test" },
  [NOBODY]: { email: "someone@example.test" },
};
db.tables.user_roles = [
  { user_id: SUPER, role: "super_admin" },
  { user_id: ADMIN, role: "admin" },
];

let app: FastifyInstance;
let invalidatePublicCaches: () => void;
before(async () => {
  const { buildServer } = await import("../../server");
  ({ invalidatePublicCaches } = await import("../../lib/publicCache"));
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  globalThis.fetch = fakeFetch;
  restore();
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Each test is its own visitor: the miss limits are per address.
let visitor = 0;
beforeEach(() => {
  visitor++;
  calls = {};
  version = 1;
  db.requests = [];
  db.refuse = () => null;
  db.countOf = () => undefined;
  abortRpcs.clear();
  invalidatePublicCaches();
});

const get = (url: string, headers: Record<string, string> = {}, ip = `10.0.${visitor}.1`) =>
  app.inject({ url, headers, remoteAddress: ip });

test("unit=: the RPC's answer as is, cached per unit; ETag, 304, X-Cache, Server-Timing", async () => {
  const first = await get("/api/places?unit=world&facts=1");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers["x-cache"], "miss");
  assert.match(
    String(first.headers["server-timing"]),
    /^cache;desc=miss, gate;dur=[\d.]+, db;dur=[\d.]+$/,
  );
  assert.equal(first.headers["cache-control"], "no-cache");
  const body = first.json();
  assert.equal(body.unit, "world");
  assert.deepEqual(body.echo, { filters: {}, depth: 2, facts: true, budget: 600, empty: false });
  assert.deepEqual(
    calls.place_counts_many.map((c) => c.p_units),
    [["world"]],
  );

  const again = await get("/api/places?unit=world&facts=1");
  assert.equal(again.headers["x-cache"], "hit");
  assert.equal(again.body, first.body);
  assert.equal(again.headers.etag, first.headers.etag);
  assert.equal(calls.place_counts_many.length, 1, "served from the cache");

  const revalidated = await get("/api/places?unit=world&facts=1", {
    "if-none-match": String(first.headers.etag),
  });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, "");

  // Another depth is another entry.
  await get("/api/places?unit=world&facts=1&depth=3");
  assert.equal(calls.place_counts_many.length, 2);
  // Only the service role calls the read RPCs.
  const rpcs = db.requests.filter((r) => r.url.pathname.includes("/rpc/"));
  assert.ok(rpcs.length > 0 && rpcs.every((r) => r.apikey === "service"));
});

test("units=: misses fetched 20 units a call, hits not again, results in the order asked", async () => {
  const units = Array.from({ length: 25 }, (_, i) => `fr:com:${69001 + i}`);
  const res = await get(`/api/places?units=${units.join(",")}`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["x-cache"], "miss");
  assert.deepEqual(
    calls.place_counts_many.map((c) => (c.p_units as string[]).length),
    [20, 5],
  );
  assert.deepEqual(
    res.json().results.map((r: { unit: string }) => r.unit),
    units,
  );

  // Some cached, some not: only the new ones are fetched; a duplicate once.
  const mixed = ["fr:com:69003", "fr:dep:69", "FR", "fr:com:69003", "fr:com:69010"];
  const second = await get(`/api/places?units=${mixed.join(",")}`);
  assert.equal(second.headers["x-cache"], "miss");
  assert.deepEqual(calls.place_counts_many[2].p_units, ["fr:dep:69", "FR"]);
  assert.deepEqual(
    second.json().results.map((r: { unit: string }) => r.unit),
    mixed,
  );
  const third = await get(`/api/places?units=${mixed.join(",")}`);
  assert.equal(third.headers["x-cache"], "hit");
  assert.equal(calls.place_counts_many.length, 3);
});

test("a units= answer is the per-unit answers; its ETag follows them", async () => {
  const units = ["world", "FR", "fr:reg:84", "fr:dep:69"];
  const batch = await get(`/api/places?units=${units.join(",")}&facts=1&v=1`);
  assert.equal(batch.statusCode, 200);
  const results = batch.json().results;
  for (const [i, unit] of units.entries()) {
    const one = await get(`/api/places?unit=${encodeURIComponent(unit)}&facts=1&v=1`);
    assert.equal(one.headers["x-cache"], "hit", "the batch cached each unit");
    assert.deepEqual(one.json(), results[i]);
  }
  const again = await get(`/api/places?units=${units.join(",")}&facts=1&v=1`);
  assert.equal(again.headers.etag, batch.headers.etag, "stable");
  assert.equal(again.body, batch.body);
  assert.notEqual(
    again.headers.etag,
    (await get(`/api/places?unit=world&facts=1&v=1`)).headers.etag,
  );
  const reordered = await get(`/api/places?units=${[...units].reverse().join(",")}&facts=1&v=1`);
  assert.notEqual(reordered.headers.etag, batch.headers.etag, "another order, another body");

  // A write: every unit read again, and the tag moves with the bytes.
  invalidatePublicCaches();
  version = 2;
  const moved = await get(`/api/places?units=${units.join(",")}&facts=1&v=1`);
  assert.notEqual(moved.headers.etag, batch.headers.etag);
  assert.equal(moved.json().results[0].self.n, 2);
});

test("filters: sent as the RPCs take them; one cache entry however they are spelled", async () => {
  const a = await get(
    "/api/places?unit=FR&v=1&t=11,0&q=%20%C3%89cologie%20&from=2025-01-01&u=fr:dep:69,FR",
  );
  assert.equal(a.statusCode, 200, a.body);
  assert.deepEqual(a.json().echo.filters, {
    verified: true,
    mask: (1 << 0) | (1 << 11),
    like: "%ecologie%",
    from: "2025-01-01",
    units: ["FR", "fr:dep:69"],
  });
  const b = await get("/api/places?u=FR,fr:dep:69&from=2025-01-01&q=ecologie&t=0,11&v=1&unit=FR");
  assert.equal(b.headers["x-cache"], "hit");
  assert.equal(calls.place_counts_many.length, 1);

  const lieu = await get(`/api/places/lieu?id=${LIEU}&sort=ancien&l=${LIEU}&q=100%25_x`);
  assert.equal(lieu.statusCode, 200, lieu.body);
  assert.deepEqual(lieu.json().echo, {
    p_lieu: LIEU,
    p_sort: "ancien",
    p_filters: { like: "%100\\%\\_x%", lieux: [LIEU] },
  });
});

test("a text below SEARCH_MIN_CHARS: not applied, said so, the unfiltered entry shared", async () => {
  await get("/api/places?unit=world");
  const short = await get("/api/places?unit=world&q=%C3%A9t");
  assert.equal(short.statusCode, 200);
  assert.equal(short.headers["x-cache"], "hit");
  const body = short.json();
  assert.equal(body.textIgnored, true);
  assert.deepEqual(body.echo.filters, {});
  assert.equal(calls.place_counts_many.length, 1);
  const plain = await get("/api/places?unit=world");
  assert.notEqual(short.headers.etag, plain.headers.etag);
  assert.equal(plain.json().textIgnored, undefined);

  const batch = await get("/api/places?units=world,FR&q=ab");
  assert.equal(batch.json().textIgnored, true);
  assert.equal(batch.json().results.length, 2);

  const results = await get("/api/places/results?q=ab");
  assert.equal(results.json().textIgnored, true);
  const applied = await get("/api/places/results?q=abc");
  assert.equal(applied.json().textIgnored, undefined);
  assert.equal(applied.json().echo.p_filters.like, "%abc%");
});

test("refused before any call: bad parameters", async () => {
  const bad: [string, RegExp][] = [
    ["/api/places", /unit/],
    ["/api/places?unit=world&units=FR", /unit/],
    ["/api/places?unit=lyon", /Unité invalide/],
    [`/api/places?units=${Array.from({ length: 51 }, () => "FR").join(",")}`, /De 1 à 50/],
    ["/api/places?unit=world&depth=4", /Profondeur/],
    ["/api/places?unit=world&empty=1&v=1", /empty=1/],
    ["/api/places?unit=world&budget=2001", /Budget/],
    ["/api/places?unit=world&t=16", /Thème/],
    ["/api/places/lieu", /Lieu requis/],
    ["/api/places/lieu?id=l:nope", /Lieu invalide/],
    ["/api/places/results?limit=101", /Limite/],
    ["/api/places/results?sort=old", /Tri/],
    ["/api/places/results?after=2025-01-01,2025-01-01,l:0123456789abcdef", /Curseur/],
    [
      `/api/places/results?after=2025-01-01,2025-01-01,${LIEU},${AUDITION}&through=${AUDITION}`,
      /exclusifs/,
    ],
    [`/api/auditions/${AUDITION}/testimonies?after=yesterday,${AUDITION}`, /Curseur/],
  ];
  for (const [url, message] of bad) {
    const res = await get(url);
    assert.equal(res.statusCode, 400, url);
    assert.match(res.json().message, message, url);
  }
  assert.equal(db.requests.length, 0);
  assert.equal((await get("/api/auditions/not-a-uuid/testimonies")).statusCode, 404);
});

test("empty=1 and budget (testing tools) reach the RPC", async () => {
  const res = await get("/api/places?unit=world&empty=1&budget=0&depth=1");
  assert.deepEqual(res.json().echo, {
    filters: {},
    depth: 1,
    facts: false,
    budget: 0,
    empty: true,
  });
});

test("57014: 503, nothing cached; 22023: 400; an aborted call: 503", async () => {
  db.refuse = (_m, url) =>
    url.pathname.endsWith("/rpc/place_counts_many")
      ? { status: 500, code: "57014", message: "canceling statement due to statement timeout" }
      : url.pathname.endsWith("/rpc/audition_results")
        ? { status: 400, code: "22023", message: "audition_results: limit must be 1..100" }
        : null;
  const slow = await get("/api/places?unit=world&q=climat");
  assert.equal(slow.statusCode, 503);
  assert.equal(slow.json().message, "Recherche trop large : précisez-la.");
  assert.equal(slow.headers["cache-control"], "no-store");
  assert.equal(slow.headers["x-cache"], "miss");
  const refused = await get("/api/places/results");
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().message, "Paramètres invalides.");
  assert.ok(!refused.body.includes("limit must be"), "the database's words stay in the log");

  db.refuse = () => null;
  const ok = await get("/api/places?unit=world&q=climat");
  assert.equal(ok.statusCode, 200, "the 503 was not cached");

  abortRpcs.add("lieu_auditions");
  const aborted = await get(`/api/places/lieu?id=${LIEU}`);
  assert.equal(aborted.statusCode, 503);
  assert.equal(aborted.json().message, "Recherche trop large : précisez-la.");
  abortRpcs.clear();
  assert.equal((await get(`/api/places/lieu?id=${LIEU}`)).statusCode, 200);
});

test("a visitor's misses: 30 RPC calls per 10 s, 20 with a text; then 429 with Retry-After", async () => {
  const units = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `fr:com:${from + i}`).join(",");
  // 20 calls of a text, in one request of 50 units (3 calls) and 17 single ones.
  assert.equal((await get(`/api/places?units=${units(10000, 50)}&q=abc`)).statusCode, 200);
  for (let i = 0; i < 17; i++) {
    assert.equal((await get(`/api/places?unit=fr:com:${20000 + i}&q=abc`)).statusCode, 200);
  }
  const search = await get(`/api/places?unit=fr:com:30000&q=abc`);
  assert.equal(search.statusCode, 429);
  assert.ok(Number(search.headers["retry-after"]) >= 1);
  assert.equal(search.json().message, "Trop de requêtes. Réessayez dans un instant.");
  // A hit costs nothing.
  assert.equal((await get(`/api/places?unit=fr:com:20000&q=abc`)).statusCode, 200);
  // Without a text: 10 more misses, then none.
  for (let i = 0; i < 10; i++) {
    assert.equal((await get(`/api/places?unit=fr:com:${40000 + i}`)).statusCode, 200);
  }
  const misses = await get("/api/places/facets");
  assert.equal(misses.statusCode, 429);
  const before = calls.place_counts_many.length;
  // A batch past the limit fetches nothing at all.
  assert.equal((await get(`/api/places?units=${units(50000, 30)}`)).statusCode, 429);
  assert.equal(calls.place_counts_many.length, before);
  // Another visitor is not concerned.
  assert.equal((await get("/api/places/facets", {}, "10.200.0.1")).statusCode, 200);
});

test("lieu, results, facets, testimonies: first pages cached, later ones read through", async () => {
  const lieu = `/api/places/lieu?id=${LIEU}`;
  await get(lieu);
  assert.equal((await get(lieu)).headers["x-cache"], "hit");
  assert.equal(calls.lieu_auditions.length, 1);
  assert.equal((await get(`${lieu}&sort=ancien`)).headers["x-cache"], "miss");

  const first = await get("/api/places/results?sort=ancien&limit=20&v=1");
  assert.deepEqual(first.json().echo, {
    p_filters: { verified: true },
    p_sort: "ancien",
    p_limit: 20,
  });
  assert.equal(
    (await get("/api/places/results?v=1&limit=20&sort=ancien")).headers["x-cache"],
    "hit",
  );
  const after = `/api/places/results?after=2025-05-01,2025-05-02,${LIEU},${AUDITION}`;
  await get(after);
  const page2 = await get(after);
  assert.equal(page2.headers["x-cache"], "miss");
  assert.deepEqual(page2.json().echo.p_after, ["2025-05-01", "2025-05-02", LIEU, AUDITION]);
  const through = await get(`/api/places/results?through=${AUDITION}`);
  assert.equal(through.json().echo.p_through, AUDITION);
  assert.equal(calls.audition_results.length, 4);

  await get("/api/places/facets");
  const facets = await get("/api/places/facets");
  assert.equal(facets.headers["x-cache"], "hit");
  assert.deepEqual(facets.json(), { themes: [{ i: 0, n: 1 }], dates: null });

  const tp = `/api/auditions/${AUDITION}/testimonies?v=1&q=abc&from=2025-01-01&l=${LIEU}`;
  const t1 = await get(tp);
  assert.equal(t1.statusCode, 200, t1.body);
  // Content filters only: the place and date filters chose the audition.
  assert.deepEqual(t1.json().echo, {
    p_audition: AUDITION,
    p_filters: { verified: true, like: "%abc%" },
    p_limit: 50,
  });
  assert.equal(
    (await get(`/api/auditions/${AUDITION}/testimonies?q=abc&v=1`)).headers["x-cache"],
    "hit",
  );
  const t2 = await get(`/api/auditions/${AUDITION}/testimonies?after=,${AUDITION}&limit=10`);
  assert.deepEqual(t2.json().echo.p_after, [null, AUDITION]);
  const t3 = await get(
    `/api/auditions/${AUDITION}/testimonies?after=${encodeURIComponent("2026-05-01T10:00:00.123+00:00")},${AUDITION}`,
  );
  assert.deepEqual(t3.json().echo.p_after, ["2026-05-01T10:00:00.123+00:00", AUDITION]);
});

test("the admin filter: admins only, reachable auditions by role, never cached", async () => {
  const url = "/api/auditions/admin/filter?v=1&t=3&q=a";
  assert.equal((await get(url)).statusCode, 401);
  const as = (user: string) => get(url, { authorization: `Bearer ${fakeToken(user)}` });
  assert.equal((await as(NOBODY)).statusCode, 403);
  const admin = await as(ADMIN);
  assert.equal(admin.statusCode, 200, admin.body);
  assert.equal(admin.headers["cache-control"], "no-store");
  assert.deepEqual(admin.json().echo, {
    p_filters: { verified: true, mask: 8, like: "%a%" },
    p_reachable_by: ADMIN,
  });
  const root = await as(SUPER);
  assert.deepEqual(root.json().echo, { p_filters: { verified: true, mask: 8, like: "%a%" } });
  await as(SUPER);
  assert.equal(calls.admin_audition_filter.length, 3, "not cached");
  // Dates and places are the list's own business: not taken here.
  const extra = await get("/api/auditions/admin/filter?u=FR", {
    authorization: `Bearer ${fakeToken(SUPER)}`,
  });
  assert.deepEqual(extra.json().echo.p_filters, {});
});

test("a write invalidates every place family", async () => {
  await get("/api/places?unit=world");
  await get(`/api/places/lieu?id=${LIEU}`);
  await get("/api/places/results");
  await get("/api/places/facets");
  await get(`/api/auditions/${AUDITION}/testimonies`);
  invalidatePublicCaches();
  for (const url of [
    "/api/places?unit=world",
    `/api/places/lieu?id=${LIEU}`,
    "/api/places/results",
    "/api/places/facets",
    `/api/auditions/${AUDITION}/testimonies`,
  ]) {
    assert.equal((await get(url)).headers["x-cache"], "miss", url);
  }
});

// ---- The whole-table guards ----------------------------------------------------

const published = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(100000000000 + i)}`,
    title: `A${i}`,
    date: "2025-01-01",
    location: "Lyon",
    status: "published",
    audition_en_ligne: false,
  }));

test("/api/testimonies: 503 past 25,000, counted with the service role; nothing cached", async () => {
  db.tables.testimonies = [];
  db.countOf = (table) => (table === "testimonies" ? 25_001 : undefined);
  const refused = await get("/api/testimonies");
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.json().message, "Liste trop longue : utilisez /api/places.");
  const counts = db.requests.filter((r) => r.method === "HEAD");
  assert.equal(counts.length, 1);
  assert.equal(counts[0].url.pathname, "/rest/v1/testimonies");
  assert.equal(counts[0].apikey, "service", "never as anon");
  assert.ok(
    !db.requests.some((r) => r.method === "GET" && r.url.pathname === "/rest/v1/testimonies"),
    "the corpus was not read",
  );

  db.countOf = (table) => (table === "testimonies" ? 25_000 : undefined);
  const served = await get("/api/testimonies");
  assert.equal(served.statusCode, 200, "at the threshold: served (refusal not cached)");

  invalidatePublicCaches();
  db.countOf = () => undefined;
  db.refuse = (method, url) =>
    method === "HEAD" && url.pathname === "/rest/v1/testimonies"
      ? { status: 500, code: "57014", message: "canceling statement due to statement timeout" }
      : null;
  const failed = await get("/api/testimonies");
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().message, "Réessayez dans un instant.");
});

test("/api/auditions and /api/map: 503 past 5,000 published auditions", async () => {
  db.tables.auditions = published(3);
  db.tables.audition_testimony_counts = [];
  db.countOf = (table, url) =>
    table === "auditions" && url.searchParams.get("status") === "eq.published" ? 5001 : undefined;
  for (const url of ["/api/auditions", "/api/map"]) {
    const res = await get(url);
    assert.equal(res.statusCode, 503, url);
    assert.equal(res.json().message, "Liste trop longue : utilisez /api/places.");
  }
  const counts = db.requests.filter((r) => r.method === "HEAD");
  assert.ok(counts.length >= 2 && counts.every((r) => r.apikey === "service"));

  db.countOf = () => undefined;
  const list = await get("/api/auditions");
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 3);
  assert.equal((await get("/api/map")).statusCode, 200);
  db.tables.auditions = [];
});

test("/api/health?details=1 (testing tools): the memory budget", async () => {
  const plain = await get("/api/health");
  assert.equal(plain.json().details, undefined);
  const res = await get("/api/health?details=1");
  const { details } = res.json();
  assert.ok(details.memoryMb.rss > 0);
  assert.deepEqual(
    details.families.map((f: { name: string }) => f.name),
    ["places", "lieu", "results", "tpage", "audition", "legacy"],
  );
  assert.equal(details.budgetMb.familiesMax, 60 + 16);
  assert.deepEqual(
    details.lrus.map((l: { name: string; maxMb: number }) => [l.name, l.maxMb]),
    [["boundaries", 32]],
  );
  assert.deepEqual(details.dbGate, { active: 0, held: 0, waiting: 0 });
});
