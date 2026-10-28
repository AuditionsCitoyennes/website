import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
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

// The read RPCs named here answer late, fail as a call aborted by its signal
// does (only when the API gave it one), or as a fetch that could not reach
// the server. Every RPC call and count records whether it carried an abort
// signal.
const abortRpcs = new Set<string>();
const unreachableRpcs = new Set<string>();
const slowRpcs = new Map<string, number>();
let signals: { path: string; method: string; signal: boolean }[] = [];
const fakeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  const rpc = /\/rpc\/(.+)$/.exec(url.pathname)?.[1];
  const signal = init?.signal instanceof AbortSignal;
  if (rpc || method === "HEAD") signals.push({ path: url.pathname, method, signal });
  const delay = rpc && slowRpcs.get(rpc);
  if (delay) await sleep(delay);
  if (rpc && abortRpcs.has(rpc) && signal) {
    throw new DOMException("This operation was aborted", "AbortError");
  }
  if (rpc && unreachableRpcs.has(rpc)) throw new TypeError("fetch failed");
  return fakeFetch(input, init);
}) as typeof fetch;

const SUPER = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000bb";
const NOBODY = "00000000-0000-4000-8000-0000000000cc";
const AUDITION = "00000000-0000-4000-8000-000000000001";
const LIEU = "l:0123456789abcdef";
// A results cursor's tie: the id of a lieu's newest audition (never the lieu's id).
const TIE = "00000000-0000-4000-8000-000000000002";

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
  unreachableRpcs.clear();
  slowRpcs.clear();
  signals = [];
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

  // Some cached, some not: only the new ones are fetched; a duplicate once,
  // and answered once.
  const mixed = ["fr:com:69003", "fr:dep:69", "FR", "fr:com:69003", "fr:com:69010"];
  const second = await get(`/api/places?units=${mixed.join(",")}`);
  assert.equal(second.headers["x-cache"], "miss");
  assert.deepEqual(calls.place_counts_many[2].p_units, ["fr:dep:69", "FR"]);
  assert.deepEqual(
    second.json().results.map((r: { unit: string }) => r.unit),
    ["fr:com:69003", "fr:dep:69", "FR", "fr:com:69010"],
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
  assert.equal(body.minChars, 3, "the minimum, for the web's hint");
  assert.deepEqual(body.echo.filters, {});
  assert.equal(calls.place_counts_many.length, 1);
  const plain = await get("/api/places?unit=world");
  assert.notEqual(short.headers.etag, plain.headers.etag);
  assert.equal(plain.json().textIgnored, undefined);

  const batch = await get("/api/places?units=world,FR&q=ab");
  assert.equal(batch.json().textIgnored, true);
  assert.equal(batch.json().minChars, 3);
  assert.equal(batch.json().results.length, 2);

  const results = await get("/api/places/results?q=ab");
  assert.equal(results.json().textIgnored, true);
  assert.equal(results.json().minChars, 3);
  // A later page, built for its reply alone, says so too.
  const later = await get(
    `/api/places/results?q=ab&after=2025-01-01,2025-01-01,${TIE},${AUDITION}`,
  );
  assert.equal(later.statusCode, 200, later.body);
  assert.equal(later.json().textIgnored, true);
  assert.equal(later.json().minChars, 3);
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
    // The tie is an audition's id: a lieu's id there is not a cursor of audition_results.
    [`/api/places/results?after=2025-01-01,2025-01-01,${LIEU},${AUDITION}`, /Curseur/],
    [`/api/places/results?after=2025-01-01,2025-01-01,${TIE},${LIEU}`, /Curseur/],
    [`/api/places/results?after=2025-01-01,2025-01,${TIE},${AUDITION}`, /Curseur/],
    [
      `/api/places/results?after=2025-01-01,2025-01-01,${TIE},${AUDITION}&through=${AUDITION}`,
      /exclusifs/,
    ],
    [`/api/auditions/${AUDITION}/testimonies?after=yesterday,${AUDITION}`, /Curseur/],
    // A parameter given twice comes as a list: refused in the visitor's words.
    ["/api/places?unit=FR&unit=FR", /^Paramètre unit invalide \(un seul attendu\)\.$/],
    ["/api/places?units=FR&units=BE", /^Paramètre units invalide/],
    ["/api/places?unit=FR&budget=1&budget=2", /^Paramètre budget invalide/],
    ["/api/places?unit=FR&q=a&q=b", /^Paramètre q invalide/],
    ["/api/places/results?limit=5&limit=6", /^Paramètre limit invalide/],
    ["/api/places/results?through=a&through=b", /^Paramètre through invalide/],
    ["/api/places/results?after=a&after=b", /^Paramètre after invalide/],
    [`/api/places/lieu?id=${LIEU}&id=${LIEU}`, /^Paramètre id invalide/],
    [`/api/auditions/${AUDITION}/testimonies?after=a&after=b`, /^Paramètre after invalide/],
    // A NUL Postgres cannot hold: refused here, not a 500 from the database.
    ["/api/places?unit=FR&q=a%00b", /^Texte invalide\.$/],
    ["/api/places/results?q=%00", /^Texte invalide\.$/],
    [`/api/places/lieu?id=${LIEU}&q=a%00`, /^Texte invalide\.$/],
    [`/api/auditions/${AUDITION}/testimonies?q=a%00b`, /^Texte invalide\.$/],
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

test("57014: 503, nothing cached; 22023: 400; an aborted call: 503, to try again", async () => {
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

  // The API's abort: the database is not answering, the search is not to blame.
  abortRpcs.add("lieu_auditions");
  const aborted = await get(`/api/places/lieu?id=${LIEU}`);
  assert.equal(aborted.statusCode, 503);
  assert.equal(aborted.json().message, "Réessayez dans un instant.");
  abortRpcs.clear();
  assert.equal((await get(`/api/places/lieu?id=${LIEU}`)).statusCode, 200);
});

test("a database out of reach: 503 to try again, a value still held served instead", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const first = await get("/api/places?unit=world");
  assert.equal(first.statusCode, 200);
  // Past the TTL and the stale window: a miss, and the database fails it.
  t.mock.timers.tick(6 * 60_000 + 1000);
  const outages: [string, () => void][] = [
    [
      "Kong's 502",
      () =>
        (db.refuse = (_m, url) =>
          url.pathname.includes("/rpc/")
            ? {
                status: 502,
                code: "",
                message: "An invalid response was received from the upstream server",
              }
            : null),
    ],
    [
      "PostgREST's pool",
      () =>
        (db.refuse = (_m, url) =>
          url.pathname.includes("/rpc/")
            ? { status: 504, code: "PGRST003", message: "Timed out acquiring connection" }
            : null),
    ],
    [
      "a pooler's prepared statements",
      () =>
        (db.refuse = (_m, url) =>
          url.pathname.includes("/rpc/")
            ? { status: 500, code: "42P05", message: 'prepared statement "6" already exists' }
            : null),
    ],
    [
      "a fetch that threw",
      () => {
        db.refuse = () => null;
        for (const rpc of ["place_counts_many", "place_facets"]) unreachableRpcs.add(rpc);
      },
    ],
  ];
  for (const [what, outage] of outages) {
    outage();
    const held = await get("/api/places?unit=world");
    assert.equal(held.statusCode, 200, `${what}: ${held.body}`);
    assert.equal(held.headers["x-cache"], "stale", what);
    assert.equal(held.body, first.body, what);
    // Nothing held: the error, never "Recherche trop large" (facets have no search).
    for (const url of ["/api/places?unit=FR", "/api/places/facets"]) {
      const res = await get(url);
      assert.equal(res.statusCode, 503, `${what}: ${url}`);
      assert.equal(res.json().message, "Réessayez dans un instant.", `${what}: ${url}`);
      assert.equal(res.headers["cache-control"], "no-store", `${what}: ${url}`);
      assert.equal(res.headers["retry-after"], "5", `${what}: ${url}`);
    }
  }
  db.refuse = () => null;
  unreachableRpcs.clear();
  assert.equal((await get("/api/places?unit=FR")).statusCode, 200, "nothing kept of it");
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

test("later pages are misses too: they count against the visitor's limit", async () => {
  const page = `/api/places/results?after=2025-05-01,2025-05-02,${TIE},${AUDITION}`;
  for (let i = 0; i < 30; i++) assert.equal((await get(page)).statusCode, 200, `page ${i}`);
  const refused = await get(page);
  assert.equal(refused.statusCode, 429);
  assert.ok(Number(refused.headers["retry-after"]) >= 1);
  const tpage = await get(`/api/auditions/${AUDITION}/testimonies?after=,${AUDITION}`);
  assert.equal(tpage.statusCode, 429);
  assert.equal(calls.audition_results.length, 30);
  assert.equal(calls.testimony_page, undefined);
});

test("a timeout: the value still held, as stale, for a while; then, or with nothing held, 503", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const first = await get("/api/places?unit=world");
  const lieu = await get(`/api/places/lieu?id=${LIEU}`);
  assert.equal(first.headers["x-cache"], "miss");
  // Past the TTL and the stale window (1 min + 5 min): a miss, read again.
  t.mock.timers.tick(6 * 60_000 + 1000);
  db.refuse = (_m, url) =>
    /\/rpc\/(place_counts_many|lieu_auditions)$/.test(url.pathname)
      ? { status: 500, code: "57014", message: "canceling statement due to statement timeout" }
      : null;
  const held = await get("/api/places?unit=world");
  assert.equal(held.statusCode, 200, held.body);
  assert.equal(held.headers["x-cache"], "stale");
  assert.equal(held.body, first.body);
  assert.equal(held.headers.etag, first.headers.etag);
  const heldBatch = await get("/api/places?units=world");
  assert.equal(heldBatch.statusCode, 200);
  assert.equal(heldBatch.headers["x-cache"], "stale");
  const heldLieu = await get(`/api/places/lieu?id=${LIEU}`);
  assert.equal(heldLieu.statusCode, 200);
  assert.equal(heldLieu.headers["x-cache"], "stale");
  assert.equal(heldLieu.body, lieu.body);
  // Nothing held for this unit: the error.
  assert.equal((await get("/api/places?unit=FR")).statusCode, 503);
  // Past the hold window (5 min more): the error, however long it was held.
  t.mock.timers.tick(5 * 60_000);
  const gone = await get("/api/places?unit=world");
  assert.equal(gone.statusCode, 503);
  assert.equal(gone.json().message, "Recherche trop large : précisez-la.");
});

test("a batch refused while it joins another visitor's fill that fails: 429, 503, nothing unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const greedy = "10.9.9.9";
    for (let i = 0; i < 30; i++) {
      assert.equal((await get(`/api/places?unit=fr:com:${60000 + i}`, {}, greedy)).statusCode, 200);
    }
    slowRpcs.set("place_counts_many", 100);
    db.refuse = (_m, url, body) =>
      url.pathname.endsWith("/rpc/place_counts_many") &&
      ((body as Row).p_units as string[]).includes("fr:com:99999")
        ? { status: 500, code: "57014", message: "canceling statement due to statement timeout" }
        : null;
    const a = get("/api/places?units=fr:com:99999");
    await sleep(30);
    const b = await get("/api/places?units=fr:com:99999,fr:com:88888", {}, greedy);
    assert.equal(b.statusCode, 429);
    assert.equal((await a).statusCode, 503);
    await sleep(50);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("every read RPC and every guard count carries an abort signal", async () => {
  await get("/api/places?units=world,FR");
  await get(`/api/places/lieu?id=${LIEU}`);
  await get("/api/places/results");
  await get(`/api/places/results?through=${AUDITION}`);
  await get("/api/places/facets");
  await get(`/api/auditions/${AUDITION}/testimonies`);
  await get("/api/auditions/admin/filter", { authorization: `Bearer ${fakeToken(SUPER)}` });
  db.tables.testimonies = [];
  db.tables.auditions = [];
  db.tables.audition_testimony_counts = [];
  await get("/api/testimonies");
  await get("/api/auditions");
  const rpcs = signals.filter((x) => x.path.includes("/rpc/"));
  const counts = signals.filter((x) => x.method === "HEAD");
  assert.equal(new Set(rpcs.map((x) => x.path)).size, 6, JSON.stringify(rpcs));
  assert.ok(counts.length >= 2);
  assert.deepEqual(
    [...rpcs, ...counts].filter((x) => !x.signal),
    [],
  );
});

test("an answer past the read limit: 400, not kept; a units= answer past its limit: 400", async () => {
  const { READ_ANSWER_MAX_BYTES } = await import("./read");
  const { BATCH_MAX_BYTES } = await import("./readRoutes");
  const heavy = (unit: string, bytes: number) => ({ unit, pad: "x".repeat(bytes) });
  stub("place_counts_many", (a) =>
    (a.p_units as string[]).map((u) =>
      u === "FR" ? heavy(u, READ_ANSWER_MAX_BYTES) : heavy(u, 1_500_000),
    ),
  );
  try {
    const big = await get("/api/places?unit=FR&depth=3");
    assert.equal(big.statusCode, 400);
    assert.equal(big.json().message, "Réponse trop volumineuse : précisez la demande.");
    assert.equal(big.headers["cache-control"], "no-store");
    await get("/api/places?unit=FR&depth=3");
    assert.equal(calls.place_counts_many.length, 2, "not kept");

    // Three units of 1.5 MB, each cached on its own: together past the batch's limit.
    const three = ["fr:reg:84", "fr:reg:11", "fr:reg:93"];
    for (const u of three) assert.equal((await get(`/api/places?unit=${u}`)).statusCode, 200);
    assert.ok(3 * 1_500_000 > BATCH_MAX_BYTES);
    const batch = await get(`/api/places?units=${three.join(",")}`);
    assert.equal(batch.statusCode, 400);
    assert.match(batch.json().message, /moins d'unités/);
    // The same unit fifty times is one unit: served.
    const same = await get(`/api/places?units=${Array(50).fill("fr:reg:84").join(",")}`);
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().results.length, 1);
  } finally {
    stub("place_counts_many", (a) => (a.p_units as string[]).map((u) => countsOf(u, a)));
  }
});

test("units=: the answer assembled once, kept under its parts' tags; hits and 304s build nothing", async () => {
  const { assembledCache } = await import("../../lib/publicCache");
  const units = ["world", "FR", "fr:reg:84"];
  for (const u of units) await get(`/api/places?unit=${encodeURIComponent(u)}`);
  const url = `/api/places?units=${units.join(",")}`;
  const fills = () => assembledCache.stats().fills;
  const before = fills();
  // Twenty at once, every unit cached: one assembly between them all.
  const all = await Promise.all(Array.from({ length: 20 }, () => get(url)));
  for (const res of all) {
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.body, all[0].body);
    assert.equal(res.headers.etag, all[0].headers.etag);
  }
  assert.equal(fills() - before, 1, "one assembly");
  assert.equal(calls.place_counts_many.length, 3, "no call: every unit was cached");
  // Then a hit: the kept bytes, as is.
  const again = await get(url);
  assert.equal(again.headers["x-cache"], "hit");
  assert.equal(again.body, all[0].body);
  const gz = await get(url, { "accept-encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.rawPayload).toString(), again.body);
  const held = await get(url, { "if-none-match": String(again.headers.etag) });
  assert.equal(held.statusCode, 304);
  assert.equal(fills() - before, 1, "a hit, a gzip, a 304: nothing built");

  // A unit that changes moves the batch's tag: a new assembly, never the old bytes.
  invalidatePublicCaches();
  version = 2;
  const moved = await get(url);
  assert.notEqual(moved.headers.etag, again.headers.etag);
  assert.equal(moved.json().results[0].self.n, 2);
  // An answer with textIgnored is kept the same way.
  await get("/api/places?unit=world&q=ab");
  const built = fills();
  const short = await get("/api/places?unit=world&q=ab");
  assert.equal(short.json().textIgnored, true);
  assert.equal(fills(), built, "kept");
});

test("units=: an assembly that reaches no database costs its visitor one call; a hit, none", async () => {
  // Another visitor's requests cached the units.
  for (const u of ["world", "FR"]) await get(`/api/places?unit=${u}`, {}, "10.250.0.1");
  // This one spends 29 of its 30 misses.
  for (let i = 0; i < 29; i++) {
    assert.equal((await get(`/api/places?unit=fr:com:${71000 + i}`)).statusCode, 200);
  }
  const built = await get("/api/places?units=world,FR");
  assert.equal(built.statusCode, 200, "the 30th: one assembly");
  const another = await get("/api/places?units=FR,world");
  assert.equal(another.statusCode, 429, "another order is another assembly");
  assert.equal(another.headers.etag, undefined);
  assert.equal(another.headers["cache-control"], "no-store");
  assert.equal((await get("/api/places?units=world,FR")).statusCode, 200, "a hit: free");
});

/** Three units whose answers weigh `bytes` each (with the stub's `n`), served by place_counts_many. */
function heavyUnits(bytes: number) {
  stub("place_counts_many", (a) =>
    (a.p_units as string[]).map((u) => ({ unit: u, n: version, pad: "x".repeat(bytes) })),
  );
  return ["fr:reg:84", "fr:reg:11", "fr:reg:52"];
}
const plainUnits = () =>
  stub("place_counts_many", (a) => (a.p_units as string[]).map((u) => countsOf(u, a)));

test("units=: a client holding the batch is told 304 before anything is assembled", async () => {
  const { assembledCache } = await import("../../lib/publicCache");
  const url = "/api/places?units=world,FR&q=ab";
  const first = await get(url);
  assert.equal(first.statusCode, 200);
  const etag = String(first.headers.etag);
  // A write drops everything; the units are read again, the same bytes: the
  // batch's tag is the same, and its bytes are nowhere.
  invalidatePublicCaches();
  for (const u of ["world", "FR"]) await get(`/api/places?unit=${u}`);
  const fills = assembledCache.stats().fills;
  const rpcs = calls.place_counts_many.length;
  const held = await get(url, { "if-none-match": etag });
  assert.equal(held.statusCode, 304);
  assert.equal(held.headers.etag, etag);
  assert.equal(held.body, "");
  assert.equal(assembledCache.stats().fills, fills, "nothing assembled for a 304");
  assert.equal(assembledCache.stats().entries, 0);
  assert.equal(calls.place_counts_many.length, rpcs, "nor read");
  // The same for one answer with textIgnored.
  const one = await get("/api/places?unit=world&q=ab");
  invalidatePublicCaches();
  await get("/api/places?unit=world");
  const before = assembledCache.stats().fills;
  const heldOne = await get("/api/places?unit=world&q=ab", {
    "if-none-match": String(one.headers.etag),
  });
  assert.equal(heldOne.statusCode, 304);
  assert.equal(assembledCache.stats().fills, before);
});

test("units=: four assemblies at a time, then a queue, then 503; the gate's refusal costs nothing", async () => {
  const { assemblyGate } = await import("./readRoutes");
  const { assembledCache } = await import("../../lib/publicCache");
  for (const u of ["world", "FR"]) await get(`/api/places?unit=${u}`, {}, "10.253.0.1");
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const running = Array.from({ length: 4 }, () => assemblyGate.run(() => blocker));
  let queued: Promise<unknown>[] = [];
  try {
    // Four assemblies under way (the blockers): a fifth waits for a slot.
    const waiting = get("/api/places?units=world,FR", {}, "10.253.0.2");
    const first = await Promise.race([
      waiting.then(() => "answered"),
      sleep(150).then(() => "waiting"),
    ]);
    assert.equal(first, "waiting", "no assembly past the four at once");
    assert.deepEqual(assemblyGate.stats(), { active: 4, held: 0, waiting: 1 });
    assert.equal(assembledCache.stats().entries, 0);
    // The queue full (50 waiting): another order is refused at once.
    queued = Array.from({ length: 49 }, () =>
      assemblyGate.run(() => blocker).catch(() => undefined),
    );
    const refused = await get("/api/places?units=FR,world", {}, "10.253.0.3");
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.json().message, "Réessayez dans un instant.");
    assert.equal(refused.headers["retry-after"], "1");
    assert.equal(refused.headers["cache-control"], "no-store");
    assert.equal(refused.headers.etag, undefined);
    release();
    assert.equal((await waiting).statusCode, 200, "built once a slot was free");
  } finally {
    release();
    await Promise.all([...running, ...queued]);
  }
  assert.equal(assembledCache.stats().entries, 1);
  // The visitor the gate refused paid nothing: its 30 misses are whole.
  for (let i = 0; i < 30; i++) {
    const res = await get(`/api/places?unit=fr:com:${74000 + i}`, {}, "10.253.0.3");
    assert.equal(res.statusCode, 200, `miss ${i}`);
  }
  assert.equal((await get("/api/places?unit=fr:com:74999", {}, "10.253.0.3")).statusCode, 429);
  // The one whose assembly ran paid one call for it.
  for (let i = 0; i < 29; i++) {
    const res = await get(`/api/places?unit=fr:com:${75000 + i}`, {}, "10.253.0.2");
    assert.equal(res.statusCode, 200, `miss ${i}`);
  }
  assert.equal((await get("/api/places?unit=fr:com:75999", {}, "10.253.0.2")).statusCode, 429);
});

test("units=: a batch of about 4 MB is kept; the next request sends it as built", async () => {
  const { assembledCache } = await import("../../lib/publicCache");
  const { BATCH_MAX_BYTES } = await import("./readRoutes");
  const three = heavyUnits(1_300_000);
  try {
    for (const u of three) assert.equal((await get(`/api/places?unit=${u}`)).statusCode, 200);
    const url = `/api/places?units=${three.join(",")}`;
    const fills = assembledCache.stats().fills;
    const first = await get(url);
    assert.equal(first.statusCode, 200, first.body.slice(0, 200));
    assert.ok(first.rawPayload.length > 3_900_000 && first.rawPayload.length < BATCH_MAX_BYTES);
    assert.equal(assembledCache.stats().fills, fills + 1);
    assert.ok(assembledCache.stats().bytes > first.rawPayload.length, "kept");
    const again = await get(url);
    assert.equal(again.statusCode, 200);
    assert.ok(again.rawPayload.equals(first.rawPayload));
    assert.equal(assembledCache.stats().fills, fills + 1, "not built again");
    assert.equal(calls.place_counts_many.length, 3);
  } finally {
    plainUnits();
  }
});

test("units=: assembled answers live apart — however many, they never evict a unit's answer", async () => {
  const { assembledCache, placesCache } = await import("../../lib/publicCache");
  // The oldest entry of the per-unit family, then three units of 1.3 MB.
  assert.equal((await get("/api/places?unit=world")).statusCode, 200);
  const three = heavyUnits(1_300_000);
  try {
    for (const u of three) assert.equal((await get(`/api/places?unit=${u}`)).statusCode, 200);
    const evictions = placesCache.stats().evictions;
    // Every order of the three: six batches of 3.9 MB, 23 MB in all.
    const [a, b, c] = three;
    const orders = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    for (const [i, order] of orders.entries()) {
      const res = await get(`/api/places?units=${order.join(",")}`, {}, `10.254.0.${i + 1}`);
      assert.equal(res.statusCode, 200, `order ${i}`);
    }
    const rpcs = calls.place_counts_many.length;
    for (const u of ["world", ...three]) {
      const res = await get(`/api/places?unit=${u}`);
      assert.equal(res.headers["x-cache"], "hit", `${u}: still kept`);
    }
    assert.equal(calls.place_counts_many.length, rpcs, "nothing read again");
    assert.equal(placesCache.stats().evictions, evictions, "never among the units' answers");
    assert.ok(assembledCache.stats().evictions > 0, "the batches made room among themselves");
  } finally {
    plainUnits();
  }
});

test("units=: a refill behind a stale reply that has to split is the cache's upkeep, never charged", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { READ_ANSWER_MAX_BYTES } = await import("./read");
  // Together past a call's limit, each alone under it: every call of the three splits.
  const three = heavyUnits(Math.floor(READ_ANSWER_MAX_BYTES * 0.4));
  try {
    const url = `/api/places?units=${three.join(",")}`;
    // Another visitor's request read them (1 call, split into 3) and kept their batch.
    assert.equal((await get(url, {}, "10.255.0.1")).statusCode, 200);
    assert.equal(calls.place_counts_many.length, 4);
    // Past the units' TTL (not the batch's): served stale, refilled behind the reply.
    t.mock.timers.tick(61_000);
    const stale = await get(url);
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.headers["x-cache"], "stale");
    for (let i = 0; i < 400 && calls.place_counts_many.length < 8; i++) await sleep(5);
    assert.equal(calls.place_counts_many.length, 8, "the refill split too: 1 + 3 calls");
  } finally {
    plainUnits();
  }
  // None of those calls was this visitor's: its 30 misses are whole.
  for (let i = 0; i < 30; i++) {
    assert.equal((await get(`/api/places?unit=fr:com:${76000 + i}`)).statusCode, 200, `miss ${i}`);
  }
  assert.equal((await get("/api/places?unit=fr:com:76999")).statusCode, 429);
});

test("units=: a call too heavy is made again unit by unit; the same answer cold or warm", async () => {
  const { READ_ANSWER_MAX_BYTES } = await import("./read");
  // Three of these pass a call's limit together; each alone does not.
  const pad = Math.floor(READ_ANSWER_MAX_BYTES * 0.4);
  stub("place_counts_many", (a) =>
    (a.p_units as string[]).map((u) => ({
      unit: u,
      pad: u === "fr:reg:93" ? "y".repeat(READ_ANSWER_MAX_BYTES) : "x".repeat(pad),
    })),
  );
  const units = () => calls.place_counts_many.map((c) => c.p_units);
  try {
    const three = "/api/places?units=fr:reg:84,fr:reg:11,fr:reg:52";
    const cold = await get(three);
    assert.equal(cold.statusCode, 200, cold.body);
    assert.deepEqual(units(), [
      ["fr:reg:84", "fr:reg:11", "fr:reg:52"],
      ["fr:reg:84"],
      ["fr:reg:11"],
      ["fr:reg:52"],
    ]);
    assert.deepEqual(
      cold.json().results.map((r: { unit: string }) => r.unit),
      ["fr:reg:84", "fr:reg:11", "fr:reg:52"],
    );
    const warm = await get(three);
    assert.equal(warm.statusCode, 200);
    assert.equal(warm.headers["x-cache"], "hit");
    assert.equal(warm.body, cold.body);
    assert.equal(warm.headers.etag, cold.headers.etag);

    // A unit too heavy on its own is refused, cold or warm; the one beside it is kept.
    calls = {};
    const mixed = "/api/places?units=fr:reg:93,fr:reg:76";
    for (let i = 0; i < 2; i++) {
      const res = await get(mixed);
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().message, "Réponse trop volumineuse : précisez la demande.");
      assert.equal(res.headers["cache-control"], "no-store");
    }
    assert.deepEqual(units(), [
      ["fr:reg:93", "fr:reg:76"],
      ["fr:reg:93"],
      ["fr:reg:76"],
      ["fr:reg:93"],
    ]);
    // (Its fill may still be gzipping: joined, then, but never fetched again.)
    assert.equal((await get("/api/places?unit=fr:reg:76")).statusCode, 200);
    assert.equal(units().length, 4, "kept from the split: not fetched again");
  } finally {
    stub("place_counts_many", (a) => (a.p_units as string[]).map((u) => countsOf(u, a)));
  }
  // The calls made again were the visitor's: 1 + 3, then 1 + 2, then 1 — 8 of its 30.
  for (let i = 0; i < 22; i++) {
    assert.equal((await get(`/api/places?unit=fr:com:${72000 + i}`)).statusCode, 200, `miss ${i}`);
  }
  assert.equal((await get("/api/places?unit=fr:com:72999")).statusCode, 429);
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
  const after = `/api/places/results?after=2025-05-01,2025-05-02,${TIE},${AUDITION}`;
  await get(after);
  const page2 = await get(after);
  assert.equal(page2.statusCode, 200, page2.body);
  assert.equal(page2.headers["x-cache"], "miss");
  assert.deepEqual(page2.json().echo.p_after, ["2025-05-01", "2025-05-02", TIE, AUDITION]);
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

// audition_results over these rows as its SQL pages them: (date dir, rank
// desc, tie, id), after p_after = [date, rank, tie, id], and `next` built as
// jsonb_build_array(date, rank, tie, id) of the last row shown — the tie a
// uuid (the id of the lieu's newest audition). Ties on every part of the key.
interface ResultRow {
  id: string;
  date: string;
  rank: string;
  tie: string;
  lieu: string;
}
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A row of lieu `lieu` (one hex digit), its rank and tie its newest audition's. */
const resultRow = (id: number, date: string, rank: string, tie: number, lieu: string) => ({
  id: uuid(id),
  date,
  rank,
  tie: uuid(tie),
  lieu: `l:${lieu.padStart(16, "0")}`,
});
const RESULT_ROWS: ResultRow[] = [
  // Lieu a: its newest audition 110 (2025-06-01), the tie of its rows.
  resultRow(110, "2025-06-01", "2025-06-01", 110, "a"),
  resultRow(111, "2025-03-01", "2025-06-01", 110, "a"),
  resultRow(112, "2025-03-01", "2025-06-01", 110, "a"),
  // Lieu b: the same rank as a, a greater tie.
  resultRow(120, "2025-06-01", "2025-06-01", 120, "b"),
  resultRow(121, "2025-03-01", "2025-06-01", 120, "b"),
  // Lieu c: an older rank.
  resultRow(130, "2025-03-01", "2025-04-01", 131, "c"),
  resultRow(131, "2025-04-01", "2025-04-01", 131, "c"),
];

function keysetResults(rows: ResultRow[]) {
  return (a: Row) => {
    const dir = a.p_sort === "ancien" ? 1 : -1;
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    const order = (p: Omit<ResultRow, "lieu">, q: Omit<ResultRow, "lieu">) =>
      dir * cmp(p.date, q.date) || -cmp(p.rank, q.rank) || cmp(p.tie, q.tie) || cmp(p.id, q.id);
    const after = a.p_after as string[] | undefined;
    const key = after && { date: after[0], rank: after[1], tie: after[2], id: after[3] };
    const rest = [...rows].sort(order).filter((r) => !key || order(r, key) > 0);
    const shown = rest.slice(0, a.p_limit as number);
    const last = shown.at(-1);
    return {
      auditions: shown.map((r) => ({
        id: r.id,
        title: `A ${r.id.slice(-3)}`,
        date: r.date,
        n: 1,
        lieu: { id: r.lieu, key: r.lieu, unit: "FR", path: ["FR"], lat: 45, lng: 4, city: null },
      })),
      next: rest.length > shown.length && last ? [last.date, last.rank, last.tie, last.id] : null,
      ...(!key && { total: { auditions: rows.length, lieux: 3, n: rows.length }, frame: null }),
    };
  };
}

test("results: each page's next, sent back as after, brings the page after it — to the last", async () => {
  stub("audition_results", keysetResults(RESULT_ROWS));
  try {
    for (const sort of ["recent", "ancien"]) {
      const all = (await get(`/api/places/results?sort=${sort}&limit=100`)).json();
      assert.equal(all.next, null);
      assert.equal(all.auditions.length, RESULT_ROWS.length);
      if (sort === "recent") {
        // The SQL's order: date desc, rank desc, tie, id.
        assert.deepEqual(
          all.auditions.map((r: { id: string }) => r.id),
          [110, 120, 131, 111, 112, 121, 130].map(uuid),
        );
      }
      const seen: string[] = [];
      let page = (await get(`/api/places/results?sort=${sort}&limit=2`)).json();
      let pages = 1;
      for (;;) {
        seen.push(...page.auditions.map((r: { id: string }) => r.id));
        if (page.next === null) break;
        // As a client sends it: the cursor as the RPC gave it, comma-separated.
        const q = new URLSearchParams({ sort, limit: "2", after: page.next.join(",") });
        const res = await get(`/api/places/results?${q}`);
        assert.equal(res.statusCode, 200, `${sort}, page ${pages + 1}: ${res.body}`);
        assert.deepEqual(calls.audition_results.at(-1)!.p_after, page.next, "sent on as is");
        page = res.json();
        pages++;
      }
      assert.equal(pages, 4, sort);
      assert.deepEqual(
        seen,
        all.auditions.map((r: { id: string }) => r.id),
        `${sort}: every row once, in the list's order`,
      );
    }
  } finally {
    stub("audition_results", (a) => ({ auditions: [], next: null, echo: a }));
  }
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
  const nul = await get("/api/auditions/admin/filter?q=a%00", {
    authorization: `Bearer ${fakeToken(SUPER)}`,
  });
  assert.equal(nul.statusCode, 400);
  assert.equal(nul.json().message, "Texte invalide.");
  assert.equal(calls.admin_audition_filter.length, 4);
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

const heads = () => db.requests.filter((r) => r.method === "HEAD").length;
const publishedOver = (n: number) => (table: string, url: URL) =>
  table === "auditions" && url.searchParams.get("status") === "eq.published" ? n : undefined;

test("/api/testimonies: 503 past 10,000, counted with the service role, once per TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  db.tables.testimonies = [];
  db.countOf = (table) => (table === "testimonies" ? 10_001 : undefined);
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

  // Remembered for the TTL: refused again without a count per request.
  db.countOf = (table) => (table === "testimonies" ? 10_000 : undefined);
  for (let i = 0; i < 3; i++) assert.equal((await get("/api/testimonies")).statusCode, 503);
  assert.equal(heads(), 1, "no count while the refusal stands");
  // Its TTL over: counted again, and at the threshold, served.
  t.mock.timers.tick(61_000);
  assert.equal((await get("/api/testimonies")).statusCode, 200, "at the threshold: served");
  assert.equal(heads(), 2);

  // A write ends a refusal at once (a deletion may have brought the table under).
  invalidatePublicCaches();
  db.countOf = (table) => (table === "testimonies" ? 10_001 : undefined);
  assert.equal((await get("/api/testimonies")).statusCode, 503);
  invalidatePublicCaches();
  db.countOf = () => undefined;
  assert.equal((await get("/api/testimonies")).statusCode, 200, "counted again after the write");

  // A count that fails is not remembered: the next request counts again.
  invalidatePublicCaches();
  db.refuse = (method, url) =>
    method === "HEAD" && url.pathname === "/rest/v1/testimonies"
      ? { status: 500, code: "57014", message: "canceling statement due to statement timeout" }
      : null;
  const failed = await get("/api/testimonies");
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().message, "Réessayez dans un instant.");
  const before = heads();
  assert.equal((await get("/api/testimonies")).statusCode, 503);
  assert.equal(heads(), before + 1);
});

test("/api/testimonies heavier than the legacy family keeps: 503, pulled once, not per request", async () => {
  // Under the count's threshold, over the 16 MB an entry may weigh.
  const text = "x".repeat(900_000);
  db.tables.testimonies = Array.from({ length: 20 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(200000000000 + i)}`,
    person_name: "A",
    content: text,
    verification_status: "verified",
    created_at: "2025-01-01T00:00:00.000Z",
  }));
  try {
    const pulls = () =>
      db.requests.filter((r) => r.method === "GET" && r.url.pathname === "/rest/v1/testimonies")
        .length;
    const refused = await get("/api/testimonies");
    assert.equal(refused.statusCode, 503, "refused, not served uncached");
    assert.equal(refused.json().message, "Liste trop longue : utilisez /api/places.");
    const pulled = pulls();
    assert.ok(pulled >= 1);
    const again = await get("/api/testimonies");
    assert.equal(again.statusCode, 503);
    assert.equal(pulls(), pulled, "the refusal remembered: not pulled again");
    assert.equal(heads(), 1, "nor counted again");
    const { legacyCache } = await import("../../lib/publicCache");
    assert.equal(legacyCache.stats().bytes, 0, "nothing kept of it");
    assert.ok(legacyCache.stats().oversize >= 1);
  } finally {
    db.tables.testimonies = [];
  }
});

test("/api/auditions and /api/map: 503 past 5,000 published auditions, one count per TTL", async () => {
  db.tables.auditions = published(3);
  db.tables.audition_testimony_counts = [];
  db.countOf = publishedOver(5001);
  for (const url of ["/api/auditions", "/api/map", "/api/auditions", "/api/map"]) {
    const res = await get(url);
    assert.equal(res.statusCode, 503, url);
    assert.equal(res.json().message, "Liste trop longue : utilisez /api/places.");
  }
  const counts = db.requests.filter((r) => r.method === "HEAD");
  assert.equal(counts.length, 1, "the map reads the list's refusal; neither counts again");
  assert.equal(counts[0].apikey, "service");

  // A write: counted again; at the threshold, served.
  invalidatePublicCaches();
  db.countOf = publishedOver(5000);
  for (const url of ["/api/auditions", "/api/map"]) {
    assert.equal((await get(url)).statusCode, 200, `${url} at the threshold: served`);
  }
  invalidatePublicCaches();
  db.countOf = () => undefined;
  const list = await get("/api/auditions");
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 3);
  assert.equal((await get("/api/map")).statusCode, 200);
  db.tables.auditions = [];
});

test("/api/auditions: the value held is not served past a refill the guard refuses", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  db.tables.auditions = published(3);
  db.tables.audition_testimony_counts = [];
  try {
    const first = await get("/api/auditions");
    assert.equal(first.statusCode, 200);
    db.countOf = publishedOver(5001);
    // Past its TTL: served stale at once, refilled behind the reply — refused.
    t.mock.timers.tick(61_000);
    const stale = await get("/api/auditions");
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.body, first.body);
    for (let i = 0; i < 200 && heads() < 2; i++) await sleep(5);
    await sleep(20);
    const refused = await get("/api/auditions");
    assert.equal(refused.statusCode, 503, "the stale value is not served past the refusal");
    assert.equal(refused.json().message, "Liste trop longue : utilisez /api/places.");
    const counted = heads();
    assert.equal((await get("/api/auditions")).statusCode, 503);
    assert.equal(heads(), counted, "remembered: no count per request");
  } finally {
    db.tables.auditions = [];
  }
});

test("/api/health?details=1 (testing tools): the memory budget", async () => {
  const plain = await get("/api/health");
  assert.equal(plain.json().details, undefined);
  const res = await get("/api/health?details=1");
  const { details } = res.json();
  assert.ok(details.memoryMb.rss > 0);
  assert.deepEqual(
    details.families.map((f: { name: string }) => f.name),
    ["places", "assembled", "lieu", "results", "tpage", "audition", "legacy"],
  );
  // Design A19: 74 MB of Buffers (64 of answers, 10 assembled from them); the
  // boundaries' 32 MB are parsed values, on the heap.
  assert.equal(details.budgetMb.familiesMax, 74);
  assert.equal(details.budgetMb.heapStoresMax, 32);
  assert.equal(details.budgetMb.externalStoresMax, 0);
  assert.deepEqual(
    details.lrus.map((l: { name: string; maxMb: number; resident: string }) => [
      l.name,
      l.maxMb,
      l.resident,
    ]),
    [["boundaries", 32, "heap"]],
  );
  assert.deepEqual(details.dbGate, { active: 0, held: 0, waiting: 0 });
});
