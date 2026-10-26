import { createHash, randomUUID } from "node:crypto";

// In-process fakes of what the API talks to — PostgREST, the BAN geocoder and
// geo.api.gouv.fr — behind globalThis.fetch, for node:test. PostgREST filters
// (eq, neq, gt, gte, lt, lte, is, like, in; `not.`; `or`/`and` trees), sorts,
// pages, counts, updates, inserts and upserts, and the auditions table
// derives its generated columns and enforces its place CHECKs and foreign key
// as the migration does (20261026100100_audition_places.sql). geo_units and
// placement_support() answer the service role only, as granted there. GoTrue
// answers /auth/v1/user for the tokens of `users`.

export type Row = Record<string, unknown>;

export const SUPABASE_URL = "http://supabase.test";
export const BAN_URL = "http://ban.test";
const GEO_API = "https://geo.api.gouv.fr";

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

const unquote = (v: string) => v.replace(/^"(.*)"$/, "$1");

/** `op.value` (or `not.op.value`) against a cell, values compared as text. */
function test1(cell: unknown, opValue: string): boolean {
  if (opValue.startsWith("not.")) return !test1(cell, opValue.slice(4));
  const dot = opValue.indexOf(".");
  const op = opValue.slice(0, dot);
  const value = unquote(opValue.slice(dot + 1));
  if (op === "is") {
    if (value === "null") return cell === null || cell === undefined;
    if (value === "true") return cell === true;
    if (value === "false") return cell === false;
    throw new Error(`is.${value}`);
  }
  if (cell === null || cell === undefined) return false;
  const x = typeof cell === "object" ? JSON.stringify(cell) : String(cell);
  switch (op) {
    case "eq":
      return x === value;
    case "neq":
      return x !== value;
    case "gt":
      return x > value;
    case "gte":
      return x >= value;
    case "lt":
      return x < value;
    case "lte":
      return x <= value;
    case "like": {
      const re = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*");
      return new RegExp(`^${re}$`, "s").test(x);
    }
    case "in":
      return terms(value.replace(/^\((.*)\)$/, "$1"))
        .map(unquote)
        .includes(x);
    default:
      throw new Error(`operator ${op}`);
  }
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
      const xn = x === null || x === undefined;
      const yn = y === null || y === undefined;
      if (xn && yn) continue;
      if (xn || yn) return xn === nullsFirst ? -1 : 1;
      if (String(x) !== String(y)) return (String(x) < String(y) ? -1 : 1) * sign;
    }
    return 0;
  });
}

const FILTER_SKIP = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function filtered(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows;
  for (const [k, v] of params) {
    if (FILTER_SKIP.has(k)) continue;
    if (k === "or" || k === "and") out = out.filter((r) => matches(r, `${k}${v}`));
    else out = out.filter((r) => test1(r[k], v));
  }
  return out;
}

class DbError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const GENERATED = ["place_stale", "lieu_id"];
const PRECISIONS = new Set([
  "address",
  "commune",
  "locality",
  "departement",
  "region",
  "country",
  "unplaced",
]);

const isNull = (v: unknown) => v === null || v === undefined;

/** What the migration grants to the service role alone. */
const SERVICE_ONLY = new Set(["geo_units", "rpc/placement_support"]);

/** A request's PostgREST error, as `refuse` makes one up. */
export interface FakeError {
  status: number;
  code: string;
  message: string;
  details?: string;
}

/** An unsigned HS256 token for this user id (GoTrue, faked, vouches for it: `users`). */
export function fakeToken(sub: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.${b64({ unsigned: true })}`;
}

/** An in-memory PostgREST over a few tables. */
export class FakeDb {
  tables: Record<string, Row[]> = { auditions: [], geo_units: [] };
  rpcs: Record<string, (args: Row) => unknown> = {};
  requests: { method: string; url: URL; body: unknown }[] = [];
  /** Runs before each request is answered (a concurrent write, say). */
  beforeAnswer: (method: string, url: URL) => void = () => {};
  /** A made-up error for a request (null: answered as usual). */
  refuse: (method: string, url: URL, body: unknown) => FakeError | null = () => null;
  /** The key the service role is reached with (fakeEnv's SUPABASE_SERVICE_ROLE_KEY). */
  serviceKey = "service";
  /** The signed-in users GoTrue knows, by id. */
  users: Record<string, Row> = {};

  constructor() {
    this.rpcs.placement_support = () => this.placementSupport();
  }

  /** placement_support(), as the migration counts it. */
  placementSupport(): Record<string, number> {
    const byDep = new Map<string, Set<string>>();
    for (const a of this.tables.auditions) {
      if (a.status !== "published" || a.audition_en_ligne || !isNull(a.place_candidates)) continue;
      if (isNull(a.place_path) || a.place_stale) continue;
      for (const p of a.place_path as string[]) {
        if (!p.startsWith("fr:dep:")) continue;
        const dep = p.split(":")[2];
        const set = byDep.get(dep) ?? new Set<string>();
        set.add(String(a.lieu_key));
        byDep.set(dep, set);
      }
    }
    return Object.fromEntries([...byDep].map(([d, s]) => [d, s.size]));
  }

  /** The generated columns, as the migration defines them. */
  private derive(table: string, row: Row): void {
    if (table !== "auditions") return;
    row.place_stale = (row.placed_location ?? null) !== row.location;
    row.lieu_id =
      !isNull(row.place_unit) && !isNull(row.lieu_key)
        ? "l:" +
          createHash("md5")
            .update(`${row.place_unit}\x1f${row.lieu_key}`)
            .digest("hex")
            .slice(0, 16)
        : null;
  }

  /** The place CHECKs and foreign keys. */
  private check(table: string, row: Row): void {
    if (table === "geo_units") {
      if (!isNull(row.parent_id) && !this.tables.geo_units.some((u) => u.id === row.parent_id)) {
        throw new DbError(409, "23503", "geo_units_parent_id_fkey");
      }
      return;
    }
    if (table !== "auditions") return;
    const path = row.place_path as string[] | null | undefined;
    const fail = (name: string) => {
      throw new DbError(400, "23514", `violates check constraint "${name}"`);
    };
    if (!isNull(row.place_precision) && !PRECISIONS.has(String(row.place_precision))) {
      fail("auditions_place_precision");
    }
    if (isNull(row.lat) !== isNull(row.lng)) fail("auditions_place_point");
    if (isNull(path) !== isNull(row.place_unit)) fail("auditions_place_path");
    if (path) {
      if (path.length < 1 || path.length > 8 || path.some(isNull)) fail("auditions_place_path");
      if (path[path.length - 1] !== row.place_unit || !/^[A-Z]{2}$/.test(path[0])) {
        fail("auditions_place_path");
      }
    }
    const unplaced = isNull(row.place_precision) || row.place_precision === "unplaced";
    if (unplaced !== isNull(path)) fail("auditions_place_placed");
    if (path && (isNull(row.lieu_key) || isNull(row.lat))) fail("auditions_place_lieu");
    if (!isNull(row.place_unit) && !this.tables.geo_units.some((u) => u.id === row.place_unit)) {
      throw new DbError(409, "23503", "auditions_place_unit_fkey");
    }
  }

  private refuseGenerated(body: Row): void {
    for (const c of GENERATED) {
      if (c in body)
        throw new DbError(400, "428C9", `column "${c}" can only be updated to DEFAULT`);
    }
  }

  /** Insert rows into a table, generated columns and checks applied. */
  insert(table: string, rows: Row[], opts: { ignoreDuplicates?: boolean } = {}): Row[] {
    const list = (this.tables[table] ??= []);
    const out: Row[] = [];
    for (const input of rows) {
      this.refuseGenerated(input);
      const row: Row = { ...input };
      if (table === "auditions" || table === "testimonies") row.id ??= randomUUID();
      if (table === "auditions") row.created_at ??= new Date().toISOString();
      if (list.some((r) => r.id === row.id)) {
        if (opts.ignoreDuplicates) continue;
        throw new DbError(409, "23505", `duplicate key ${String(row.id)}`);
      }
      this.derive(table, row);
      this.check(table, row);
      list.push(row);
      out.push(row);
    }
    return out;
  }

  answer(method: string, url: URL, headers: Headers, body: unknown): Response {
    this.requests.push({ method, url, body });
    this.beforeAnswer(method, url);
    if (url.pathname === "/auth/v1/user") return this.user(headers);
    const made = this.refuse(method, url, body);
    if (made) {
      return Response.json(
        { code: made.code, message: made.message, details: made.details ?? null, hint: null },
        { status: made.status },
      );
    }
    const name = url.pathname.replace(/^\/rest\/v1\//, "");
    if (SERVICE_ONLY.has(name) && headers.get("apikey") !== this.serviceKey) {
      return Response.json(
        { code: "42501", message: `permission denied for ${name}`, details: null, hint: null },
        { status: 401 },
      );
    }
    try {
      return this.route(method, url, headers, body);
    } catch (e) {
      if (e instanceof DbError) {
        return Response.json(
          { code: e.code, message: e.message, details: null, hint: null },
          { status: e.status },
        );
      }
      throw e;
    }
  }

  /** GoTrue's /auth/v1/user: the user the bearer token names, if known. */
  private user(headers: Headers): Response {
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    let sub: unknown;
    try {
      sub = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).sub;
    } catch {
      sub = undefined;
    }
    const user = typeof sub === "string" ? this.users[sub] : undefined;
    if (!user) return Response.json({ code: 401, msg: "invalid JWT" }, { status: 401 });
    return Response.json({ aud: "authenticated", ...user, id: sub });
  }

  private route(method: string, url: URL, headers: Headers, body: unknown): Response {
    const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname);
    if (rpc) {
      const fn = this.rpcs[rpc[1]];
      if (!fn) return Response.json({ message: `no function ${rpc[1]}` }, { status: 404 });
      return Response.json(fn((body ?? {}) as Row));
    }
    const name = url.pathname.replace(/^\/rest\/v1\//, "");
    const table = this.tables[name];
    if (!table) return Response.json({ message: `no ${name}` }, { status: 404 });
    const prefer = headers.get("prefer") ?? "";
    const count = /count=exact/.test(prefer);
    const representation = /return=representation/.test(prefer);
    const range = (n: number) => (count ? { "content-range": `*/${n}` } : undefined);

    if (method === "GET" || method === "HEAD") {
      let rows = sorted(filtered(table, url.searchParams), url.searchParams.get("order"));
      const total = rows.length;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? Infinity);
      rows = rows.slice(offset, offset + limit);
      return new Response(method === "HEAD" ? null : JSON.stringify(rows), {
        status: 200,
        headers: { "content-type": "application/json", ...range(total) },
      });
    }
    if (method === "PATCH") {
      const patch = body as Row;
      this.refuseGenerated(patch);
      const hits = filtered(table, url.searchParams);
      // All or nothing, as one statement.
      const next = hits.map((r) => {
        const row = { ...r, ...patch };
        this.derive(name, row);
        this.check(name, row);
        return row;
      });
      hits.forEach((r, i) => Object.assign(r, next[i]));
      return representation
        ? Response.json(hits, { headers: range(hits.length) })
        : new Response(null, { status: 204, headers: range(hits.length) });
    }
    if (method === "POST") {
      const rows = (Array.isArray(body) ? body : [body]) as Row[];
      const ignoreDuplicates = /resolution=ignore-duplicates/.test(prefer);
      const inserted = this.insert(name, rows, { ignoreDuplicates });
      return representation
        ? Response.json(inserted, { status: 201 })
        : new Response(null, { status: 201 });
    }
    if (method === "DELETE") {
      const hits = new Set(filtered(table, url.searchParams));
      this.tables[name] = table.filter((r) => !hits.has(r));
      return new Response(null, { status: 204, headers: range(hits.size) });
    }
    throw new Error(`method ${method}`);
  }
}

// ---- BAN ----------------------------------------------------------------------

/** One BAN feature as match.ts reads it ([lat, lon]). */
export interface BanHit {
  coords: [number, number];
  score?: number;
  type: string;
  name: string;
  city?: string | null;
  citycode: string;
  context: string;
  population?: number | null;
}

export class FakeBan {
  /** By query, for `type=municipality` searches. */
  municipality: Record<string, BanHit[]> = {};
  /** By query, for the other searches. */
  address: Record<string, BanHit[]> = {};
  /** By "lat,lon". */
  reverse: Record<string, { citycode: string; context: string; city: string }> = {};
  calls: string[] = [];
  /** Answer every call with this status (a BAN outage). */
  failWith: number | null = null;

  answer(url: URL): Response {
    this.calls.push(`${url.pathname}?${url.searchParams}`);
    if (this.failWith) return new Response("down", { status: this.failWith });
    if (url.pathname === "/reverse/") {
      const p = this.reverse[`${url.searchParams.get("lat")},${url.searchParams.get("lon")}`];
      return Response.json({ features: p ? [{ properties: p }] : [] });
    }
    const q = url.searchParams.get("q") ?? "";
    const hits =
      (url.searchParams.get("type") === "municipality" ? this.municipality : this.address)[q] ?? [];
    return Response.json({
      features: hits.map((h) => ({
        geometry: { coordinates: [h.coords[1], h.coords[0]] },
        properties: {
          score: h.score ?? 0.95,
          type: h.type,
          name: h.name,
          city: h.city ?? h.name,
          citycode: h.citycode,
          context: h.context,
          population: h.population ?? null,
        },
      })),
    });
  }
}

// ---- geo.api.gouv.fr ----------------------------------------------------------------

export interface FakeCommune {
  nom: string;
  code: string;
  type?: string;
  codeParent?: string;
  departement: { code: string; nom: string };
  region: { code: string; nom: string };
  /** [lat, lng] */
  mairie?: [number, number];
  centre?: [number, number];
  zone?: string;
}

export class FakeGeoApi {
  communes: Record<string, FakeCommune> = {};
  departements: Record<
    string,
    { nom: string; code: string; region: { code: string; nom: string } }
  > = {};
  regions: { nom: string; code: string }[] = [];
  calls: string[] = [];
  failWith: number | null = null;

  answer(url: URL): Response {
    this.calls.push(url.pathname);
    if (this.failWith) return new Response("down", { status: this.failWith });
    const point = (p?: [number, number]) =>
      p ? { type: "Point", coordinates: [p[1], p[0]] } : undefined;
    const commune = /^\/communes\/([^/]+)$/.exec(url.pathname);
    if (commune) {
      const c = this.communes[commune[1]];
      if (!c) return new Response("{}", { status: 404 });
      return Response.json({
        ...c,
        type: c.type ?? "commune-actuelle",
        zone: c.zone ?? "metro",
        mairie: point(c.mairie),
        centre: point(c.centre),
      });
    }
    const dep = /^\/departements\/([^/]+)$/.exec(url.pathname);
    if (dep) {
      const d = this.departements[dep[1]];
      return d ? Response.json(d) : new Response("{}", { status: 404 });
    }
    if (url.pathname === "/regions") return Response.json(this.regions);
    return new Response("{}", { status: 404 });
  }
}

/** Route globalThis.fetch to the fakes; returns the function that puts the real one back. */
export function installFakes(fakes: { db?: FakeDb; ban?: FakeBan; geo?: FakeGeoApi }): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === SUPABASE_URL && fakes.db) {
      const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      return fakes.db.answer(req.method, url, req.headers, text ? JSON.parse(text) : undefined);
    }
    if (url.origin === BAN_URL && fakes.ban) return fakes.ban.answer(url);
    if (url.origin === GEO_API && fakes.geo) return fakes.geo.answer(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** The environment the API's config reads, for a test against the fakes. */
export function fakeEnv(cacheDir: string, extra: Record<string, string> = {}): void {
  Object.assign(process.env, {
    APP_ENV: "local",
    EMAIL_MODE: "log",
    SUPABASE_URL,
    SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    BAN_BASE_URL: BAN_URL,
    LOG_LEVEL: "fatal",
    CACHE_DIR: cacheDir,
    ...extra,
  });
}
