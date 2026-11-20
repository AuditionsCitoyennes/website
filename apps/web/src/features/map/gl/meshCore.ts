// The mesh worker's core (gl/meshWorker.ts): the geometries
// the page sent, by token, and the builds it asks for, one at a time.
//
// The store keeps each token's geometry as ONE unflattened object, reused by
// every later request naming that token: the projection caches
// (lib/projection.ts) are keyed by object identity, so a geometry rebuilt per
// request would be projected again every time. The page decides what is kept:
// the core never evicts by itself, it frees what a `release` names, and
// answers a request naming a token it does not hold with `missing` (the page
// sends those geometries again).
//
// A request's new geometries are stored as it arrives; its build is queued,
// and builds run one per task, so the requests that came in during
// one build are all read before the next starts: a request that `supersede`s
// marks every queued one before it as superseded, and those are answered
// `skipped` without being built (the page's newer run has no use for them).
//
// The flat view's grey sheet is cut here too (gl/tintSheet.ts):
// a `tint` request names the selection's geometries by token like a build,
// and is answered before the builds queued — it is small, and the grey is
// what the visitor sees first. A newer tint supersedes the tints queued; a
// build supersedes builds only.
//
// A tapped unit's pending mark is built here too when the unit is large
// (gl/pendingMark.ts, gl/PendingMarkPass.ts): a `mark` request names one
// geometry by token and a regime. The tap's own (`front`) is answered like a
// tint, before the builds queued — the fill is the tap's first sign — and
// supersedes the marks queued; one that is not (the other regime, asked
// later; the bisected globe fill of a wide unit, whose plain fill the page
// has drawn already) waits its turn behind everything queued. A mark never supersedes a
// build and no build supersedes it. It never answers `error`: a throw
// answers "nothing built" (`built: null`), and the page builds it.
//
// Synchronous and pure: the builder, the flat geometries, nothing that touches
// `window` (no @/shared/perf) and no mapbox-gl (lib/corePurity.test.ts).

import type { OutlineFC } from "../types";
import { buildPlateauMesh, type MeshOut } from "./meshBuild";
import { flatVertices, unflatten, type FlatGeom, type Geom } from "./meshFlat";
import { buildMark, type MarkFill, type MarkLine, type MarkRegime } from "./pendingMark";
import { cutTintSheet } from "./tintSheet";

/** What the builder reads of a feature, by place in its list (a token is per
 *  geometry object, not per feature, so this travels in every request). */
export interface MeshMeta {
  id: string;
  level: string;
  /** False: the builder skips the feature (no geometry, or no type). */
  hasGeom: boolean;
}

/** A feature list: each feature's geometry token (null without one) and meta. */
export interface MeshSet {
  tokens: (number | null)[];
  meta: MeshMeta[];
}

/** The sets to build: mercator, globe, or both — and `lean`, the boundary
 *  lines in the lean layout (gl/lineSegments.ts; absent: full). */
export interface MeshWant {
  merc: boolean;
  globe: boolean;
  lean?: boolean;
}

/** A geometry sent for the first time under `token`. */
export interface MeshPut {
  token: number;
  flat: FlatGeom;
}

export interface MeshRequest {
  t: "build";
  id: number;
  want: MeshWant;
  heightM: number;
  scope: MeshSet;
  focus: MeshSet;
  context: MeshSet;
  puts: MeshPut[];
  /** Every request queued before this one is superseded. */
  supersede: boolean;
  /** Testing tools: wait this long before replying (ms). */
  delayMs?: number;
  /** Testing tools: build this many times, the extras discarded (a slower worker). */
  slow?: number;
  /** Testing tools: reply `error` ("throw") or never ("hang"). */
  fail?: "throw" | "hang";
}

export interface MeshRelease {
  t: "release";
  tokens: number[];
}

/** The grey sheet cut around the geometries of `scope` (gl/tintSheet.ts). */
export interface TintRequest {
  t: "tint";
  id: number;
  scope: MeshSet;
  puts: MeshPut[];
  /** Testing tools: as a build's. */
  delayMs?: number;
  fail?: "throw" | "hang";
}

/** The pending mark of the one geometry of `scope`, for one regime. */
export interface MarkRequest {
  t: "mark";
  id: number;
  scope: MeshSet;
  puts: MeshPut[];
  regime: MarkRegime;
  /** The tap's own request: answered before the builds queued. */
  front: boolean;
  /** Testing tools: as a build's. */
  delayMs?: number;
  fail?: "throw" | "hang";
}

export type MeshMessage = MeshRequest | MeshRelease | TintRequest | MarkRequest;

export type MeshReply =
  /** Built; `ms` is the build's own time, measured in the worker. */
  | { t: "mesh"; id: number; mesh: MeshOut; ms: number }
  /** The grey sheet, cut; `ms` is the cut's own time. */
  | {
      t: "tint";
      id: number;
      positions: Float32Array<ArrayBuffer>;
      origin: [number, number];
      ms: number;
    }
  /** A pending mark's line and fill (`built` null: nothing built — a
   *  geometry with no segment, a throw, a mark superseded while queued);
   *  `ms` is the build's own time. */
  | {
      t: "mark";
      id: number;
      built: { regime: MarkRegime; line: MarkLine; fill: MarkFill; ms: number } | null;
    }
  /** Tokens the store does not hold: nothing built. */
  | { t: "missing"; id: number; tokens: number[] }
  /** Superseded while queued: nothing built. */
  | { t: "skipped"; id: number }
  /** The build threw. */
  | { t: "error"; id: number; message: string };

type Feature = OutlineFC["features"][number];

export interface MeshCoreDeps {
  /** Hands a reply to the page (the worker posts it, its buffers transferred). */
  post(reply: MeshReply): void;
  /** Runs `fn` in a later task, after `ms`. */
  schedule(fn: () => void, ms: number): void;
}

export function createMeshCore(deps: MeshCoreDeps) {
  const store = new Map<number, { geom: Geom; vertices: number }>();
  let vertices = 0;
  const queue: { req: MeshRequest | TintRequest | MarkRequest; superseded: boolean }[] = [];
  let armed = false;

  function put(token: number, flat: FlatGeom) {
    const prev = store.get(token);
    if (prev) vertices -= prev.vertices;
    const n = flatVertices(flat);
    store.set(token, { geom: unflatten(flat), vertices: n });
    vertices += n;
  }

  function release(tokens: readonly number[]) {
    for (const t of tokens) {
      const e = store.get(t);
      if (!e) continue;
      vertices -= e.vertices;
      store.delete(t);
    }
  }

  /** A set's features: a fresh wrapper each (the builder reads only the
   *  geometry, `properties.id` and `properties.level`), the stored geometry
   *  object in it. Unknown tokens are collected in `missing`. */
  function featuresOf(set: MeshSet, missing: number[]): Feature[] {
    return set.meta.map((m, i) => {
      let geometry: Geom | null = null;
      if (m.hasGeom) {
        const token = set.tokens[i];
        const e = token === null ? undefined : store.get(token);
        if (e) geometry = e.geom;
        else missing.push(token ?? -1);
      }
      return { type: "Feature", properties: { id: m.id, level: m.level }, geometry };
    });
  }

  /** One request built now: its puts stored, then the mesh, or `missing`. */
  function build(req: MeshRequest): Extract<MeshReply, { t: "mesh" | "missing" }> {
    for (const p of req.puts) put(p.token, p.flat);
    return make(req);
  }

  /** A request's mesh from the store as it stands, or `missing`. */
  function make(req: MeshRequest): Extract<MeshReply, { t: "mesh" | "missing" }> {
    const missing: number[] = [];
    const scope = featuresOf(req.scope, missing);
    const focus = featuresOf(req.focus, missing);
    const context = featuresOf(req.context, missing);
    if (missing.length) return { t: "missing", id: req.id, tokens: [...new Set(missing)] };
    const want = {
      merc: req.want.merc,
      globe: req.want.globe,
      lean: req.want.lean === true,
    };
    const t0 = performance.now();
    const mesh = buildPlateauMesh(scope, req.heightM, focus, context, want);
    for (let k = 1; k < (req.slow ?? 1); k++) {
      buildPlateauMesh(scope, req.heightM, focus, context, want);
    }
    return { t: "mesh", id: req.id, mesh, ms: performance.now() - t0 };
  }

  /** A tint request's sheet from the store as it stands, or `missing`. */
  function makeTint(req: TintRequest): Extract<MeshReply, { t: "tint" | "missing" }> {
    const missing: number[] = [];
    const scope = featuresOf(req.scope, missing);
    if (missing.length) return { t: "missing", id: req.id, tokens: [...new Set(missing)] };
    const t0 = performance.now();
    const geoms = scope.flatMap((f) => (f.geometry ? [f.geometry as Geom] : []));
    const { positions, origin } = cutTintSheet(geoms);
    return { t: "tint", id: req.id, positions, origin, ms: performance.now() - t0 };
  }

  /** A mark request's meshes from the store as it stands, or `missing`. */
  function makeMark(req: MarkRequest): Extract<MeshReply, { t: "mark" | "missing" }> {
    const missing: number[] = [];
    const scope = featuresOf(req.scope, missing);
    if (missing.length) return { t: "missing", id: req.id, tokens: [...new Set(missing)] };
    const g = scope.find((f) => f.geometry)?.geometry as Geom | undefined;
    const t0 = performance.now();
    const built = g ? buildMark(g, req.regime) : null;
    return {
      t: "mark",
      id: req.id,
      built: built ? { regime: req.regime, ...built, ms: performance.now() - t0 } : null,
    };
  }

  function arm() {
    if (armed || !queue.length) return;
    armed = true;
    deps.schedule(pump, 0);
  }

  /** The queue's head: the superseded ones answered, then one request — a
   *  tint, or the tap's own mark, before the builds queued ahead of it. */
  function pump() {
    armed = false;
    while (queue[0]?.superseded) {
      const { req } = queue.shift()!;
      deps.post(
        req.t === "mark" ? { t: "mark", id: req.id, built: null } : { t: "skipped", id: req.id },
      );
    }
    const ahead = queue.findIndex(
      (q) => !q.superseded && (q.req.t === "tint" || (q.req.t === "mark" && q.req.front)),
    );
    const next = ahead > 0 ? queue.splice(ahead, 1)[0] : queue.shift();
    if (next) run(next.req);
    arm();
  }

  function run(req: MeshRequest | TintRequest | MarkRequest) {
    let reply: MeshReply;
    try {
      if (req.fail === "throw") throw new Error("__acMeshFail");
      reply = req.t === "tint" ? makeTint(req) : req.t === "mark" ? makeMark(req) : make(req);
    } catch (err) {
      // A mark that throws is only not built: the worker goes on.
      reply =
        req.t === "mark"
          ? { t: "mark", id: req.id, built: null }
          : { t: "error", id: req.id, message: String((err as Error)?.message ?? err) };
    }
    if (req.fail === "hang") return;
    if (req.delayMs && req.delayMs > 0) deps.schedule(() => deps.post(reply), req.delayMs);
    else deps.post(reply);
  }

  /** A message from the page. */
  function receive(msg: MeshMessage) {
    if (msg.t === "release") {
      release(msg.tokens);
      return;
    }
    // Stored at once, a request skipped later included: the page counts them sent.
    for (const p of msg.puts) put(p.token, p.flat);
    // A newer tint has no use for the tints queued, a superseding build for
    // the builds queued, a newer tap's mark for the marks queued; none
    // touches another kind.
    if (msg.t === "tint" || (msg.t === "mark" ? msg.front : msg.supersede)) {
      for (const q of queue) if (q.req.t === msg.t) q.superseded = true;
    }
    queue.push({ req: msg, superseded: false });
    arm();
  }

  return {
    put,
    release,
    build,
    receive,
    /** The tokens held, and their vertices. */
    held: () => ({ tokens: store.size, vertices }),
    /** The object stored under `token` (tests: identity across requests). */
    geometryOf: (token: number) => store.get(token)?.geom,
  };
}
