// The page's side of the mesh worker (ac:mesh=worker, gl/meshClient.ts): what
// was sent, what is asked, what came back. The worker is reached through an
// injected transport, so the node tests drive this with a fake one.
//
// - Tokens. A geometry object travels once, flattened (meshFlat.ts) with its
//   buffers transferred, under a token (`WeakMap<geometry, token>`); later
//   requests name the token. The live table is what the worker holds: a
//   token gone from it (released, or lost with a worker) is "unsent", and its
//   geometry goes again under a new token.
// - Eviction is the page's: past `capVertices` (MESH_TOKEN_CAP_VERTICES, about
//   100 MB of worker heap at 250-350 B a vertex), the least recently used
//   tokens that are not pinned — named by a request in flight or by the last
//   applied one (its globe set follows) — are released, in the same tick. A
//   request naming a token the worker lacks anyway is answered `missing`: its
//   geometries go again once, a second miss builds it here (`fallbackBuild`).
// - Single flight. A build asking exactly what one in flight asks (the same
//   tokens and features in order, the same height, the same sets) gets that
//   one's promise; nothing is kept once it is answered: a later identical
//   call builds again.
// - Superseding. A new build (not joined, not a globe follow-up) supersedes
//   every request before it: the worker skips those it has not started, which
//   resolve null; one started finishes and resolves (the caller's run counter
//   drops it). Request ids are this module's bookkeeping only.
// - Settlement. `build()` never rejects: it resolves the mesh, or null when
//   superseded or disposed. A geometry the flattening cannot read is built
//   here (null if the builder cannot read it either). The worker's `error` or `messageerror`, an `error`
//   reply, or no reply MESH_WATCHDOG_MS after a request (re-armed whenever
//   the worker answers another one, and one more task when due, so replies
//   a busy page left queued get their turn) end the worker for the
//   session: every pending request is built here, the worker is terminated,
//   its late replies ignored, and every later build runs here at once.
// - The grey sheet (ac:tint-cut, gl/tintSheet.ts). `cutTint()` asks the
//   worker for the flat view's grey cut around a selection: its geometries
//   travel under the same tokens as a build's, pinned while it is in flight
//   and watched by the same watchdog. It supersedes the cuts before it and
//   no build, and no build supersedes it. It never rejects and is never cut
//   here: it resolves null — superseded, a second miss, the worker lost,
//   disposed — and the caller cuts the sheet itself if it still wants it.

import type { OutlineFC } from "../types";
import type { MeshOut } from "./meshBuild";
import type {
  MeshMessage,
  MeshPut,
  MeshReply,
  MeshRequest,
  MeshSet,
  MeshWant,
  TintRequest,
} from "./meshCore";
import { flatBuffers, flatVertices, flatten, type Geom } from "./meshFlat";
import type { TintSheet } from "./tintSheet";

/** The vertices the worker may hold before the page releases some. */
export const MESH_TOKEN_CAP_VERTICES = 300_000;
/** A request unanswered this long: the worker is lost (ms). */
export const MESH_WATCHDOG_MS = 3000;

type Features = OutlineFC["features"];

/** What a mesh is built from, as the page holds it. */
export interface MeshInputs {
  features: Features;
  heightM: number;
  focus: Features;
  context: Features;
}

/** A built mesh: by the worker, or here; `ms` the build's own time. */
export interface MeshResult {
  mesh: MeshOut;
  via: "worker" | "main";
  ms: number;
  id: number;
  /** The tokens it was built from (pinned once it is applied). */
  tokens: readonly number[];
}

/** A grey sheet the worker cut; `ms` the cut's own time. */
export type TintResult = TintSheet & { ms: number };

/** What the client needs of a worker. */
export interface MeshTransport {
  post(msg: MeshMessage, transfer: Transferable[]): void;
  terminate(): void;
}

export interface MeshClientDeps {
  /** The worker, wired to the two handlers. May throw (no module workers):
   *  the session then builds here. */
  transport(on: { reply(m: MeshReply): void; fail(why: string): void }): MeshTransport;
  now(): number;
  /** Runs `fn` after `ms`; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** The same mesh, built here (gl/meshBuild.ts). */
  fallbackBuild(inputs: MeshInputs, want: MeshWant): MeshOut;
  /** Read at every request (the testing tools' override). */
  capVertices?: () => number;
  /** The testing tools' worker knobs, read at every request. */
  knobs?: () => Pick<MeshRequest, "delayMs" | "slow" | "fail">;
  /** Probes: a reply's round trip (request posted → reply received, here),
   *  the build's own time (the worker's), and a grey sheet's round trip. */
  trace?: {
    tintRoundTrip?(ms: number, detail: { puts: number; cloneMs: number }): void;
    roundTrip?(
      ms: number,
      detail: { scope: string; first: boolean; puts: number; cloneMs: number },
    ): void;
    meshBuild?(
      ms: number,
      detail: { scope: string; part: "merc" | "globe" | "both"; cold: boolean },
    ): void;
  };
}

type Pending = {
  id: number;
  globe: boolean;
  inputs: MeshInputs;
  want: MeshWant;
  key: string | null;
  tokens: number[];
  superseded: boolean;
  resent: boolean;
  first: boolean;
  puts: number;
  cloneMs: number;
  postedAt: number;
  cancelWatch: (() => void) | null;
  resolve: (r: MeshResult | null) => void;
  promise: Promise<MeshResult | null>;
};

/** A grey sheet's cut in flight. */
type PendingTint = {
  id: number;
  geoms: readonly Geom[];
  tokens: number[];
  superseded: boolean;
  resent: boolean;
  puts: number;
  cloneMs: number;
  postedAt: number;
  cancelWatch: (() => void) | null;
  resolve: (r: TintResult | null) => void;
};

function metaOf(f: Features[number]) {
  const g = f.geometry as Geom | null | undefined;
  return {
    id: String(f.properties?.id ?? ""),
    level: String(f.properties?.level ?? ""),
    hasGeom: !!g?.type,
  };
}

export function createMeshClient(deps: MeshClientDeps) {
  let mode: "worker" | "main" = "worker";
  let failure: string | null = null;
  let disposed = false;
  let transport: MeshTransport | null = null;
  let tokenOf = new WeakMap<object, number>();
  // The worker's store as the page sees it, least recently used first.
  const live = new Map<number, number>();
  let liveVertices = 0;
  let nextToken = 1;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const tints = new Map<number, PendingTint>();
  const inflight = new Map<string, Pending>();
  let lastApplied: readonly number[] = [];
  // Resolved with a mesh, not applied (yet): dropped once a later one is.
  const unapplied = new Set<number>();
  const zero = () => ({
    started: 0,
    deduped: 0,
    built: 0,
    droppedBeforeStart: 0,
    dropped: 0,
    applied: 0,
    misses: 0,
    resends: 0,
    evicted: 0,
    roundTripMax: 0,
    fallbacks: 0,
    tints: 0,
    tintsCut: 0,
  });
  let n = zero();

  try {
    transport = deps.transport({ reply: onReply, fail });
  } catch {
    mode = "main";
    failure = "constructor";
  }

  /** A feature list as tokens and meta. `alloc`: tokens given and puts made
   *  for the geometries the worker lacks; without it, null if any lacks one. */
  function setOf(fs: Features, alloc: { puts: MeshPut[]; used: Set<number> } | null) {
    const set: MeshSet = { tokens: [], meta: [] };
    for (const f of fs) {
      const m = metaOf(f);
      set.meta.push(m);
      if (!m.hasGeom) {
        set.tokens.push(null);
        continue;
      }
      const g = f.geometry as object;
      let tok = tokenOf.get(g);
      const vertices = tok === undefined ? undefined : live.get(tok);
      if (tok === undefined || vertices === undefined) {
        if (!alloc) return null;
        const flat = flatten(g as Geom)!;
        tok = nextToken++;
        tokenOf.set(g, tok);
        live.set(tok, flatVertices(flat));
        liveVertices += flatVertices(flat);
        alloc.puts.push({ token: tok, flat });
      } else if (alloc && !alloc.used.has(tok)) {
        // Most recently used: to the end of the table.
        live.delete(tok);
        live.set(tok, vertices);
      }
      alloc?.used.add(tok);
      set.tokens.push(tok);
    }
    return set;
  }

  const keyOf = (want: MeshWant, heightM: number, sets: MeshSet[]) =>
    JSON.stringify([
      want.merc,
      want.globe,
      heightM,
      sets.map((s) => s.meta.map((m, i) => [s.tokens[i], m.id, m.level])),
    ]);

  function pinned(extra: Iterable<number>) {
    const out = new Set<number>(lastApplied);
    for (const p of pending.values()) for (const t of p.tokens) out.add(t);
    for (const p of tints.values()) for (const t of p.tokens) out.add(t);
    for (const t of extra) out.add(t);
    return out;
  }

  function evict(used: Set<number>) {
    const cap = deps.capVertices?.() ?? MESH_TOKEN_CAP_VERTICES;
    if (liveVertices <= cap) return;
    const keep = pinned(used);
    const out: number[] = [];
    for (const [tok, vertices] of live) {
      if (liveVertices <= cap) break;
      if (keep.has(tok)) continue;
      live.delete(tok);
      liveVertices -= vertices;
      out.push(tok);
    }
    if (!out.length) return;
    n.evicted += out.length;
    transport?.post({ t: "release", tokens: out }, []);
  }

  function forget(tokens: readonly number[]) {
    for (const t of tokens) {
      const vertices = live.get(t);
      if (vertices === undefined) continue;
      live.delete(t);
      liveVertices -= vertices;
    }
  }

  function settle(p: Pending) {
    p.cancelWatch?.();
    p.cancelWatch = null;
    pending.delete(p.id);
    if (p.key !== null && inflight.get(p.key) === p) inflight.delete(p.key);
  }

  /** Built here: the fallback, and every build once the worker is lost. */
  function onMain(inputs: MeshInputs, want: MeshWant, globe: boolean, id = nextId++) {
    const t0 = deps.now();
    let mesh: MeshOut;
    try {
      mesh = deps.fallbackBuild(inputs, want);
    } catch {
      return null;
    }
    n.fallbacks++;
    if (!globe) unapplied.add(id);
    return { mesh, via: "main" as const, ms: deps.now() - t0, id, tokens: [] };
  }

  /** `p` posted (again, after a miss: its new geometries under new tokens). */
  function send(p: Pending, supersede: boolean) {
    const t0 = deps.now();
    const alloc = { puts: [] as MeshPut[], used: new Set<number>() };
    const { features, heightM, focus, context } = p.inputs;
    let sets: MeshSet[];
    try {
      sets = [features, focus, context].map((fs) => setOf(fs, alloc)!);
    } catch {
      // A geometry the flattening cannot read: nothing posted, the tokens it
      // gave unsent again; built here (null if the builder cannot either).
      forget(alloc.puts.map((x) => x.token));
      settle(p);
      return p.resolve(onMain(p.inputs, p.want, p.globe, p.id));
    }
    p.tokens = [...alloc.used];
    if (!p.resent) {
      p.key = keyOf(p.want, heightM, sets);
      inflight.set(p.key, p);
    }
    evict(alloc.used);
    const req: MeshRequest = {
      t: "build",
      id: p.id,
      want: p.want,
      heightM,
      scope: sets[0],
      focus: sets[1],
      context: sets[2],
      puts: alloc.puts,
      supersede,
      ...deps.knobs?.(),
    };
    try {
      transport!.post(
        req,
        alloc.puts.flatMap((x) => flatBuffers(x.flat)),
      );
    } catch {
      fail("post");
      return;
    }
    p.puts = alloc.puts.length;
    p.postedAt = deps.now();
    p.cloneMs = p.postedAt - t0;
    watch(p);
  }

  function watch(p: Pending | PendingTint) {
    p.cancelWatch?.();
    p.cancelWatch = deps.schedule(() => {
      // Due, maybe late on a busy page: one more task first.
      p.cancelWatch = deps.schedule(() => fail("timeout"), 0);
    }, MESH_WATCHDOG_MS);
  }

  function onReply(m: MeshReply) {
    if (disposed || mode !== "worker") return;
    // The worker lives: the requests queued behind this one get their full time.
    for (const q of pending.values()) if (q.id !== m.id) watch(q);
    for (const q of tints.values()) if (q.id !== m.id) watch(q);
    const tint = tints.get(m.id);
    if (tint) return onTintReply(tint, m);
    const p = pending.get(m.id);
    if (!p || m.t === "tint") return;
    if (m.t === "error") return fail("error");
    if (m.t === "skipped") {
      settle(p);
      n.droppedBeforeStart++;
      return p.resolve(null);
    }
    if (m.t === "missing") {
      n.misses++;
      forget(m.tokens);
      if (p.superseded) {
        // An older run's: not sent again, nobody would apply it.
        settle(p);
        n.droppedBeforeStart++;
        return p.resolve(null);
      }
      if (!p.resent) {
        p.resent = true;
        n.resends++;
        if (p.key !== null && inflight.get(p.key) === p) inflight.delete(p.key);
        return send(p, false);
      }
      settle(p);
      return p.resolve(onMain(p.inputs, p.want, p.globe, p.id));
    }
    settle(p);
    n.built++;
    const rt = deps.now() - p.postedAt;
    if (rt > n.roundTripMax) n.roundTripMax = rt;
    const scope = String(p.inputs.features[0]?.properties?.id ?? "");
    deps.trace?.roundTrip?.(rt, { scope, first: p.first, puts: p.puts, cloneMs: p.cloneMs });
    const part = p.want.merc && p.want.globe ? "both" : p.want.merc ? "merc" : "globe";
    deps.trace?.meshBuild?.(m.ms, { scope, part, cold: p.puts > 0 });
    if (!p.globe) unapplied.add(p.id);
    p.resolve({ mesh: m.mesh, via: "worker", ms: m.ms, id: p.id, tokens: p.tokens });
  }

  /** `p` posted (again, after a miss: its geometries under new tokens). */
  function sendTint(p: PendingTint) {
    const t0 = deps.now();
    const alloc = { puts: [] as MeshPut[], used: new Set<number>() };
    const features = p.geoms.map((geometry) => ({ type: "Feature", properties: {}, geometry }));
    let scope: MeshSet;
    try {
      scope = setOf(features as unknown as Features, alloc)!;
    } catch {
      // A geometry the flattening cannot read: nothing posted.
      forget(alloc.puts.map((x) => x.token));
      settleTint(p);
      return p.resolve(null);
    }
    p.tokens = [...alloc.used];
    evict(alloc.used);
    const knobs = deps.knobs?.();
    const req: TintRequest = {
      t: "tint",
      id: p.id,
      scope,
      puts: alloc.puts,
      delayMs: knobs?.delayMs,
      fail: knobs?.fail,
    };
    try {
      transport!.post(
        req,
        alloc.puts.flatMap((x) => flatBuffers(x.flat)),
      );
    } catch {
      fail("post");
      return;
    }
    p.puts = alloc.puts.length;
    p.postedAt = deps.now();
    p.cloneMs = p.postedAt - t0;
    watch(p);
  }

  function settleTint(p: PendingTint) {
    p.cancelWatch?.();
    p.cancelWatch = null;
    tints.delete(p.id);
  }

  function onTintReply(p: PendingTint, m: MeshReply) {
    if (m.t === "error") return fail("error");
    if (m.t === "missing") {
      n.misses++;
      forget(m.tokens);
      if (!p.superseded && !p.resent) {
        p.resent = true;
        n.resends++;
        return sendTint(p);
      }
    }
    settleTint(p);
    if (m.t !== "tint") return p.resolve(null);
    n.tintsCut++;
    deps.trace?.tintRoundTrip?.(deps.now() - p.postedAt, { puts: p.puts, cloneMs: p.cloneMs });
    p.resolve({ positions: m.positions, origin: m.origin, ms: m.ms });
  }

  /** The grey sheet around `geoms`, asked of the worker. */
  function requestTint(geoms: readonly Geom[]): Promise<TintResult | null> {
    if (disposed || mode === "main") return Promise.resolve(null);
    // The cuts before it are another selection's.
    for (const q of tints.values()) q.superseded = true;
    let resolve!: (r: TintResult | null) => void;
    const promise = new Promise<TintResult | null>((r) => (resolve = r));
    const p: PendingTint = {
      id: nextId++,
      geoms,
      tokens: [],
      superseded: false,
      resent: false,
      puts: 0,
      cloneMs: 0,
      postedAt: 0,
      cancelWatch: null,
      resolve,
    };
    tints.set(p.id, p);
    n.tints++;
    sendTint(p);
    return promise;
  }

  /** The worker lost for the session: every pending request built here. */
  function fail(why: string) {
    if (disposed || mode !== "worker") return;
    mode = "main";
    failure = why;
    try {
      transport?.terminate();
    } catch {
      /* already gone */
    }
    transport = null;
    const list = [...pending.values()];
    pending.clear();
    inflight.clear();
    live.clear();
    liveVertices = 0;
    tokenOf = new WeakMap();
    // The cuts in flight first: their callers cut here, at once.
    for (const p of [...tints.values()]) {
      settleTint(p);
      p.resolve(null);
    }
    for (const p of list) {
      p.cancelWatch?.();
      p.resolve(p.superseded ? null : onMain(p.inputs, p.want, p.globe, p.id));
    }
  }

  function request(inputs: MeshInputs, want: MeshWant, globe: boolean): Promise<MeshResult | null> {
    if (disposed) return Promise.resolve(null);
    if (mode === "main") return Promise.resolve(onMain(inputs, want, globe));
    const { features, heightM, focus, context } = inputs;
    const dry = [features, focus, context].map((fs) => setOf(fs, null));
    if (dry.every((s) => s !== null)) {
      const joined = inflight.get(keyOf(want, heightM, dry as MeshSet[]));
      if (joined && !joined.superseded) {
        n.deduped++;
        return joined.promise;
      }
    }
    // A new build: whatever is pending is an older run's (a globe follow-up
    // supersedes nothing; the grey's cuts are not builds).
    if (!globe) {
      for (const q of pending.values()) {
        q.superseded = true;
        if (q.key !== null && inflight.get(q.key) === q) inflight.delete(q.key);
      }
    }
    let resolve!: (r: MeshResult | null) => void;
    const promise = new Promise<MeshResult | null>((r) => (resolve = r));
    const id = nextId++;
    const p: Pending = {
      id,
      globe,
      inputs,
      want,
      key: null,
      tokens: [],
      superseded: false,
      resent: false,
      first: id === 1,
      puts: 0,
      cloneMs: 0,
      postedAt: 0,
      cancelWatch: null,
      resolve,
      promise,
    };
    pending.set(p.id, p);
    n.started++;
    send(p, !globe);
    return promise;
  }

  return {
    /** The mesh of `inputs`: the sets `want` names. Never rejects. */
    build: (inputs: MeshInputs, want: MeshWant) => request(inputs, want, false),
    /** The globe set alone of a mesh already applied (its deferred pass). */
    buildGlobe: (inputs: MeshInputs) => request(inputs, { merc: false, globe: true }, true),
    /** The flat view's grey sheet cut around `geoms`. Never rejects; null:
     *  no sheet from the worker (the caller cuts it). */
    cutTint: (geoms: readonly Geom[]) => requestTint(geoms),
    /** `r` is drawn: its tokens stay pinned until the next one is. */
    applied(r: MeshResult) {
      n.applied++;
      lastApplied = r.tokens;
      for (const id of unapplied) {
        if (id >= r.id) continue;
        n.dropped++;
        unapplied.delete(id);
      }
      unapplied.delete(r.id);
    },
    /** The worker terminated, every pending build resolved null, all state
     *  dropped; any later reply is ignored and any later build resolves null. */
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        transport?.terminate();
      } catch {
        /* already gone */
      }
      transport = null;
      for (const p of pending.values()) {
        p.cancelWatch?.();
        p.resolve(null);
      }
      for (const p of [...tints.values()]) {
        settleTint(p);
        p.resolve(null);
      }
      pending.clear();
      inflight.clear();
      live.clear();
      liveVertices = 0;
      tokenOf = new WeakMap();
      lastApplied = [];
      unapplied.clear();
    },
    get mode() {
      return mode;
    },
    stats() {
      let pinnedVertices = 0;
      for (const t of pinned([])) pinnedVertices += live.get(t) ?? 0;
      return {
        mode,
        failure,
        ...n,
        dropped: n.dropped + unapplied.size,
        liveTokens: live.size,
        liveVertices,
        pinnedVertices,
      };
    },
    /** The counters back to 0 (the state kept). */
    reset() {
      n = zero();
      unapplied.clear();
    },
  };
}

export type MeshClient = ReturnType<typeof createMeshClient>;
