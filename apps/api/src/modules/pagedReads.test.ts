import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

// The reads that go past PostgREST's max_rows, through supabase-js, against a
// fake PostgREST that sorts, filters on eq., and cuts every answer at 1,000
// rows as the real one does (supabase/config.toml).

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

function sorted(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const keys = order.split(",").map((k) => k.split("."));
  return [...rows].sort((a, b) => {
    for (const [col, dir] of keys) {
      const x = String(a[col]);
      const y = String(b[col]);
      if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  requests.push(url);
  const name = url.pathname.replace(/^\/rest\/v1\/(rpc\/)?/, "");
  let rows = tables[name];
  if (!rows) return Response.json({ message: `no ${name}` }, { status: 404 });
  for (const [k, v] of url.searchParams) {
    if (v.startsWith("eq.")) rows = rows.filter((r) => String(r[k]) === v.slice(3));
  }
  rows = sorted(rows, url.searchParams.get("order"));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? Infinity), MAX_ROWS);
  return Response.json(rows.slice(offset, offset + limit));
}) as typeof fetch;

let services: {
  auditions: typeof import("./auditions/service");
  testimonies: typeof import("./testimonies/service");
  supabase: typeof import("../lib/supabase");
};
before(async () => {
  services = {
    auditions: await import("./auditions/service"),
    testimonies: await import("./testimonies/service"),
    supabase: await import("../lib/supabase"),
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await rm(cacheDir, { recursive: true, force: true });
});
beforeEach(() => {
  tables = {};
  requests = [];
});

const uuid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
// Ten auditions a day: same-day ties everywhere, settled by id.
const day = (i: number) =>
  `2026-${String(1 + ((i / 280) | 0)).padStart(2, "0")}-${String(1 + (((i / 10) | 0) % 28)).padStart(2, "0")}`;
// Stored out of order, so that only the query's order sorts them.
const shuffled = <T>(xs: T[]) =>
  xs
    .map((x, i) => [(i * 7919) % xs.length, x] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, x]) => x);

/** The ranges asked of one table, as [offset, limit]. */
const ranges = (name: string) =>
  requests
    .filter((u) => u.pathname.endsWith(`/${name}`))
    .map((u) => [u.searchParams.get("offset"), u.searchParams.get("limit")]);

test("published auditions: all 2,500, newest first, same-day by id, each with its count", async () => {
  const published = Array.from({ length: 2500 }, (_, i) => ({
    id: uuid(i),
    title: `Audition ${i}`,
    date: day(i),
    location: "Lyon",
    status: "published",
    audition_en_ligne: false,
  }));
  const drafts = Array.from({ length: 40 }, (_, i) => ({
    ...published[i],
    id: uuid(5000 + i),
    status: "draft",
  }));
  tables.auditions = shuffled([...published, ...drafts]);
  tables.audition_testimony_counts = shuffled(
    [...published, ...drafts].map((a, i) => ({
      audition_id: a.id,
      total_count: 1 + (i % 9),
      verified_count: 0,
    })),
  );

  const auditions = await services.auditions.fetchPublishedAuditions();

  const expected = [...published].sort((a, b) =>
    a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? 1 : -1,
  );
  assert.deepEqual(
    auditions.map((a) => a.id),
    expected.map((a) => a.id),
  );
  // The counts past the first 1,000 rows of the view arrive too.
  for (const a of auditions)
    assert.equal(a.testimony_count, 1 + (Number.parseInt(a.id.slice(24), 16) % 9));
  assert.deepEqual(ranges("auditions"), [
    ["0", "1000"],
    ["1000", "1000"],
    ["2000", "1000"],
  ]);
  assert.equal(requests[0].searchParams.get("order"), "date.desc,id.asc");
  assert.equal(requests[0].searchParams.get("status"), "eq.published");
  assert.equal(ranges("audition_testimony_counts").length, 3);
});

test("published auditions: a failed page fails the read", async () => {
  tables.auditions = Array.from({ length: 1000 }, (_, i) => ({
    id: uuid(i),
    date: day(i),
    status: "published",
  }));
  // No audition_testimony_counts: the fake answers 404.
  await assert.rejects(
    services.auditions.fetchPublishedAuditions(),
    /no audition_testimony_counts/,
  );
});

test("admin list: all 2,500 auditions the caller sees, newest first", async () => {
  tables.auditions = shuffled(
    Array.from({ length: 2500 }, (_, i) => ({
      id: uuid(i),
      title: `Audition ${i}`,
      date: day(i),
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
  assert.equal(ranges("auditions").length, 3);
});

test("one audition's testimonies (admin): all 1,500, oldest first", async () => {
  tables.admin_testimonies = shuffled(
    Array.from({ length: 1500 }, (_, i) => ({
      id: uuid(i),
      audition_id: uuid(99_999),
      // Batch inserts: a hundred rows share each created_at.
      created_at: `2026-03-01T10:${String((i / 100) | 0).padStart(2, "0")}:00+00:00`,
    })),
  );

  const result = await services.testimonies.fetchTestimoniesForAudition(
    services.supabase.publicClient,
    uuid(99_999),
  );

  assert.equal(result.kind, "ok");
  const ids = result.kind === "ok" ? result.testimonies.map((t) => t.id) : [];
  assert.deepEqual(
    ids,
    sorted(tables.admin_testimonies, "created_at.asc,id.asc").map((t) => t.id),
  );
  assert.deepEqual(ranges("admin_testimonies"), [
    ["0", "1000"],
    ["1000", "1000"],
  ]);
  assert.equal(requests[0].searchParams.get("order"), "created_at.asc,id.asc");
});

test("one audition's public detail: all 1,500 testimonies, read apart", async () => {
  const id = uuid(99_999);
  tables.auditions = [{ id, title: "Audition", date: "2026-03-01", status: "published" }];
  tables.testimonies = shuffled([
    ...Array.from({ length: 1500 }, (_, i) => ({
      id: uuid(i),
      audition_id: id,
      created_at: `2026-03-01T10:${String((i / 100) | 0).padStart(2, "0")}:00+00:00`,
    })),
    // Another audition's: left out.
    ...Array.from({ length: 30 }, (_, i) => ({
      id: uuid(5000 + i),
      audition_id: uuid(1),
      created_at: "2026-03-01T09:00:00+00:00",
    })),
  ]);

  const result = await services.auditions.fetchPublishedAudition(
    services.supabase.publicClient,
    id,
  );

  assert.equal(result.kind, "ok");
  const ids = result.kind === "ok" ? result.audition.testimonies.map((t) => t.id) : [];
  assert.deepEqual(
    ids,
    sorted(
      tables.testimonies.filter((t) => t.audition_id === id),
      "created_at.asc,id.asc",
    ).map((t) => t.id),
  );
  assert.deepEqual(ranges("testimonies"), [
    ["0", "1000"],
    ["1000", "1000"],
  ]);
  const read = requests.find((u) => u.pathname.endsWith("/testimonies"))!;
  assert.equal(read.searchParams.get("audition_id"), `eq.${id}`);
  // Never the email or the verification token.
  assert.equal(
    read.searchParams.get("select"),
    "id,person_name,person_info,content,topics,verification_status,created_at",
  );
});
