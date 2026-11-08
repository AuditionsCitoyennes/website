// The static outline files (format v1, scripts/map-data/outlines/lib.ts and
// docs/map-outlines.md): their shapes, their URLs, the check every response
// goes through, and the store that hands their geometries out. Pure: no Vue,
// no DOM, nothing at import but declarations. Read by the explorer through
// geo-nav/data/useOutlineFiles.ts.
//
// The store's rules: every geometry is stored once per `id@tier` and handed
// out by identity (WeakMap caches are keyed on the object, so a département's
// entry in its région's bundle IS its self once both are in); root.json's rows
// are authoritative; a write is one call, bumping `version` once; existence is
// declared by the rows' k/u/g flags, never probed.

import type { Bounds, LevelKey } from "./types";

// ---- format v1 (copied as types: the web never imports scripts/) --------------

type Position = [number, number];
type BBox = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
type Flag = 0 | 1;

/** A unit's outline as the files carry it: GeoJSON, coordinates [lng, lat]. */
export type OutlineGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

/** The levels a file names (the site's LevelKey minus the world and lieux). */
export type OutlineLevel = Exclude<LevelKey, "world" | "place">;
export type OutlineKind = "k" | "u" | "g";

/** A file's own unit. */
export interface FileSelfV1 {
  id: string;
  bbox: BBox;
  center: Position; // [lat, lng]
  n: number; // vertex count
  g: OutlineGeometry;
}
/** A child unit inside a k file: here `g` is its geometry. */
export type FileEntryV1 = FileSelfV1 & { name: string; level: OutlineLevel; k: Flag; u: Flag };

interface FileHeadV1 {
  v: 1;
  build: string;
  id: string;
  tier: string;
  tolM: number;
  self: FileSelfV1;
  wrap?: 1;
}
/** A unit's bundle: its self and its children, cut by one run. */
export interface KFileV1 extends FileHeadV1 {
  kind: "k";
  units: FileEntryV1[];
}
/** A unit's self alone. */
export interface UFileV1 extends FileHeadV1 {
  kind: "u";
}
/** A country at the world tier. */
export interface GFileV1 extends FileHeadV1 {
  kind: "g";
}
export type OutlineFileV1 = KFileV1 | UFileV1 | GFileV1;

/** A row of root.json: here `g` is a flag (a g/ file exists). */
export interface RootRowV1 {
  id: string;
  parent: string | null;
  level: OutlineLevel;
  name: string;
  bbox: BBox;
  center: Position;
  st: string; // the tier of its self
  k: Flag;
  u: Flag;
  g: Flag;
  wrap?: 1;
}
export interface RootV1 {
  v: 1;
  build: string;
  tiers: Record<string, { tolM: number; source: string }>;
  units: RootRowV1[];
}

/** A unit as the store holds it: a root row, or a child entry for an id
 *  without one (communes, arrondissements). */
export interface OutlineRow {
  id: string;
  parent: string | null;
  level: OutlineLevel;
  name: string;
  /** All rings; a `wrap` unit's box may reach past 180°. */
  bounds: Bounds;
  center: Position; // [lat, lng]
  st: string;
  k: Flag;
  u: Flag;
  g: Flag;
  wrap: boolean;
  fromRoot: boolean;
}

// ---- where a file is -------------------------------------------------------------

/** A unit id as a file name: `fr:dep:69` → `fr_dep_69`. */
export const keyOf = (id: string): string => id.replaceAll(":", "_");
export const fileKey = (kind: OutlineKind, id: string): string => `${kind}/${keyOf(id)}`;
/** `base` ends with "/". */
export const fileUrl = (base: string, build: string, kind: OutlineKind, id: string): string =>
  `${base}outlines/${build}/${kind}/${keyOf(id)}.json`;
export const rootUrl = (base: string, build: string): string =>
  `${base}outlines/${build}/root.json`;

// ---- the check every response goes through ---------------------------------------

/** Why a file did not come: `html`, `version` and `skew` mean the host holds
 *  another build, or none (a static host answers a missing path with its
 *  index.html, 200). */
export type OutlineReason = "missing" | "network" | "html" | "version" | "skew" | "shape";
export type Checked<T> = { ok: true; file: T } | { ok: false; reason: OutlineReason };

export const isReleaseSkew = (reason: OutlineReason): boolean =>
  reason === "html" || reason === "version" || reason === "skew";

/** Step 1, the response's head; null for a rejected fetch or a timeout. */
export function checkResponse(
  meta: { ok: boolean; status: number; contentType: string | null } | null,
): OutlineReason | null {
  if (!meta) return "network";
  if (!meta.ok) return meta.status === 404 || meta.status === 410 ? "missing" : "network";
  return meta.contentType?.includes("json") ? null : "html";
}

/** Step 2, the body's text: what does not parse is the host serving something else. */
export function parseBody(
  text: string,
): { ok: true; body: unknown } | { ok: false; reason: "html" } {
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "html" };
  }
}

const LEVEL_NAMES: readonly unknown[] = ["country", "region", "dep", "city", "arr"];
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isTuple = (v: unknown, n: number): boolean =>
  Array.isArray(v) && v.length === n && v.every(isNum);
const isFlag = (v: unknown): boolean => v === 0 || v === 1;
const isStr = (v: unknown): boolean => typeof v === "string";

// The coordinates are not walked: a file is cut by our own build.
function selfOk(s: unknown): s is FileSelfV1 {
  if (!isObj(s) || !isStr(s.id) || !isTuple(s.bbox, 4) || !isTuple(s.center, 2)) return false;
  const g = s.g;
  return (
    isNum(s.n) &&
    s.n >= 0 &&
    isObj(g) &&
    (g.type === "Polygon" || g.type === "MultiPolygon") &&
    Array.isArray(g.coordinates)
  );
}
const entryOk = (e: unknown): boolean =>
  selfOk(e) &&
  isObj(e) &&
  isStr(e.name) &&
  LEVEL_NAMES.includes(e.level) &&
  isFlag(e.k) &&
  isFlag(e.u);
const rowOk = (r: unknown): boolean =>
  isObj(r) &&
  isStr(r.id) &&
  (r.parent === null || isStr(r.parent)) &&
  LEVEL_NAMES.includes(r.level) &&
  isStr(r.name) &&
  isTuple(r.bbox, 4) &&
  isTuple(r.center, 2) &&
  isStr(r.st) &&
  isFlag(r.k) &&
  isFlag(r.u) &&
  isFlag(r.g) &&
  (r.wrap === undefined || r.wrap === 1);

/** A k/u/g file's shape, without the build or the id it was asked for: what
 *  the store checks before a write. */
export function fileShapeOk(o: unknown): o is OutlineFileV1 {
  if (!isObj(o) || o.v !== 1 || !isStr(o.build) || !isStr(o.id) || !isStr(o.tier)) return false;
  if (o.kind !== "k" && o.kind !== "u" && o.kind !== "g") return false;
  if (!isNum(o.tolM) || (o.wrap !== undefined && o.wrap !== 1)) return false;
  if (!selfOk(o.self) || o.self.id !== o.id) return false;
  return o.kind !== "k" || (Array.isArray(o.units) && o.units.every(entryOk));
}

/** Step 3, the parsed body against what was asked for. */
export function validateBody(
  body: unknown,
  expect: { build: string; kind: "root" },
): Checked<RootV1>;
export function validateBody(
  body: unknown,
  expect: { build: string; kind: OutlineKind; id: string },
): Checked<OutlineFileV1>;
export function validateBody(
  body: unknown,
  expect: { build: string; kind: "root" | OutlineKind; id?: string },
): Checked<RootV1 | OutlineFileV1> {
  const o = isObj(body) ? body : {};
  if (o.v !== 1) return { ok: false, reason: "version" };
  if (o.build !== expect.build) return { ok: false, reason: "skew" };
  const ok =
    expect.kind === "root"
      ? !("kind" in o) && isObj(o.tiers) && Array.isArray(o.units) && o.units.every(rowOk)
      : o.kind === expect.kind && o.id === expect.id && fileShapeOk(o);
  return ok
    ? { ok: true, file: o as unknown as RootV1 | OutlineFileV1 }
    : { ok: false, reason: "shape" };
}

/** A file's vertices: its self's and its entries'. */
export const verticesOf = (f: OutlineFileV1): number =>
  f.self.n + (f.kind === "k" ? f.units.reduce((n, e) => n + e.n, 0) : 0);

// ---- the store -------------------------------------------------------------------------

const boundsOf = ([minLng, minLat, maxLng, maxLat]: BBox): Bounds => ({
  minLat,
  maxLat,
  minLng,
  maxLng,
});

/** What every stored geometry goes through once (markRaw in the page). */
export type OutlineWrap = <T extends object>(o: T) => T;

interface Held {
  g: OutlineGeometry;
  n: number;
  /** The loaded files holding it (fileKeys). */
  holders: Set<string>;
}
interface Loaded {
  /** The `id@tier` of every object it holds. */
  keys: string[];
  /** A k file's entries, by id: the stored objects. */
  units?: Map<string, OutlineGeometry>;
  used: number;
}

/**
 * The outline files loaded for the page. Non-reactive: the caller turns
 * `version` (bumped once per write that changed something) into its signal.
 * Files go out least recently used first when the stored objects' vertices
 * (counted from `n`) pass `capVertices`; pinned files never do. An evicted
 * file is simply not loaded any more: a refetch stores NEW objects for its
 * ids, so the WeakMap caches keyed on the old ones go cold (acceptable).
 */
export class OutlineStore {
  private readonly cap: number;
  private readonly rows = new Map<string, OutlineRow>();
  private readonly objects = new Map<string, Held>();
  private readonly files = new Map<string, Loaded>();
  private readonly entryTier = new Map<string, string>();
  private readonly globeTier = new Map<string, string>();
  private pinned = new Set<string>();
  private vertices = 0;
  private clock = 0;
  private dedupeHits = 0;
  private conflicts = 0;
  private evicted = 0;
  private written = 0;

  constructor({ capVertices = 400_000 }: { capVertices?: number } = {}) {
    this.cap = capVertices;
  }

  get version(): number {
    return this.written;
  }

  /** The rows of root.json: authoritative for everything a row says. */
  putRoot(root: RootV1): void {
    for (const r of root.units) {
      this.rows.set(r.id, {
        id: r.id,
        parent: r.parent,
        level: r.level,
        name: r.name,
        bounds: boundsOf(r.bbox),
        center: r.center,
        st: r.st,
        k: r.k,
        u: r.u,
        g: r.g,
        wrap: r.wrap === 1,
        fromRoot: true,
      });
    }
    this.written++;
  }

  put(file: OutlineFileV1, wrap: OutlineWrap) {
    return this.putMany([file], wrap);
  }

  /**
   * One write: the files not loaded yet are added, then the least recently
   * used files leave if the cap is passed (never one this call added).
   * Atomic: every file is checked first, so a malformed one throws before
   * anything changed. `wrap` (markRaw in the page) sees every stored
   * geometry once.
   */
  putMany(
    files: OutlineFileV1[],
    wrap: OutlineWrap,
  ): { added: number; dedupeHits: number; conflicts: number; evicted: number } {
    for (const f of files)
      if (!fileShapeOk(f)) throw new TypeError("putMany: not an outline file of format v1");
    const added = new Set<string>();
    let hits = 0;
    let conflicts = 0;
    for (const f of files) {
      const fk = fileKey(f.kind, f.id);
      if (this.files.has(fk)) continue;
      const keys: string[] = [];
      const hold = (s: FileSelfV1) => {
        const key = `${s.id}@${f.tier}`;
        const held = this.objects.get(key);
        if (!held) {
          this.objects.set(key, { g: wrap(s.g), n: s.n, holders: new Set([fk]) });
          this.vertices += s.n;
        } else if (!held.holders.has(fk)) {
          held.holders.add(fk);
          hits++;
          if (held.n !== s.n) conflicts++; // the existing object stays
        } else return;
        keys.push(key);
      };
      hold(f.self);
      const units = f.kind === "k" ? new Map<string, OutlineGeometry>() : undefined;
      if (f.kind === "k") {
        for (const e of f.units) {
          hold(e);
          units!.set(e.id, this.objects.get(`${e.id}@${f.tier}`)!.g);
          this.entryTier.set(e.id, f.tier);
          // An entry never changes a row: k/FR's fr1000 entry of a région
          // leaves its root row's st at e50.
          if (!this.rows.has(e.id)) {
            this.rows.set(e.id, {
              id: e.id,
              parent: f.id,
              level: e.level,
              name: e.name,
              bounds: boundsOf(e.bbox),
              center: e.center,
              st: f.tier,
              k: e.k,
              u: e.u,
              g: 0,
              wrap: false,
              fromRoot: false,
            });
          }
        }
      }
      if (f.kind === "g") this.globeTier.set(f.id, f.tier);
      this.files.set(fk, { keys, units, used: ++this.clock });
      added.add(fk);
    }
    const evicted = added.size ? this.evict(added) : 0;
    this.dedupeHits += hits;
    this.conflicts += conflicts;
    if (added.size) this.written++;
    return { added: added.size, dedupeHits: hits, conflicts, evicted };
  }

  /**
   * Keeps these units' files whatever the cap: for each id, the files holding
   * its self, its entry and its world outline, and its bundle. Replaces the
   * pinned set; returns the pinned files' vertices.
   */
  pin(ids: Iterable<string>): number {
    const pinned = new Set<string>();
    for (const id of ids) {
      for (const tier of [this.rows.get(id)?.st, this.entryTier.get(id), this.globeTier.get(id)])
        for (const fk of (tier && this.objects.get(`${id}@${tier}`)?.holders) || []) pinned.add(fk);
      if (this.files.has(fileKey("k", id))) pinned.add(fileKey("k", id));
    }
    const keys = new Set<string>();
    for (const fk of pinned) {
      const f = this.files.get(fk)!;
      f.used = ++this.clock;
      for (const key of f.keys) keys.add(key);
    }
    this.pinned = pinned;
    let total = 0;
    for (const key of keys) total += this.objects.get(key)!.n;
    return total;
  }

  rowOf(id: string): OutlineRow | undefined {
    return this.rows.get(id);
  }
  /** Its self, at its row's tier: undefined until that object is stored. */
  selfOf(id: string): OutlineGeometry | undefined {
    return this.at(id, this.rows.get(id)?.st);
  }
  /** Its entry in its parent's bundle (FR has none). */
  entryOf(id: string): OutlineGeometry | undefined {
    return this.at(id, this.entryTier.get(id));
  }
  /** Its world outline (its g/ file's): undefined until that file is in. */
  globeOf(id: string): OutlineGeometry | undefined {
    return this.at(id, this.globeTier.get(id));
  }
  /** The entries of its loaded bundle, by id (undefined until k/<id> is in):
   *  its children's geometries, cut by the same run as its self. */
  unitsOf(id: string): ReadonlyMap<string, OutlineGeometry> | undefined {
    return this.files.get(fileKey("k", id))?.units;
  }
  has(id: string, tier: string): boolean {
    return this.objects.has(`${id}@${tier}`);
  }
  bundleLoaded(id: string): boolean {
    return this.files.has(fileKey("k", id));
  }
  loaded(kind: OutlineKind, id: string): boolean {
    return this.files.has(fileKey(kind, id));
  }
  loadedKeys(): string[] {
    return [...this.files.keys()];
  }
  stats() {
    return {
      files: this.files.size,
      objects: this.objects.size,
      vertices: this.vertices,
      dedupeHits: this.dedupeHits,
      conflicts: this.conflicts,
      evicted: this.evicted,
    };
  }

  private at(id: string, tier: string | undefined): OutlineGeometry | undefined {
    return tier === undefined ? undefined : this.objects.get(`${id}@${tier}`)?.g;
  }

  private evict(added: Set<string>): number {
    let n = 0;
    while (this.vertices > this.cap) {
      let oldest: string | undefined;
      let used = Infinity;
      for (const [fk, f] of this.files)
        if (f.used < used && !added.has(fk) && !this.pinned.has(fk)) [oldest, used] = [fk, f.used];
      if (!oldest) break; // the cap is soft
      for (const key of this.files.get(oldest)!.keys) {
        const held = this.objects.get(key)!;
        held.holders.delete(oldest);
        if (!held.holders.size) {
          this.objects.delete(key);
          this.vertices -= held.n;
        }
      }
      this.files.delete(oldest);
      n++;
    }
    this.evicted += n;
    return n;
  }
}
