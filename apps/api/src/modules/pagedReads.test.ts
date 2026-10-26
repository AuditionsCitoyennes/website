import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { FastifyInstance } from "fastify";

// The reads that go past PostgREST's max_rows, through supabase-js, against a
// fake PostgREST that filters (eq/gt/lt/is, `or`/`and` trees), sorts, embeds
// an audition's testimonies, and cuts every list at 1,000 rows as the real
// one does (supabase/config.toml), an embedded list included.

const MAX_ROWS = 1000;
const cacheDir = await mkdtemp(join(tmpdir(), "ac-paged-reads-"));
Object.assign(process.env, {
  APP_ENV: "local",
  EMAIL_MODE: "log",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_ANON_KEY: "anon",
  LOG_LEVEL: "fatal",
  CACHE_DIR: cacheDir,
});

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let requests: URL[] = [];
/** Runs after each read is answered: a write landing between two pages. */
let afterRead: (url: URL) => void = () => {};

/** Splits a filter list at its top-level commas (not inside parentheses or quotes). */
function terms(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && c === ",") {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out;
}

/** `op.value` (or `not.op.value`) against a row's column, values compared as text. */
function test1(cell: unknown, opValue: string): boolean {
  if (opValue.startsWith("not.")) return !test1(cell, opValue.slice(4));
  const dot = opValue.indexOf(".");
  const op = opValue.slice(0, dot);
  const value = opValue.slice(dot + 1).replace(/^"(.*)"$/, "$1");
  if (op === "is") return value === "null" ? cell == null : assert.fail(`is.${value}`);
  if (cell == null) return false;
  const x = String(cell);
  if (op === "eq") return x === value;
  if (op === "gt") return x > value;
  if (op === "lt") return x < value;
  return assert.fail(`operator ${op}`);
}

/** One term of a logic tree: `col.op.value`, `and(...)` or `or(...)`. */
function matches(row: Row, term: string): boolean {
  const tree = /^(and|or)\((.*)\)$/.exec(term);
  if (tree) {
    const parts = terms(tree[2]).map((t) => matches(row, t));
    return tree[1] === "and" ? parts.every(Boolean) : parts.some(Boolean);
  }
  const dot = term.indexOf(".");
  return test1(row[term.slice(0, dot)], term.slice(dot + 1));
}

/** PostgreSQL's order: nulls last ascending, first descending, unless told. */
function sorted(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const keys = order.split(",").map((k) => {
    const [col, dir = "asc", nulls] = k.split(".");
    const sign = dir === "desc" ? -1 : 1;
    const nullsFirst = nulls ? nulls === "nullsfirst" : dir === "desc";
    return { col, sign, nullsFirst };
  });
  return [...rows].sort((a, b) => {
    for (const { col, sign, nullsFirst } of keys) {
      const x = a[col];
      const y = b[col];
      if (x == null && y == null) continue;
      if (x == null || y == null) return (x == null) === nullsFirst ? -1 : 1;
      if (String(x) !== String(y)) return (String(x) < String(y) ? -1 : 1) * sign;
    }
    return 0;
  });
}

function answer(url: URL): Response {
  if (url.pathname === "/auth/v1/user") {
    return Response.json({ id: SUPER_ADMIN, aud: "authenticated", email: "root@example.test" });
  }
  const name = url.pathname.replace(/^\/rest\/v1\/(rpc\/)?/, "");
  if (name === "is_super_admin") return Response.json(true);
  if (name === "is_admin") return Response.json(false);
  let rows = tables[name];
  if (!rows) return Response.json({ message: `no ${name}` }, { status: 404 });
  for (const [k, v] of url.searchParams) {
    if (k === "or") rows = rows.filter((r) => matches(r, `or${v}`));
    else if (!["select", "order", "limit", "offset"].includes(k)) {
      rows = rows.filter((r) => test1(r[k], v));
    }
  }
  rows = sorted(rows, url.searchParams.get("order"));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? Infinity), MAX_ROWS);
  rows = rows.slice(offset, offset + limit);
  if (url.searchParams.get("select")?.includes("testimonies(")) {
    // Embedded: the audition's testimonies in stored order, cut at max_rows.
    rows = rows.map((a) => ({
      ...a,
      testimonies: (tables.testimonies ?? [])
        .filter((t) => t.audition_id === a.id)
        .slice(0, MAX_ROWS),
    }));
  }
  return Response.json(rows);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  requests.push(url);
  const res = answer(url);
  afterRead(url);
  return res;
}) as typeof fetch;

const SUPER_ADMIN = "11111111-1111-4111-8111-111111111111";

let services: {
  auditions: typeof import("./auditions/service");
  testimonies: typeof import("./testimonies/service");
  supabase: typeof import("../lib/supabase");
};
let app: FastifyInstance;
before(async () => {
  services = {
    auditions: await import("./auditions/service"),
    testimonies: await import("./testimonies/service"),
    supabase: await import("../lib/supabase"),
  };
  const { buildServer } = await import("../server");
  app = buildServer();
  await app.ready();
});
after(async () => {
  await app.close();
  globalThis.fetch = realFetch;
  await rm(cacheDir, { recursive: true, force: true });
});
beforeEach(() => {
  tables = {};
  requests = [];
  afterRead = () => {};
});

const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
// Ten auditions a day: same-day ties everywhere, settled by id.
const day = (i: number) =>
  `2026-${String(1 + ((i / 280) | 0)).padStart(2, "0")}-${String(1 + (((i / 10) | 0) % 28)).padStart(2, "0")}`;
// Batch inserts: seventy testimonies share each created_at, so ties straddle
// the page boundaries.
const at = (i: number) =>
  `2026-03-01T${String(10 + ((i / 4200) | 0)).padStart(2, "0")}:${String(((i / 70) | 0) % 60).padStart(2, "0")}:00+00:00`;
// Stored out of order, so that only the query's order sorts them.
const shuffled = <T>(xs: T[]) =>
  xs
    .map((x, i) => [(i * 7919) % xs.length, x] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, x]) => x);

/** The reads of one table, as their query strings. */
const reads = (name: string) =>
  requests.filter((u) => u.pathname.endsWith(`/${name}`)).map((u) => u.searchParams);

const published = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: uuid(i),
    title: `Audition ${i}`,
    date: day(i),
    location: "Lyon",
    status: "published",
    audition_en_ligne: false,
  }));
const cmp = (x: unknown, y: unknown) =>
  String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
// Newest first, same-day by id.
const byDateThenId = (a: Row, b: Row) => cmp(b.date, a.date) || cmp(a.id, b.id);

test("published auditions: all 2,500, newest first, same-day by id, each with its count", async () => {
  const pub = published(2500);
  const drafts = pub.slice(0, 40).map((a, i) => ({ ...a, id: uuid(5000 + i), status: "draft" }));
  tables.auditions = shuffled([...pub, ...drafts]);
  tables.audition_testimony_counts = shuffled(
    [...pub, ...drafts].map((a, i) => ({
      audition_id: a.id,
      total_count: 1 + (i % 9),
      verified_count: 0,
    })),
  );

  const auditions = await services.auditions.fetchPublishedAuditions();

  const expected = [...pub].sort(byDateThenId);
  assert.deepEqual(
    auditions.map((a) => a.id),
    expected.map((a) => a.id),
  );
  // The counts past the first 1,000 rows of the view arrive too.
  for (const a of auditions)
    assert.equal(a.testimony_count, 1 + (Number.parseInt(a.id.slice(24), 16) % 9));
  // Keyset pages: each after the last row of the one before.
  const pages = reads("auditions");
  assert.deepEqual(
    pages.map((p) => [p.get("limit"), p.get("offset"), p.get("or")]),
    [undefined, expected[999], expected[1999]].map((last) => [
      "1000",
      null,
      last ? `(date.lt.${last.date},and(date.eq.${last.date},id.gt.${last.id}))` : null,
    ]),
  );
  assert.equal(pages[0].get("order"), "date.desc,id.asc");
  assert.equal(pages[0].get("status"), "eq.published");
  const countPages = reads("audition_testimony_counts");
  assert.equal(countPages.length, 3);
  assert.equal(countPages[0].get("audition_id"), null);
  assert.match(countPages[1].get("audition_id") ?? "", /^gt\./);
});

test("published auditions: a write between two pages neither repeats nor drops a row", async () => {
  const pub = published(2500);
  tables.auditions = shuffled(pub);
  tables.audition_testimony_counts = [];
  const expected = [...pub].sort(byDateThenId);
  let page = 0;
  afterRead = (url) => {
    if (!url.pathname.endsWith("/auditions")) return;
    page++;
    // After the first page a newer audition lands: an offset would read the
    // first page's last row again. After the second, two of the first page
    // go: an offset would skip two rows.
    if (page === 1) {
      tables.auditions = [...tables.auditions, { ...pub[0], id: uuid(9000), date: "2027-01-01" }];
    }
    if (page === 2) {
      const gone = new Set([expected[0].id, expected[1].id]);
      tables.auditions = tables.auditions.filter((a) => !gone.has(String(a.id)));
    }
  };

  const ids = (await services.auditions.fetchPublishedAuditions()).map((a) => a.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ids,
    expected.map((a) => a.id),
  );
});

test("published auditions: a failed page fails the read", async () => {
  tables.auditions = published(1000);
  // No audition_testimony_counts: the fake answers 404.
  await assert.rejects(
    services.auditions.fetchPublishedAuditions(),
    /no audition_testimony_counts/,
  );
});

test("admin list: all 2,500 auditions the caller sees, newest first", async () => {
  tables.auditions = shuffled(
    published(2500).map((a, i) => ({
      ...a,
      location: "Mairie de Lyon",
      status: i % 5 ? "published" : "draft",
      audition_en_ligne: true,
      // An online audition's town hall: placed without the geocoder.
      place: {
        insee: "69123",
        commune: "Lyon",
        arrondissement: null,
        departementCode: "69",
        departementName: "Rhône",
        region: "Auvergne-Rhône-Alpes",
        lat: 45.76,
        lng: 4.83,
      },
    })),
  );

  const result = await services.auditions.fetchAdminAuditions(services.supabase.publicClient);

  assert.equal(result.kind, "ok");
  const ids = result.kind === "ok" ? result.auditions.map((a) => a.id) : [];
  assert.equal(ids.length, 2500);
  assert.deepEqual(
    ids,
    sorted(tables.auditions, "date.desc,id.asc").map((a) => a.id),
  );
  assert.equal(reads("auditions").length, 3);
});

/** 2,500 testimonies of one audition: tied created_at in runs of 70, some without one. */
const testimoniesOf = (auditionId: string, nulls: number) =>
  shuffled(
    Array.from({ length: 2500 }, (_, i) => ({
      id: uuid(i),
      audition_id: auditionId,
      person_name: `T${i}`,
      person_info: null,
      content: "…",
      topics: null,
      verification_status: null,
      created_at: i < nulls ? null : at(i),
    })),
  );

test("one audition's testimonies (admin): all 2,500, oldest first, the undated last", async () => {
  const id = uuid(99_999);
  // 1,300 undated: the second page ends on one.
  tables.admin_testimonies = testimoniesOf(id, 1300);

  const result = await services.testimonies.fetchTestimoniesForAudition(
    services.supabase.publicClient,
    id,
  );

  assert.equal(result.kind, "ok");
  const ids = result.kind === "ok" ? result.testimonies.map((t) => t.id) : [];
  const expected = sorted(tables.admin_testimonies, "created_at.asc,id.asc");
  assert.deepEqual(
    ids,
    expected.map((t) => t.id),
  );
  const pages = reads("admin_testimonies");
  assert.equal(pages[0].get("order"), "created_at.asc,id.asc");
  const [dated, undated] = [999, 1999].map((i) => expected[i]);
  assert.deepEqual(
    pages.map((p) => p.get("or")),
    [
      null,
      `(created_at.gt."${dated.created_at}",and(created_at.eq."${dated.created_at}",id.gt.${dated.id}),created_at.is.null)`,
      `(and(created_at.is.null,id.gt.${undated.id}))`,
    ],
  );
});

test("public detail: below 1,000 testimonies, the embedded list as read, in one request", async () => {
  const id = uuid(99_999);
  tables.auditions = [{ id, title: "Audition", date: "2026-03-01", status: "published" }];
  tables.testimonies = testimoniesOf(id, 0).slice(0, 999);

  const result = await services.auditions.fetchPublishedAudition(
    services.supabase.publicClient,
    id,
  );

  assert.equal(result.kind, "ok");
  assert.deepEqual(result.kind === "ok" && result.audition.testimonies, tables.testimonies);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].searchParams.get("select"),
    "*,testimonies(id,person_name,person_info,content,topics,verification_status,created_at)",
  );
});

test("public detail: a full embedded list is read again, whole, in the map panel's order", async () => {
  const id = uuid(99_999);
  tables.auditions = [{ id, title: "Audition", date: "2026-03-01", status: "published" }];
  tables.testimonies = [
    // 1,100 undated: the first page ends on one.
    ...testimoniesOf(id, 1100),
    // Another audition's: left out.
    ...Array.from({ length: 30 }, (_, i) => ({
      id: uuid(5000 + i),
      audition_id: uuid(1),
      created_at: at(0),
    })),
  ];

  const result = await services.auditions.fetchPublishedAudition(
    services.supabase.publicClient,
    id,
  );

  assert.equal(result.kind, "ok");
  const ids = result.kind === "ok" ? result.audition.testimonies.map((t) => t.id) : [];
  const expected = sorted(
    tables.testimonies.filter((t) => t.audition_id === id),
    "created_at.asc.nullsfirst,id.desc",
  );
  assert.deepEqual(
    ids,
    expected.map((t) => t.id),
  );
  const pages = reads("testimonies");
  assert.equal(pages.length, 3);
  const read = pages[0];
  assert.equal(read.get("audition_id"), `eq.${id}`);
  assert.equal(read.get("order"), "created_at.asc.nullsfirst,id.desc");
  // Never the email or the verification token.
  assert.equal(
    read.get("select"),
    "id,person_name,person_info,content,topics,verification_status,created_at",
  );
  const [undated, dated] = [999, 1999].map((i) => expected[i]);
  assert.deepEqual(
    pages.map((p) => p.get("or")),
    [
      null,
      `(created_at.not.is.null,and(created_at.is.null,id.lt.${undated.id}))`,
      `(created_at.gt."${dated.created_at}",and(created_at.eq."${dated.created_at}",id.lt.${dated.id}))`,
    ],
  );
});

// ---- The audit log's preview, through the route --------------------------

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
// HS256: supabase-js checks it with GoTrue (/auth/v1/user, answered above).
const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
  sub: SUPER_ADMIN,
  role: "authenticated",
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.${b64({ unsigned: true })}`;
const preview = (id: string) =>
  app.inject({
    method: "GET",
    url: `/api/admin/auditions/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
const draft = (id: string) => ({
  id,
  title: "Brouillon",
  date: "2026-03-01",
  location: "Lyon",
  content: null,
  status: "draft",
  created_at: at(0),
});

test("preview route: a draft's 2,500 testimonies, whole", async () => {
  const id = uuid(99_999);
  tables.auditions = [draft(id)];
  tables.testimonies = testimoniesOf(id, 0);

  const res = await preview(id);

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "draft");
  assert.deepEqual(
    body.testimonies.map((t: Row) => t.id),
    sorted(tables.testimonies, "created_at.asc.nullsfirst,id.desc").map((t) => t.id),
  );
  assert.equal(reads("testimonies").length, 3);
});

test("preview route: a short list as embedded, in one read", async () => {
  const id = uuid(99_999);
  tables.auditions = [draft(id)];
  tables.testimonies = testimoniesOf(id, 0).slice(0, 12);

  const res = await preview(id);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ...draft(id), testimonies: tables.testimonies });
  assert.equal(reads("auditions").length, 1);
  assert.equal(reads("testimonies").length, 0);
});
