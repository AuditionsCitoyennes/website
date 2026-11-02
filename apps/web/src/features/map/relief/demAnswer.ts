// The client relief's answer policy: what the page hands Mapbox for each
// `ac-dem://<key>/z/x/y` request. Pure: the worker, the main-thread renderer,
// the clock and the frame budget come in through a port, so every rule below
// is tested without a Worker (demAnswer.test.ts).
//
// Selections: `registerSelection(features, height)` replaces POST /api/dem.
// The key is the server's (the worker computes it); the record keeps the FIRST
// registered height, unrounded, as the server's store does. Memoised on every
// feature's geometry object (nested WeakMaps, freed with the geometry) and the
// rounded height, single-flight, never cancelled by a superseded run. A slot
// holds its key (`holdSlot`): held records never leave the 40-entry LRU.
//
// One request, in order:
//   - not our template                     -> ground, not cached (malformed)
//   - cached                               -> that answer
//   - no record for the key                -> ground, not cached (orphan: must stay 0)
//   - the tile's box + PAD misses the box  -> ground, cached; never a worker trip
//   - else the worker renders it, after the record's `set` settled; aborted
//     before posting -> ground, not cached. `unknown` (the worker lost the key)
//     -> the `set` again with the first height, awaited, then the tile once
//     more. Still no tile -> the main-thread renderer once (not cached); that
//     failing too -> ground, not cached, `onClientLost`. Ground answers a
//     tile that touches the selection only on that last line.
// Every request resolves exactly once and nothing rejects: a hung promise
// keeps the source loading. Answers go back through the frame budget.
//
// `failover()` (the worker died or never started) answers every pending call
// on the main thread, then everything stays there for the session.

import {
  MAX_SELECTION_VERTICES,
  SelectionTooLarge,
  keyJson,
  polysOf,
  tileTouches,
  vertexCount,
} from "./demGeometry";
import { TileCache, parseDemUrl, type DemTileId, type FrameBudget } from "./demTiles";
import type { DemJob, DemReply, DemSetJob, DemTileJob } from "./demWorkerCore";

export type Bbox = [number, number, number, number];

export interface DemRecord {
  key: string;
  json: string;
  /** The first registered height, unrounded. */
  height: number;
  bbox: Bbox;
  vertices: number;
  /** Settles (never rejects) once the worker holds the key again. */
  setP: Promise<void>;
  /** Bumped by every re-sent `set`: one re-send per loss, however many tiles saw it. */
  gen: number;
}

export interface DemAnswerPort {
  post(msg: DemJob): void;
  /** The 0 m tile (GROUND_DATA_URL). */
  ground: string;
  mainSet?(json: string, height: number): Promise<{ key: string; bbox: Bbox; vertices: number }>;
  mainRender?(rec: DemRecord, z: number, x: number, y: number): Promise<string>;
  now(): number;
  budget: FrameBudget;
  /** The `ac:relief-delay` arm: ms waited before each answer. */
  delayMs?: number;
  /** Count (TEST_TOOLS): otherwise no counter is touched. */
  stats?: boolean;
  /** Both renderers failed a tile: the shell demotes the route. */
  onClientLost?(): void;
}

type Feature = { geometry?: unknown; type?: string; coordinates?: unknown };
type Unsent = Omit<DemSetJob, "id"> | Omit<DemTileJob, "id">;
interface MemoNode {
  next: WeakMap<object, MemoNode>;
  leaf?: Map<number, Promise<DemRecord>>;
}

export const MAX_RECORDS = 40;

function freshStats() {
  return {
    calls: 0,
    cached: 0,
    ground: 0,
    rasterised: 0,
    byZ: {} as Record<string, number>,
    orphan: 0,
    malformed: 0,
    late: 0,
    failedRender: 0,
    mainMs: 0,
    mainMax: 0,
    workerMs: 0,
    workerMax: 0,
    roundTripMax: 0,
    budgetWaitMax: 0,
    stringifyMs: 0,
    setMs: 0,
    registers: 0,
    registerHits: 0,
  };
}
export type DemStats = ReturnType<typeof freshStats>;

export function createDemAnswer(port: DemAnswerPort) {
  const now = () => port.now();
  let st = port.stats ? freshStats() : null;
  let mode: "worker" | "main" = "worker";
  let nextId = 1;
  const pending = new Map<
    number,
    { msg: DemJob; rec?: DemRecord; settle: (r: DemReply) => void }
  >();
  const cache = new TileCache();
  const records = new Map<string, DemRecord>();
  const slots = new Map<string, string>();
  const memo: MemoNode = { next: new WeakMap() };

  async function mainCall(msg: DemJob, rec?: DemRecord): Promise<DemReply> {
    try {
      if (msg.t === "set") {
        if (!port.mainSet) throw new Error("no main-thread renderer");
        return { id: msg.id, ...(await port.mainSet(msg.json, msg.height)) };
      }
      if (!rec || !port.mainRender) throw new Error("no main-thread renderer");
      return { id: msg.id, url: await port.mainRender(rec, msg.z, msg.x, msg.y), kind: "raster" };
    } catch (e) {
      return { id: msg.id, error: String(e) };
    }
  }

  function call(m: Unsent, rec?: DemRecord): Promise<DemReply> {
    const msg = { ...m, id: nextId++ } as DemJob;
    if (mode === "main") return mainCall(msg, rec);
    return new Promise((settle) => {
      pending.set(msg.id, { msg, rec, settle });
      try {
        port.post(msg);
      } catch (e) {
        pending.delete(msg.id);
        settle({ id: msg.id, error: String(e) });
      }
    });
  }

  function remember(rec: DemRecord): void {
    records.delete(rec.key);
    records.set(rec.key, rec);
    const held = new Set(slots.values());
    for (const k of records.keys()) {
      if (records.size <= MAX_RECORDS) break;
      if (k !== rec.key && !held.has(k)) records.delete(k);
    }
  }

  async function sendSet(json: string, height: number) {
    const t0 = now();
    const r = await call({ t: "set", json, height, pins: [...new Set(slots.values())] });
    if (st) st.setMs += now() - t0;
    if (r.error || !r.key || !r.bbox) throw new Error(r.error ?? "dem set: no key");
    return { key: r.key, bbox: r.bbox, vertices: r.vertices ?? 0 };
  }

  function resend(rec: DemRecord): void {
    rec.gen++;
    rec.setP = sendSet(rec.json, rec.height).then(
      () => undefined,
      () => undefined,
    );
  }

  function registerSelection(
    features: readonly Feature[],
    height: number,
  ): Promise<{ key: string }> {
    if (st) st.registers++;
    let node = memo;
    for (const f of features) {
      const g = f.geometry && typeof f.geometry === "object" ? f.geometry : f;
      let n = node.next.get(g);
      if (!n) node.next.set(g, (n = { next: new WeakMap() }));
      node = n;
    }
    const leaf = (node.leaf ??= new Map<number, Promise<DemRecord>>());
    const h = Math.round(height);
    let p = leaf.get(h);
    if (p) {
      if (st) st.registerHits++;
    } else {
      p = (async () => {
        const polys = polysOf(features);
        const vertices = vertexCount(polys);
        if (vertices > MAX_SELECTION_VERTICES) throw new SelectionTooLarge(vertices);
        const t0 = now();
        const json = keyJson(polys, height);
        if (st) st.stringifyMs += now() - t0;
        const r = await sendSet(json, height);
        // An equal selection from other geometry objects keeps the first record (and height).
        return records.get(r.key) ?? { ...r, json, height, setP: Promise.resolve(), gen: 0 };
      })();
      const mine = p;
      leaf.set(h, mine);
      mine.catch(() => {
        if (leaf.get(h) === mine) leaf.delete(h);
      });
    }
    return p.then((rec) => {
      remember(rec);
      return { key: rec.key };
    });
  }

  async function render(
    rec: DemRecord,
    { z, x, y }: DemTileId,
    signal?: AbortSignal,
  ): Promise<{ url: string; keep: boolean }> {
    try {
      await rec.setP;
      if (signal?.aborted) return { url: port.ground, keep: false };
      const gen = rec.gen;
      const t0 = now();
      let r = await call({ t: "tile", key: rec.key, z, x, y }, rec);
      if (r.kind === "unknown") {
        if (rec.gen === gen) resend(rec);
        await rec.setP;
        r = await call({ t: "tile", key: rec.key, z, x, y }, rec);
      }
      if (st && r.ms !== undefined) {
        st.workerMs += r.ms;
        st.workerMax = Math.max(st.workerMax, r.ms);
        st.roundTripMax = Math.max(st.roundTripMax, now() - t0);
      }
      if (r.url && r.kind !== "unknown") return { url: r.url, keep: true };
    } catch {
      // the main thread, below
    }
    try {
      if (port.mainRender) return { url: await port.mainRender(rec, z, x, y), keep: false };
    } catch {
      // ground, below
    }
    if (st) st.failedRender++;
    port.onClientLost?.();
    return { url: port.ground, keep: false };
  }

  async function deliver(p: Promise<string>, z: number): Promise<{ url: string }> {
    let url = port.ground;
    try {
      url = await p;
    } catch {
      // never: every path above resolves
    }
    if (port.delayMs) await new Promise((r) => setTimeout(r, port.delayMs));
    const t0 = now();
    await port.budget.release(z);
    if (st) st.budgetWaitMax = Math.max(st.budgetWaitMax, now() - t0);
    return { url };
  }

  function answer(url: string, opts?: { signal?: AbortSignal }): Promise<{ url: string }> {
    const t0 = now();
    if (st) st.calls++;
    const id = parseDemUrl(url);
    let p: Promise<string>;
    if (!id) {
      if (st) st.malformed++;
      p = Promise.resolve(port.ground);
    } else {
      if (st) st.byZ[id.z] = (st.byZ[id.z] ?? 0) + 1;
      const ck = `${id.key}/${id.z}/${id.x}/${id.y}`;
      const hit = cache.get(ck);
      const rec = records.get(id.key);
      if (hit) {
        if (st) st.cached++;
        p = hit;
      } else if (!rec) {
        if (st) st.orphan++;
        p = Promise.resolve(port.ground);
      } else if (!tileTouches(rec.bbox, id.z, id.x, id.y)) {
        if (st) st.ground++;
        p = Promise.resolve(port.ground);
        cache.set(ck, p);
      } else {
        if (st) st.rasterised++;
        const job: Promise<string> = render(rec, id, opts?.signal).then((r) => {
          if (!r.keep) cache.delete(ck, job);
          return r.url;
        });
        p = job;
        cache.set(ck, job);
      }
    }
    if (st) {
      const dt = now() - t0;
      st.mainMs += dt;
      st.mainMax = Math.max(st.mainMax, dt);
    }
    return deliver(p, id?.z ?? 0);
  }

  return {
    registerSelection,
    answer,
    /** A worker message (not `ready`): settles its call, or is dropped as late. */
    receive(r: DemReply): void {
      const p = pending.get(r.id);
      if (!p) {
        if (st) st.late++;
        return;
      }
      pending.delete(r.id);
      p.settle(r);
    },
    failover(): void {
      if (mode === "main") return;
      mode = "main";
      for (const [id, p] of pending) {
        pending.delete(id);
        void mainCall(p.msg, p.rec).then(p.settle);
      }
    },
    holdSlot(slotId: string, key: string): void {
      slots.set(slotId, key);
    },
    releaseSlot(slotId: string): void {
      slots.delete(slotId);
    },
    get mode() {
      return mode;
    },
    stats: (): DemStats | null => (st ? (JSON.parse(JSON.stringify(st)) as DemStats) : null),
    resetStats(): void {
      if (st) st = freshStats();
    },
    cacheSize: () => cache.size,
  };
}

export type DemAnswer = ReturnType<typeof createDemAnswer>;
